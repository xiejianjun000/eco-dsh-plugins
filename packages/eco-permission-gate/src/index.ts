/**
 * eco-permission-gate — dsh plugin: L1-L4 risk permission gate.
 *
 * Port of eco-agent's agent_core/permissions.py (source:
 * github.com/xiejianjun000/eco-agent, MIT).
 *
 * Risk levels (aligned with eco-agent PERMISSION.md):
 *   L1 READ         read-only queries           -> auto allow
 *   L2 WRITE_LOCAL  local safe-zone writes      -> auto allow
 *   L3 EXEC         command/code execution      -> whitelist allow, else per mode
 *   L4 EXTERNAL     external service writes     -> ask (default) or deny
 *
 * The gate hooks `tools/pre-execute`, decides allow/ask/deny, and forwards
 * denied attempts to ctx.ecoAudit when the eco-audit-chain plugin is loaded.
 *
 * Tool risk resolution: PERMISSION.md / config overrides > prefix map > L3 default.
 * mcp__{server}__{tool} remote tools always resolve to L3 (server is untrusted;
 * a write operation can masquerade as a query_* name) unless explicitly
 * overridden — same conservative rule as the original.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

declare module '@deepseek-ai/cordis' {
  interface Context {
    ecoAudit?: { recordDenied(tool: string, level: string, reason: string): void }
  }
}

export const name = 'eco-permission-gate'
// ecoAudit 为可选依赖：审计链插件加载后才可写拒绝事件；未加载时静默跳过
export const inject = ['tools', 'ecoAudit']

export const LEVEL_LABELS = { L1: 'READ', L2: 'WRITE_LOCAL', L3: 'EXEC', L4: 'EXTERNAL' } as const
export type RiskLevel = keyof typeof LEVEL_LABELS

const LEVELS: RiskLevel[] = ['L1', 'L2', 'L3', 'L4']

/** Default prefix -> risk map (order is priority, first match wins). */
const PREFIX_RISK: Array<[string[], RiskLevel]> = [
  // L3 — command/code execution
  [['execute_code', 'execute_', 'shell', 'exec_'], 'L3'],
  // L4 — external service writes (gov procedures / approvals / trading / device control / network writes)
  [['apply_', 'book_', 'submit_', 'register_', 'trade_', 'set_',
    'configure_', 'control_', 'dispatch_', 'handle_', 'initiate_',
    'manage_', 'input_', 'generate_approval_document',
    'apply_approval_digital_signature'], 'L4'],
  // L2 — local safe-zone writes
  [['workspace_', 'memory_', 'generate_', 'write_', 'save_'], 'L2'],
  // L1 — read-only queries / retrieval / analysis (wide fallback)
  [['query_', 'get_', 'search_', 'kb_', 'calculate_', 'predict_',
    'analyze_', 'detect_', 'vision_', 'ocr_', 'monitor_',
    'supervise_', 'track_', 'read_', 'list_'], 'L1'],
]

const DEFAULT_UNKNOWN_LEVEL: RiskLevel = 'L3' // unknown tools default to EXEC (conservative)

/** Default L3 command whitelist (aligned with PERMISSION.md allow_auto). */
const DEFAULT_L3_WHITELIST = [
  'python _scripts/lint.py',
  'python _scripts/quality_audit.py',
  'git ',
  'pip install ',
]

export const Config = Schema.object({
  mode: Schema.union(['auto', 'ask', 'deny']).default('ask')
    .description('L3 non-whitelist handling: auto=allow, ask=user approval, deny=reject'),
  l4Mode: Schema.union(['ask', 'deny']).default('ask')
    .description('L4 external-write handling: ask=user approval (default), deny=reject'),
  nonInteractive: Schema.boolean().default(false)
    .description('When true, treat every call as non-interactive: ask becomes deny'),
  riskOverrides: Schema.dict(String).default({})
    .description('Per-tool risk overrides, e.g. { "web_search": "L1" }'),
  l3Whitelist: Schema.array(String).default([])
    .description('Additional L3 command-prefix whitelist entries'),
  policyFile: Schema.string().default('')
    .description('Optional PERMISSION.md path; its tool_risk_overrides block is loaded'),
}).description('eco-permission-gate configuration')

