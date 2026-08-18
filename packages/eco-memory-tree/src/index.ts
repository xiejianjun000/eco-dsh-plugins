/**
 * eco-memory-tree — dsh plugin: scored memory tree with BM25 search and
 * Obsidian bidirectional sync.
 *
 * Port of eco-agent's agent_core/memory_tree.py (scored nodes, SQLite+FTS5
 * BM25 ranking, Chinese substring fallback, Obsidian vault sync; source:
 * github.com/xiejianjun000/eco-agent, MIT).
 *
 * Design:
 *   - Nodes are scored, taggable, parent-linkable memory entries persisted as
 *     a JSON ledger (zero native deps, runs anywhere dsh runs).
 *   - search() ranks by BM25 over tokenized content; when the query contains
 *     CJK characters the matcher falls back to substring scoring — mirroring
 *     the original SQLite FTS5 + LIKE Chinese degradation.
 *   - Obsidian bidirectional sync: export nodes to Markdown files in a vault
 *     folder (with frontmatter + tags), and import/refresh from Markdown files
 *     the user edits in the vault. Conflicts are resolved by updated_at.
 *
 * Tools: eco_memory_add / eco_memory_search / eco_memory_update /
 *        eco_memory_delete / eco_memory_stats / eco_memory_sync
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'eco-memory-tree'
export const inject = ['tools']
export const Config = Schema.object({
  storeFile: Schema.string().default(join(homedir(), '.eco', 'dsh', 'memory', 'memory_tree.json'))
    .description('JSON ledger path for memory nodes'),
  obsidianVault: Schema.string().default('')
    .description('Optional Obsidian vault folder for bidirectional sync (empty = disabled)'),
  syncOnStart: Schema.boolean().default(false)
    .description('Import vault markdown once at plugin start'),
})

export interface MemoryNode {
  id: string
  content: string
  score: number
  tags: string[]
  parent_id: string | null
  created_at: number
  updated_at: number
  source: string // 'manual' | 'obsidian' | 'import'
}

const CJK_RE = /[\u4e00-\u9fff]/

/** Minimal BM25-style scorer with Chinese substring fallback. */
function scoreQuery(content: string, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const c = content.toLowerCase()
  if (CJK_RE.test(q)) {
    // Chinese degradation path: substring hits + character coverage bonus.
    if (!c.includes(q)) {
      // partial coverage: longest common contiguous substring
      let best = 0
      for (let i = 0; i < q.length; i++) {
        for (let len = 1; i + len <= q.length; len++) {
          if (c.includes(q.slice(i, i + len))) best = Math.max(best, len)
        }
      }
      return best >= 2 ? 0.5 + best * 0.1 : 0
    }
    // full substring hit; longer queries get a small boost
    return 5 + q.length * 0.2
  }
  // BM25-ish over whitespace tokens
  const docTokens = c.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const queryTokens = q.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  if (docTokens.length === 0 || queryTokens.length === 0) return 0
  const docLen = docTokens.length
  const avgDocLen = Math.max(docLen, 10)
  const k1 = 1.2
  const b = 0.75
  const tfMap = new Map<string, number>()
  for (const t of docTokens) tfMap.set(t, (tfMap.get(t) ?? 0) + 1)
  let score = 0
  for (const qt of new Set(queryTokens)) {
    const tf = tfMap.get(qt) ?? 0
    if (tf === 0) continue
    const idf = Math.log(1 + (docLen - tf + 0.5) / (tf + 0.5)) // collection of one
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen))))
  }
  return score
}

export class MemoryTreeService {
  nodes: MemoryNode[] = []
  private dirty = false

  constructor(readonly storeFile: string, readonly obsidianVault: string) {
    mkdirSync(join(storeFile, '..'), { recursive: true })
    this.load()
  }

  load(): void {
    if (!existsSync(this.storeFile)) return
    try {
      const raw = JSON.parse(readFileSync(this.storeFile, 'utf8')) as { nodes?: MemoryNode[] }
      this.nodes = Array.isArray(raw.nodes) ? raw.nodes : []
    } catch {
      this.nodes = []
    }
  }

