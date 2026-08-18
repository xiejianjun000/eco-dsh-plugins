/**
 * eco-dsh-plugins — dsh 运行时集成验证
 * 真实 cordis 运行时加载三个插件，走完整 tools 管线（pre-execute / execute / result），
 * 验证：权限闸门决策、审计链自动记录与防篡改、记忆树工具链、Obsidian 双向同步。
 * 在 GitHub Actions CI 中执行：npm run build 之后运行本脚本。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = dirname(fileURLToPath(import.meta.url)) // <repo>/scripts
const REPO = join(ROOT, '..')
const PKG = join(REPO, 'packages')

const require = createRequire(join(REPO, 'package.json'))
const { Context } = require('@deepseek-ai/cordis')
const ToolRegistry = require('@deepseek-ai/dsh-tools').default
const { defineTool } = require('@deepseek-ai/dsh-tools')
const SystemPrompt = require('@deepseek-ai/dsh-system-prompt').default
const loadPlugin = async (pkg) => {
  const mod = await import(join(PKG, pkg, 'lib', 'index.js'))
  return { name: mod.name, apply: mod.apply, inject: mod.inject, Config: mod.Config }
}
const gatePlugin = await loadPlugin('eco-permission-gate')
const auditPlugin = await loadPlugin('eco-audit-chain')
const memoryPlugin = await loadPlugin('eco-memory-tree')

let failed = 0
const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  if (!cond) failed++
}

// --- 隔离环境 ---
const base = mkdtempSync(join(tmpdir(), 'eco-runtime-'))
const auditDir = join(base, 'audit')
const storeFile = join(base, 'memory', 'tree.json')
const vault = join(base, 'vault')

const ctx = new Context()
await ctx.plugin(SystemPrompt, { persona: 'test' })
await ctx.plugin(ToolRegistry, { mode: 'native' })
await ctx.plugin(gatePlugin, {
  mode: 'deny',            // L3 非白名单直接拒绝
  l4Mode: 'ask',           // L4 需要审批
  nonInteractive: true,    // ask 无审批通道 -> 拒绝
  riskOverrides: {
    my_query_tool: 'L1',
    // eco 插件自带工具按风险分级放行（系统信任内部工具，读取 L1 / 写入 L2）
    eco_audit_verify: 'L1',
    eco_audit_stats: 'L1',
    eco_audit_query: 'L1',
    eco_memory_search: 'L1',
    eco_memory_add: 'L2',
    eco_memory_update: 'L2',
    eco_memory_delete: 'L2',
    eco_memory_stats: 'L1',
    eco_memory_sync: 'L2',
  },
})
await ctx.plugin(auditPlugin, { auditDir })
await ctx.plugin(memoryPlugin, { storeFile, obsidianVault: vault })

// --- 注册测试工具 ---
const toolDefs = {
  query_users: defineTool({
    name: 'query_users', description: 'read users', parameters: {},
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute() { return { users: 42 } },
  }),
  workspace_write: defineTool({
    name: 'workspace_write', description: 'write local', parameters: { content: { type: 'string' } },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(a) { return { written: a?.content ?? '' } },
  }),
  shell_exec: defineTool({
    name: 'shell_exec', description: 'run command', parameters: { command: { type: 'string' } },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(a) { return { ran: a?.command ?? '' } },
  }),
  apply_payment: defineTool({
    name: 'apply_payment', description: 'external write', parameters: { amount: { type: 'number' } },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute() { return { paid: true } },
  }),
}
for (const def of Object.values(toolDefs)) ctx.tools.register(def)

const call = (name, args = {}) => ctx.tools.execute({
  callId: `call_${Math.random().toString(36).slice(2, 10)}`,
  name,
  arguments: args,
  signal: new AbortController().signal,
})

// --- 1. 插件装配：工具注册 ---
const ecoTools = ['eco_audit_verify', 'eco_audit_stats', 'eco_audit_query',
  'eco_memory_add', 'eco_memory_search', 'eco_memory_update',
  'eco_memory_delete', 'eco_memory_stats', 'eco_memory_sync']
const registered = new Set(ctx.tools.schemas().map((s) => s.name))
check('插件装配: 9 个 eco 工具全部注册', ecoTools.every((t) => registered.has(t)),
  `missing=${ecoTools.filter((t) => !registered.has(t)).join(',') || 'none'}`)
check('服务注入: ctx.ecoAudit 与 ctx.ecoMemory 可用', !!ctx.ecoAudit && !!ctx.ecoMemory)

// --- 2. 权限闸门 ---
const rL1 = await call('query_users')
check('权限闸门: L1 只读自动放行', rL1.isError === false && rL1.value?.users === 42)

const rL2 = await call('workspace_write', { content: 'safe' })
check('权限闸门: L2 本地写自动放行', rL2.isError === false && rL2.value?.written === 'safe')

const rL3Deny = await call('shell_exec', { command: 'rm -rf /tmp/x' })
check('权限闸门: L3 非白名单拒绝', rL3Deny.isError === true && /denied/.test(rL3Deny.error?.message ?? rL3Deny.error?.reason ?? ''))

const rL4 = await call('apply_payment', { amount: 100 })
check('权限闸门: L4 外部写拒绝(无审批通道)', rL4.isError === true)

// --- 3. 审计链：自动记录 + 防篡改 ---
const rVerify1 = await call('eco_audit_verify')
check('审计链: 调用后自动记录(含放行/拒绝)', rVerify1.isError === false && rVerify1.value?.ok === true && rVerify1.value?.entries >= 4,
  `entries=${rVerify1.value?.entries}`)

const rStats = await call('eco_audit_stats')
const ops = rStats.value?.by_operation ?? {}
check('审计链: 按操作类型统计(含 tool_call deny)', ops.tool_call >= 4, `by_operation=${JSON.stringify(ops)}`)

const rQuery = await call('eco_audit_query', { limit: 20 })
const denied = (rQuery.value ?? []).filter((e) => e.decision === 'deny')
check('审计链: 拒绝事件同步入链', denied.length >= 2, `denied=${denied.length}`)

// 篡改检测
const auditFile = join(auditDir, 'trace_audit.jsonl')
const lines = readFileSync(auditFile, 'utf8').split('\n').filter(Boolean)
lines[0] = lines[0].replace(/"current_hash":"[0-9a-f]+"/, `"current_hash":"${'a'.repeat(64)}"`)
writeFileSync(auditFile, lines.join('\n') + '\n')
const rVerify2 = await call('eco_audit_verify')
check('审计链: 篡改检测生效', rVerify2.isError === false && rVerify2.value?.ok === false && /tamper|broken/.test(rVerify2.value?.error ?? ''),
  `error=${rVerify2.value?.error}`)

// --- 4. 记忆树：增删改查/搜索/同步 ---
const rAdd = await call('eco_memory_add', { content: '项目采用 SM3 哈希链做审计，参考 eco-agent 实现', score: 3, tags: ['sm3', 'audit'] })
const node1 = rAdd.value?.node
check('记忆树: 新增节点', rAdd.isError === false && !!node1?.id && rAdd.value?.ok === true)

const rAdd2 = await call('eco_memory_add', { content: '老板喜欢喝美式咖啡，加班时提神', score: 5, tags: ['coffee'], parent_id: node1?.id })
const node2 = rAdd2.value?.node
check('记忆树: 子节点挂载', rAdd2.isError === false && node2?.parent_id === node1?.id)

const rSearchEn = await call('eco_memory_search', { query: 'sm3 hash chain', limit: 5 })
check('记忆树: BM25 英文检索命中', rSearchEn.isError === false && (rSearchEn.value ?? []).length >= 1 &&
  (rSearchEn.value ?? [])[0]?.node?.id === node1?.id)

const rSearchZh = await call('eco_memory_search', { query: '咖啡', limit: 5 })
check('记忆树: 中文子串降级检索', rSearchZh.isError === false && (rSearchZh.value ?? []).length >= 1)

const rUpdate = await call('eco_memory_update', { id: node2?.id, score: 9 })
check('记忆树: 更新节点分数', rUpdate.isError === false && rUpdate.value?.node?.score === 9)

const rSync = await call('eco_memory_sync', { direction: 'both' })
check('记忆树: Obsidian 双向同步(导出)', rSync.isError === false && rSync.value?.ok === true && rSync.value?.exported?.length >= 1,
  `exported=${rSync.value?.exported?.length}`)

const rStatsMem = await call('eco_memory_stats')
check('记忆树: 统计(节点数>=2, 标签聚合)', rStatsMem.isError === false && rStatsMem.value?.nodes >= 2 &&
  (rStatsMem.value?.top_tags ?? []).some((t) => t[0] === 'sm3'))

// 观测 vault 文件实际落盘
check('记忆树: vault 目录生成 md 文件', existsSync(vault) && readdirCount(vault) >= 1, `files=${readdirCount(vault)}`)

const rDelete = await call('eco_memory_delete', { id: node1?.id })
check('记忆树: 删除节点', rDelete.isError === false && rDelete.value?.ok === true)

await ctx.stop?.()

function readdirCount(p) {
  try { return readdirSync(p).length } catch { return 0 }
}
rmSync(base, { recursive: true, force: true })

console.table(results)
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASSED` : `\n${failed}/${results.length} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