export function apply(ctx: Context, config: ConfigType) {
  const overrides = resolveOverrides(config)

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const toolName = exec.name ?? 'unknown'
    const level = toolRiskLevel(toolName, overrides)

    if (level === 'L1' || level === 'L2') {
      return next() // auto allow
    }

    if (level === 'L3') {
      const cmd = extractCommand(exec)
      if (cmd && isWhitelisted(cmd, config)) {
        return next() // whitelist auto allow
      }
      if (config.mode === 'auto') return next()
      if (config.mode === 'ask' && !config.nonInteractive) {
        return { kind: 'ask', reason: `[eco-permission-gate L3/EXEC] ${toolName}${cmd ? `: ${cmd.slice(0, 80)}` : ''}` }
      }
      deny(ctx, toolName, level, `non-whitelisted L3 denied (mode=${config.mode})`)
      return { kind: 'deny', reason: `[eco-permission-gate L3/EXEC] ${toolName} denied by policy (mode=${config.mode}). Command: ${cmd.slice(0, 120) || '(none)'}` }
    }

    // L4 — external writes
    if (config.l4Mode === 'ask' && !config.nonInteractive) {
      return { kind: 'ask', reason: `[eco-permission-gate L4/EXTERNAL] ${toolName} calls external service / performs a write. Requires approval.` }
    }
    deny(ctx, toolName, level, `L4 denied (mode=${config.l4Mode})`)
    return { kind: 'deny', reason: `[eco-permission-gate L4/EXTERNAL] ${toolName} denied by policy (mode=${config.l4Mode}).` }
  })
}

/** Resolve risk level: overrides > prefix map > L3 default. */
export function toolRiskLevel(toolName: string, overrides: Record<string, string>): RiskLevel {
  if (toolName in overrides) {
    const lvl = overrides[toolName].toUpperCase()
    if ((LEVELS as string[]).includes(lvl)) return lvl as RiskLevel
  }
  for (const [prefixes, level] of PREFIX_RISK) {
    if (prefixes.some((p) => toolName.startsWith(p))) return level
  }
  return DEFAULT_UNKNOWN_LEVEL
}

function extractCommand(exec: ToolExecution): string {
  const args = (exec.arguments ?? {}) as Record<string, unknown>
  return String(args.command ?? args.code ?? args.script ?? '')
}

function isWhitelisted(cmd: string, config: ConfigType): boolean {
  const wl = [...DEFAULT_L3_WHITELIST, ...config.l3Whitelist]
  return wl.some((w) => {
    const prefix = w.trim()
    return prefix && cmd.startsWith(prefix)
  })
}

/** Load PERMISSION.md tool_risk_overrides block (no YAML dependency), then merge config. */
function resolveOverrides(config: ConfigType): Record<string, string> {
  const merged: Record<string, string> = { ...config.riskOverrides }
  const text = readPermissionMd(config.policyFile)
  if (!text) return merged
  // tool_risk_overrides:\n  - tool: xxx\n    level: Lx
  const re = /-\s*tool:\s*([A-Za-z0-9_]+)\s*\n\s*level:\s*(L[1-4])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    merged[m[1]] = m[2].toUpperCase()
  }
  return merged
}

function readPermissionMd(policyFile: string): string {
  const candidates: string[] = []
  if (policyFile) candidates.push(policyFile)
  const env = process.env.ECO_PROFILES_DIR
  if (env) candidates.push(join(env, 'eco-agent', 'PERMISSION.md'))
  candidates.push(join(homedir(), '.eco', 'profiles', 'eco-agent', 'PERMISSION.md'))
  for (const p of candidates) {
    if (p && existsSync(p)) {
      try { return readFileSync(p, 'utf8') } catch { /* try next */ }
    }
  }
  return ''
}

/** Forward a denied decision to the audit chain when eco-audit-chain is present. */
function deny(ctx: Context, tool: string, level: string, reason: string): void {
  try {
    ctx.ecoAudit?.recordDenied(tool, level, reason)
  } catch {
    // audit must never break the gate
  }
}

type ConfigType = {
  mode: 'auto' | 'ask' | 'deny'
  l4Mode: 'ask' | 'deny'
  nonInteractive: boolean
  riskOverrides: Record<string, string>
  l3Whitelist: string[]
  policyFile: string
}
