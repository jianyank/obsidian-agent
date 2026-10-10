/**
 * dsh-obsidian-memory — Obsidian-backed conversation memory.
 *
 * Layer 1 (this file): durable, classified memory notes in an Obsidian vault,
 * plus a bounded index card in the prompt and tools for precise recall.
 *
 * Design notes that matter:
 * - The notes are the source of truth. The in-memory index is a rebuildable
 *   cache with a short TTL, because the user edits the vault in Obsidian.
 * - The always-on prompt contribution is an INDEX, not retrieval. The
 *   `PromptContext` hook receives no pending messages, so query-aware injection
 *   belongs to the `memory_search` tool instead of the prompt.
 * - Note identity is `type/slug`, so writing the same title again UPDATES that
 *   note. That is what keeps `project-state` ("what is true now") from
 *   accumulating contradicting copies.
 */

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MEMORY_TYPE_LIST, Vault, slugify } from './lib/vault.js'
import { MemoryStore } from './lib/store.js'
import { MEMORY_PROTOCOL, buildCard } from './lib/card.js'
import { createDigestUnit } from './lib/projection.js'
import { composeNote, parseFrontmatter } from './lib/frontmatter.js'

/** Plugin name as it appears in the loader tree. */
export const name = 'obsidian-memory'

/** Hard dependencies: the plugin stays inactive when any of these is absent. */
export const inject = ['tools', 'systemPrompt', 'fs']

/** Tunables live here so the user's patch layer survives upgrades. */
export const Config = z.object({
  vaultPath: z.string().default('D:/AI/Obsidian/Deepseek Harness')
    .description('Obsidian 库根目录（绝对路径）'),
  memoryRoot: z.string().default('Memory')
    .description('库内的记忆子树，插件独占该目录'),
  sandboxMode: z.string().default('workspace-write')
    .description('写入沙箱模式：workspace-write 只允许写 vaultPath 之下；danger-full-access 完全放开'),
  project: z.string().default('deepseek-harness')
    .description('写入笔记 frontmatter 的项目标识'),
  injectBudgetChars: z.natural().default(2400)
    .description('常驻记忆卡片的字符上限；0 表示完全不注入'),
  alwaysInjectTypes: z.array(z.string()).default(['preference', 'open-question'])
    .description('无条件进入卡片的记忆类型'),
  cardRecentCount: z.natural().default(8)
    .description('卡片额外附带最近更新的条目数'),
  refreshTtlMs: z.natural().default(5000)
    .description('索引缓存有效期（毫秒）；过期后在后台重建'),
  searchLimit: z.natural().default(12)
    .description('memory_search 默认返回条数'),
  rebuildIndexOnWrite: z.boolean().default(true)
    .description('每次写入后重建 _index.md'),
})

/** Model-facing text for one tool value. */
function formatValue(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Compose the markdown body, keeping evidence as a short blockquote. */
function composeBody(input) {
  const lines = [String(input?.body ?? '').trim()]
  const evidence = String(input?.evidence ?? '').trim()
  if (evidence) {
    lines.push('', '## 依据')
    for (const line of evidence.split('\n')) {
      const text = line.trim()
      if (text) lines.push(`> ${text}`)
    }
  }
  return lines.join('\n')
}

/** Tool output rendering: one text block carrying the JSON value. */
const OUTPUT = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: formatValue(value) }],
}

