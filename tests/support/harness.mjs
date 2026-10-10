import './sdk.mjs'
import assert from 'node:assert/strict'
import { composeNote } from '../../lib/frontmatter.js'
import { TYPE_DIRS } from '../../lib/vault.js'

const { apply } = await import('../../index.js')
const { isJsonValue } = await import('@deepseek-ai/dsh-util-values')

export function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

export function harness({ initial = [], config = {}, beforeList, beforeWrite } = {}) {
  const files = new Map(initial.map(([path, text]) => [`D:/test-vault/Memory/${path}`, text]))
  const tools = new Map()
  const contexts = []
  const policies = []
  const settings = {
    vaultPath: 'D:/test-vault', memoryRoot: 'Memory', sandboxMode: 'workspace-write',
    project: 'test', injectBudgetChars: 2400, alwaysInjectTypes: ['preference', 'open-question'],
    cardRecentCount: 8, refreshTtlMs: 5000, searchLimit: 12, rebuildIndexOnWrite: true,
    ...config,
  }
  const ctx = {
    effect: (callback) => callback(),
    inject: () => {},
    systemPrompt: { section: () => () => {}, context: (value) => { contexts.push(value); return () => {} } },
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => {} } },
    fs: {
      resolve: async (path) => path,
      stat: async (path) => { if (!files.has(path)) throw new Error('ENOENT'); return { type: 'file' } },
      readText: async (path) => { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path) },
      listDir: async (path) => {
        const prefix = `${path}/`
        const entries = [...files.keys()].filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
          .map((file) => ({ type: 'file', name: file.slice(prefix.length) }))
        await beforeList?.(path)
        return entries
      },
      writeText: async (path, text, _options, _signal, policy) => {
        await beforeWrite?.(path, text)
        files.set(path, text)
        policies.push(policy)
      },
    },
  }
  apply(ctx, settings)
  return {
    files, policies,
    card: () => contexts[0].text(),
    call: async (name, args) => {
      const result = await tools.get(name).execute(args, { agent: { session: { id: 'test-session' } } })
      assert.ok(isJsonValue(result), 'tool output must be a valid JSON value')
      return result
    },
  }
}

export function note(type, slug, body, extra = {}) {
  return [`${TYPE_DIRS[type]}/${slug}.md`, composeNote({
    id: `${type}/${slug}`, type, title: slug, status: 'active', confidence: 'high',
    updated: '2026-10-01T00:00:00.000Z', ...extra,
  }, body)]
}