  save(): void {
    mkdirSync(join(this.storeFile, '..'), { recursive: true })
    writeFileSync(this.storeFile, JSON.stringify({ nodes: this.nodes, saved_at: Date.now() }, null, 2), 'utf8')
    this.dirty = false
  }

  add(content: string, score = 1, tags: string[] = [], parentId: string | null = null): MemoryNode {
    const now = Date.now()
    const node: MemoryNode = {
      id: `n_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      score,
      tags,
      parent_id: parentId,
      created_at: now,
      updated_at: now,
      source: 'manual',
    }
    this.nodes.push(node)
    this.save()
    return node
  }

  update(id: string | undefined, patch: { content?: string; score?: number; tags?: string[]; parent_id?: string | null }): MemoryNode | null {
    if (!id) return null
    const node = this.nodes.find((n) => n.id === id)
    if (!node) return null
    if (patch.content !== undefined) node.content = patch.content
    if (patch.score !== undefined) node.score = patch.score
    if (patch.tags !== undefined) node.tags = patch.tags
    if (patch.parent_id !== undefined) node.parent_id = patch.parent_id
    node.updated_at = Date.now()
    this.save()
    return node
  }

  remove(id: string | undefined): boolean {
    if (!id) return false
    const before = this.nodes.length
    this.nodes = this.nodes.filter((n) => n.id !== id)
    if (this.nodes.length !== before) {
      this.save()
      return true
    }
    return false
  }

  search(query: string, limit = 10): Array<{ node: MemoryNode; relevance: number }> {
    const scored = this.nodes
      .map((node) => ({ node, relevance: scoreQuery(node.content, query) + node.score * 0.1 }))
      .filter((x) => x.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance)
    return scored.slice(0, limit)
  }

  stats(): Record<string, unknown> {
    const bySource: Record<string, number> = {}
    const byTag: Record<string, number> = {}
    for (const n of this.nodes) {
      bySource[n.source] = (bySource[n.source] ?? 0) + 1
      for (const t of n.tags) byTag[t] = (byTag[t] ?? 0) + 1
    }
    const avgScore = this.nodes.length
      ? this.nodes.reduce((s, n) => s + n.score, 0) / this.nodes.length
      : 0
    return {
      nodes: this.nodes.length,
      avg_score: Number(avgScore.toFixed(2)),
      by_source: bySource,
      top_tags: Object.entries(byTag).sort((a, b) => b[1] - a[1]).slice(0, 10),
      store_file: this.storeFile,
      obsidian_vault: this.obsidianVault || null,
    }
  }

  /** Obsidian sync. direction: 'to' | 'from' | 'both'. */
  sync(direction: 'to' | 'from' | 'both'): Record<string, unknown> {
    if (!this.obsidianVault) return { ok: false, error: 'obsidianVault not configured' }
    const exported: string[] = []
    const imported: string[] = []
    if (direction === 'to' || direction === 'both') {
      mkdirSync(this.obsidianVault, { recursive: true })
      for (const n of this.nodes) {
        if (n.source === 'obsidian' && n.tags.length === 0) continue // keep vault clean of unexported imports
        const file = join(this.obsidianVault, `${safeName(n.id)}.md`)
        const frontmatter = [
          '---',
          `id: "${n.id}"`,
          `score: ${n.score}`,
          `tags: [${n.tags.map((t) => `"${t}"`).join(', ')}]`,
          `parent_id: "${n.parent_id ?? ''}"`,
          `updated_at: ${n.updated_at}`,
          '---',
          '',
          n.content,
          '',
        ].join('\n')
        writeFileSync(file, frontmatter, 'utf8')
        exported.push(file)
      }
    }
    if (direction === 'from' || direction === 'both') {
      if (existsSync(this.obsidianVault)) {
        for (const file of readdirSync(this.obsidianVault).filter((f) => f.endsWith('.md'))) {
          const text = readFileSync(join(this.obsidianVault, file), 'utf8')
          const node = parseMarkdownNode(text, file)
          if (!node) continue
          const existing = this.nodes.find((n) => n.id === node.id)
          if (existing && node.updated_at <= existing.updated_at) continue // keep newest
          if (existing) {
            this.update(existing.id, {
              content: node.content,
              score: node.score,
              tags: node.tags,
              parent_id: node.parent_id,
            })
            existing.source = 'obsidian'
          } else {
            this.nodes.push(node)
          }
          imported.push(join(this.obsidianVault, file))
        }
        this.save()
      }
    }
    return { ok: true, direction, exported, imported, nodes: this.nodes.length }
  }

  /** Root nodes + child count, for tree view. */
  tree(): Array<{ node: MemoryNode; children: number }> {
    return this.nodes
      .filter((n) => !n.parent_id)
      .map((n) => ({ node: n, children: this.nodes.filter((c) => c.parent_id === n.id).length }))
  }
}

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_\-]/g, '_')
}

/** Parse an Obsidian markdown note into a MemoryNode (frontmatter + body). */
function parseMarkdownNode(text: string, file: string): MemoryNode | null {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  const now = Date.now()
  if (!m) return null
  const fm = m[1]
  const body = m[2].trim()
  const read = (key: string): string | null => {
    const r = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(fm)
    return r ? r[1].trim().replace(/^"|"$/g, '') : null
  }
  const id = read('id') ?? `obs_${file.replace(/\.md$/, '')}`
  const tags = (read('tags') ?? '[]')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
  const parent = read('parent_id') ?? ''
  return {
    id,
    content: body,
    score: Number(read('score') ?? 1) || 1,
    tags,
    parent_id: parent || null,
    created_at: now,
    updated_at: Number(read('updated_at') ?? now) || now,
    source: 'obsidian',
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ecoMemory: MemoryTreeService
  }
}

export function apply(ctx: Context, config: ConfigType) {
  const service = new MemoryTreeService(config.storeFile, config.obsidianVault)
  ctx.ecoMemory = service
  if (config.syncOnStart && config.obsidianVault) service.sync('from')

  ctx.tools.register(defineTool({
    name: 'eco_memory_add',
    description: 'Add a scored node to the memory tree.',
    parameters: {
      content: { type: 'string', description: 'Memory content' },
      score: { type: 'number', description: 'Importance score, default 1' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
      parent_id: { type: 'string', description: 'Optional parent node id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      if (!args?.content?.trim()) return { ok: false, error: 'content is required' }
      const node = service.add(args.content.trim(), args.score ?? 1, args.tags ?? [], args.parent_id ?? null)
      return JSON.parse(JSON.stringify({ ok: true, node }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eco_memory_search',
    description: 'Search memory nodes by relevance (BM25 + Chinese substring fallback, score-boosted).',
    parameters: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results, default 10' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return JSON.parse(JSON.stringify(service.search(args?.query ?? '', args?.limit ?? 10)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eco_memory_update',
    description: 'Update a memory node (content / score / tags / parent).',
    parameters: {
      id: { type: 'string', description: 'Node id' },
      content: { type: 'string' },
      score: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
      parent_id: { type: 'string', description: 'Set to empty string to detach' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const node = service.update(args?.id, {
        content: args?.content,
        score: args?.score,
        tags: args?.tags,
        parent_id: args?.parent_id === '' ? null : args?.parent_id,
      })
      return JSON.parse(JSON.stringify(node ? { ok: true, node } : { ok: false, error: 'node not found' }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eco_memory_delete',
    description: 'Delete a memory node by id.',
    parameters: {
      id: { type: 'string', description: 'Node id' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return JSON.parse(JSON.stringify({ ok: service.remove(args?.id) }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eco_memory_stats',
    description: 'Memory tree statistics: node count, avg score, tags, vault config.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      return JSON.parse(JSON.stringify(service.stats()))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eco_memory_sync',
    description: 'Bidirectional sync with the Obsidian vault (to / from / both).',
    parameters: {
      direction: { type: 'string', enum: ['to', 'from', 'both'], description: 'Sync direction, default both' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      return JSON.parse(JSON.stringify(service.sync((args?.direction ?? 'both') as 'to' | 'from' | 'both')))
    },
  }))
}

type ConfigType = { storeFile: string; obsidianVault: string; syncOnStart: boolean }