export function apply(ctx, config) {
  const vault = new Vault(ctx, config)
  const store = new MemoryStore(vault)
  const nowIso = () => new Date().toISOString()
  let writeTail = Promise.resolve()
  let pendingWrites = 0

  // Warm the index in the background; a cold card renders empty for one step.
  void store.refresh()

  const refreshIfStale = () => {
    if (pendingWrites === 0 && store.isStale(config.refreshTtlMs)) void store.refresh()
  }

  async function readyToRead() {
    await writeTail
    if (store.loading || store.isStale(config.refreshTtlMs)) await store.refresh()
  }

  // Keep note, supersedes and generated index updates in one ordered operation.
  function enqueueWrite(callback) {
    pendingWrites += 1
    const result = writeTail.then(callback).finally(() => { pendingWrites -= 1 })
    writeTail = result.catch(() => {})
    return result
  }

  // ---------------------------------------------------------------- prompts

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'obsidian-memory:protocol',
      order: 4000,
      text: MEMORY_PROTOCOL,
    }),
  )

  ctx.effect(() =>
    ctx.systemPrompt.context({
      name: 'obsidian-memory:card',
      order: 200,
      text: () => {
        refreshIfStale()
        return buildCard(store, config)
      },
    }),
  )

  // ------------------------------------------------------------ capture fold

  // Optional dependency: a projection problem must never disable the tools.
  ctx.inject(['sessionProjections'], (scope) => {
    try {
      scope.effect(() => scope.sessionProjections.register(createDigestUnit()))
    } catch (error) {
      // Logging is best-effort: reading `ctx.logger` itself must not throw here.
      try {
        ctx.logger?.warn?.(`obsidian-memory: 会话投影注册失败（不影响记忆读写）：${String(error?.message ?? error)}`)
      } catch {
        // ignore
      }
    }
  })

  // ------------------------------------------------------------------ writes

  /** Resolve type, title, and slug into a stable note identity. */
  function identity(input) {
    const type = MEMORY_TYPE_LIST.includes(input?.type) ? input.type : 'glossary'
    const title = String(input?.title ?? '').trim() || 'untitled'
    const slug = slugify(title)
    return { type, title, slug, id: `${type}/${slug}`, path: vault.pathFor(type, slug) }
  }

  /** Create or overwrite one note, preserving its original `created` stamp. */
  async function upsertNote(input, sessionId) {
    const { type, title, slug, id, path } = identity(input)
    let created = nowIso()
    let isCreate = true

    if (await vault.stat(path)) {
      isCreate = false
      try {
        const { data } = parseFrontmatter(await vault.read(path))
        if (typeof data.created === 'string' && data.created) created = data.created
      } catch {
        // Unreadable prior note: rewrite it cleanly.
      }
    }

    const frontmatter = {
      id,
      type,
      title,
      tags: (input?.tags ?? []).map(String),
      status: 'active',
      confidence: ['high', 'medium', 'low'].includes(input?.confidence) ? input.confidence : 'medium',
      stability: input?.stability === 'session' ? 'session' : 'durable',
      project: config.project,
      session: String(input?.session ?? sessionId ?? ''),
      sourceSeqs: (input?.sourceSeqs ?? []).map(Number).filter(Number.isFinite),
      supersedes: (input?.supersedes ?? []).map(String),
      created,
      updated: nowIso(),
    }

    await vault.write(path, composeNote(frontmatter, composeBody(input)))
    return { id, slug, type, title, path, rel: vault.relative(path), created: isCreate }
  }

  /** Mark superseded notes as inactive so they leave every card and search. */
  async function applySupersedes(ids, byId) {
    const results = []
    for (const raw of ids ?? []) {
      const target = String(raw)
      if (target === byId) {
        results.push({ id: target, updated: false, reason: 'self' })
        continue
      }
      const entry = store.byId(target)
      if (!entry) {
        results.push({ id: target, updated: false, reason: 'not-found' })
        continue
      }
      if (entry.id === byId) {
        results.push({ id: entry.id, updated: false, reason: 'self' })
        continue
      }
      try {
        const { data, body } = parseFrontmatter(await vault.read(entry.path))
        await vault.write(
          entry.path,
          composeNote({ ...data, status: 'superseded', supersededBy: byId, updated: nowIso() }, body),
        )
        results.push({ id: entry.id, updated: true })
      } catch (error) {
        results.push({ id: target, updated: false, reason: String(error?.message ?? error) })
      }
    }
    return results
  }

  /** Regenerate the map-of-content note for the whole memory tree. */
  async function rebuildIndex() {
    await store.refresh()
    const lines = [
      '# 记忆库索引',
      '',
      `更新：${nowIso()}　条目总数：${store.entries.length}`,
      '',
      '> 本文件由 dsh-obsidian-memory 自动生成，手工修改会在下次写入时丢失。',
      '',
    ]
    for (const type of MEMORY_TYPE_LIST) {
      const group = store.entries.filter((entry) => entry.type === type)
      if (group.length === 0) continue
      lines.push(`## ${type}（${group.length}）`, '')
      for (const entry of group.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))) {
        const filename = entry.rel.split('/').pop().replace(/\.md$/i, '')
        const flag = entry.status === 'active' ? '' : ` \`${entry.status}\``
        lines.push(`- [[${filename}|${entry.title}]]${flag} — ${entry.summary}`)
      }
      lines.push('')
    }
    await vault.write(vault.indexPath(), `${lines.join('\n')}\n`)
  }

  // ------------------------------------------------------------------- tools

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'memory_write',
        description:
          '把一条耐久记忆写入 Obsidian 记忆库并分类落盘。用于决策、用户偏好、当前状态、经验教训、待确认问题。' +
          '同 type + 同 title 会改写同一条笔记（project-state 应这样更新，不要新增）。',
        parameters: {
          type: { type: 'string', enum: MEMORY_TYPE_LIST, required: true, description: '记忆类型' },
          title: { type: 'string', required: true, description: '简短标题；决定文件名，同标题即同一条' },
          body: { type: 'string', required: true, description: '正文，2-5 行，自包含可独立理解' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: '置信度，默认 medium' },
          stability: { type: 'string', enum: ['durable', 'session'], description: '寿命，默认 durable' },
          evidence: { type: 'string', description: '依据原文（短引用）' },
          supersedes: { type: 'array', items: { type: 'string' }, description: '被本条取代的记忆 id，会标记为 superseded' },
          sourceSeqs: { type: 'array', items: { type: 'integer' }, description: '来源会话事件序号，用于溯源' },
        },
        output: OUTPUT,
        execute: (args, exec) => enqueueWrite(async () => {
          await store.refresh()
          const sessionId = exec?.agent?.session?.id ?? exec?.agent?.id
          const written = await upsertNote(args, sessionId)
          const superseded = await applySupersedes(args?.supersedes, written.id)
          if (config.rebuildIndexOnWrite) await rebuildIndex()
          else await store.refresh()
          return {
            ok: true,
            id: written.id,
            title: written.title,
            type: written.type,
            rel: written.rel,
            created: written.created,
            superseded,
          }
        }),
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'memory_search',
        description:
          '在 Obsidian 记忆库中按关键词检索记忆条目，返回标题、摘要与相对路径。' +
          '这是获取记忆细节的正确入口；拿到 id 后再用 memory_read 读原文。',
        parameters: {
          query: { type: 'string', required: true, description: '检索词（中英文均可）' },
          type: { type: 'string', enum: MEMORY_TYPE_LIST, description: '限定记忆类型' },
          includeInactive: { type: 'boolean', description: '是否包含已失效条目，默认否' },
          limit: { type: 'integer', description: '返回条数上限' },
        },
        output: OUTPUT,
        execute: async (args) => {
          await readyToRead()
          const hits = store.search(args?.query, {
            type: args?.type,
            status: args?.includeInactive ? 'any' : 'active',
            limit: args?.limit ?? config.searchLimit,
          })
          return {
            total: store.entries.length,
            query: args?.query,
            hits: hits.map(({ entry, score }) => ({
              id: entry.id,
              type: entry.type,
              title: entry.title,
              status: entry.status,
              confidence: entry.confidence,
              summary: entry.summary,
              rel: entry.rel,
              score,
            })),
          }
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'memory_read',
        description: '按 id 或相对路径读取一条记忆笔记的完整内容与元数据。',
        parameters: {
          id: { type: 'string', required: true, description: '记忆 id（形如 decision/xxx）或相对路径（decisions/xxx.md）' },
        },
        output: OUTPUT,
        execute: async (args) => {
          await readyToRead()
          const entry = await store.read(args?.id)
          if (!entry) return { ok: false, error: `未找到记忆条目：${String(args?.id)}` }
          return {
            ok: true,
            id: entry.id,
            type: entry.type,
            title: entry.title,
            tags: entry.tags,
            status: entry.status,
            confidence: entry.confidence,
            stability: entry.stability,
            project: entry.project ?? null,
            session: entry.session,
            sourceSeqs: entry.sourceSeqs ?? [],
            supersedes: entry.supersedes ?? [],
            supersededBy: entry.supersededBy ?? null,
            created: entry.created ?? null,
            updated: entry.updated,
            rel: entry.rel,
            body: entry.body,
          }
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'memory_list',
        description: '列出记忆库条目（不检索内容），用于了解记忆库的分类与规模。',
        parameters: {
          type: { type: 'string', enum: MEMORY_TYPE_LIST, description: '限定记忆类型' },
          status: { type: 'string', enum: ['active', 'superseded', 'retracted', 'any'], description: '按状态过滤，默认 active' },
          limit: { type: 'integer', description: '返回条数上限' },
        },
        output: OUTPUT,
        execute: async (args) => {
          await readyToRead()
          const status = args?.status ?? 'active'
          const limit = Math.max(1, args?.limit ?? 50)
          const filtered = store.entries
            .filter((entry) => (status === 'any' ? true : entry.status === status))
            .filter((entry) => (args?.type ? entry.type === args.type : true))
            .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
          return {
            total: store.entries.length,
            returned: Math.min(filtered.length, limit),
            memoryRoot: vault.memoryRoot,
            entries: filtered.slice(0, limit).map((entry) => ({
              id: entry.id,
              type: entry.type,
              title: entry.title,
              status: entry.status,
              updated: entry.updated,
              rel: entry.rel,
            })),
          }
        },
      }),
    ),
  )
}
