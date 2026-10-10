import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { deferred, harness, note } from './support/harness.mjs'
import { composeNote, parseFrontmatter } from '../lib/frontmatter.js'

test('memory_read returns the whole long note, not the bounded search body', async () => {
  const body = `${'x'.repeat(5000)}\n尾部证据`
  const app = harness({ initial: [note('decision', 'long', body)] })
  const result = await app.call('memory_read', { id: 'decision/long' })
  assert.equal(result.body.trimEnd(), body)
  assert.ok(result.body.endsWith('尾部证据\n'))
})

test('memory_read uses current file content and metadata even inside the cache TTL', async () => {
  const app = harness({ initial: [note('decision', 'editable', 'Old body')] })
  await app.call('memory_list', {})
  app.files.set('D:/test-vault/Memory/decisions/editable.md', composeNote({
    id: 'decision/editable', type: 'decision', title: 'Edited', status: 'retracted',
    confidence: 'low', tags: ['edited'], updated: '2026-10-10',
  }, 'New body'))
  const result = await app.call('memory_read', { id: 'decision/editable' })
  assert.equal(result.body.trim(), 'New body')
  assert.equal(result.title, 'Edited')
  assert.equal(result.status, 'retracted')
  assert.deepEqual(result.tags, ['edited'])
})

test('cold write waits for initial scan before resolving supersedes', async () => {
  const gate = deferred()
  const app = harness({ initial: [note('decision', 'old', 'Old conclusion')], beforeList: () => gate.promise })
  const writing = app.call('memory_write', { type: 'decision', title: 'new', body: 'New conclusion', supersedes: ['decision/old'] })
  await setImmediate()
  gate.resolve()
  const result = await writing
  assert.equal(result.superseded[0].updated, true)
  const search = await app.call('memory_search', { query: 'conclusion' })
  assert.deepEqual(search.hits.map((hit) => hit.id), ['decision/new'])
  assert.ok(!app.card().includes('Old conclusion'))
})

test('expired-cache write resolves a newly added external note before superseding it', async () => {
  const app = harness({ config: { refreshTtlMs: 0 } })
  await app.call('memory_list', {})
  const [path, text] = note('decision', 'external', 'External')
  app.files.set(`D:/test-vault/Memory/${path}`, text)
  await new Promise((resolve) => setTimeout(resolve, 5))
  const result = await app.call('memory_write', { type: 'decision', title: 'new', body: 'Replacement', supersedes: ['decision/external'] })
  assert.equal(result.superseded[0].updated, true)
})

test('concurrent writes are ordered so a later write can replace an earlier one', async () => {
  const gate = deferred()
  const started = deferred()
  const app = harness({ beforeWrite: async (path) => {
    if (path.endsWith('/first.md')) { started.resolve(); await gate.promise }
  } })
  const first = app.call('memory_write', { type: 'decision', title: 'first', body: 'First conclusion' })
  await started.promise
  const second = app.call('memory_write', { type: 'decision', title: 'second', body: 'Second conclusion', supersedes: ['decision/first'] })
  await setImmediate()
  gate.resolve()
  const [, result] = await Promise.all([first, second])
  assert.equal(result.superseded[0].updated, true)
  const listed = await app.call('memory_list', {})
  assert.deepEqual(listed.entries.map((entry) => entry.id), ['decision/second'])
  assert.match(app.files.get('D:/test-vault/Memory/_index.md'), /superseded/)
})

test('same-title updates preserve created timestamp and vault-scoped write policy', async () => {
  const app = harness({ initial: [note('project-state', 'current', 'Old', { created: '2026-09-01' })] })
  const result = await app.call('memory_write', { type: 'project-state', title: 'current', body: 'Updated' })
  const stored = parseFrontmatter(app.files.get('D:/test-vault/Memory/project-state/current.md'))
  assert.equal(result.created, false)
  assert.equal(stored.data.created, '2026-09-01')
  assert.equal(stored.data.session, 'test-session')
  assert.equal(stored.body.trim(), 'Updated')
  assert.ok(app.policies.every((policy) => policy.mode === 'workspace-write' && policy.workspaceRoot === 'D:\\test-vault'))
})

test('failed write does not poison subsequent writes', async () => {
  const app = harness({ beforeWrite: (path) => { if (path.endsWith('/bad.md')) throw new Error('denied') } })
  await assert.rejects(app.call('memory_write', { type: 'lesson', title: 'bad', body: 'Bad' }), /denied/)
  const good = await app.call('memory_write', { type: 'lesson', title: 'good', body: 'Good' })
  assert.equal(good.ok, true)
  const read = await app.call('memory_read', { id: 'lesson/good' })
  assert.equal(read.body.trim(), 'Good')
})

test('readers wait for an in-flight write to finish', async () => {
  const gate = deferred()
  const started = deferred()
  const app = harness({ beforeWrite: async (path) => {
    if (path.endsWith('/current.md')) { started.resolve(); await gate.promise }
  } })
  const writing = app.call('memory_write', { type: 'project-state', title: 'current', body: 'Complete state' })
  await started.promise
  let settled = false
  const reading = app.call('memory_read', { id: 'project-state/current' }).then((result) => { settled = true; return result })
  await setImmediate()
  assert.equal(settled, false)
  gate.resolve()
  await writing
  assert.equal((await reading).body.trim(), 'Complete state')
})

test('consecutive updates remain searchable when index-file rebuilding is disabled', async () => {
  const app = harness({ config: { rebuildIndexOnWrite: false } })
  await app.call('memory_write', { type: 'lesson', title: 'workflow', body: 'Old keyword' })
  await app.call('memory_write', { type: 'lesson', title: 'workflow', body: 'Fresh keyword' })
  assert.equal((await app.call('memory_search', { query: 'Fresh' })).hits.length, 1)
  assert.equal((await app.call('memory_search', { query: 'Old' })).hits.length, 0)
  assert.equal(app.files.has('D:/test-vault/Memory/_index.md'), false)
})

test('missing notes report not-found and deleted source notes do not return cached bodies', async () => {
  const app = harness({ initial: [note('lesson', 'deleted', 'Old body')] })
  assert.equal((await app.call('memory_read', { id: 'lesson/missing' })).ok, false)
  app.files.delete('D:/test-vault/Memory/lessons/deleted.md')
  await assert.rejects(app.call('memory_read', { id: 'lesson/deleted' }), /ENOENT/)
})

test('a relative-path alias cannot mark the written note as superseded by itself', async () => {
  const app = harness({ initial: [note('decision', 'current', 'Old')] })
  const result = await app.call('memory_write', {
    type: 'decision', title: 'current', body: 'Updated', supersedes: ['decisions/current.md'],
  })
  assert.equal(result.superseded[0].reason, 'self')
  assert.equal((await app.call('memory_list', {})).entries[0]?.id, 'decision/current')
})
