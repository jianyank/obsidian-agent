import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryStore } from '../lib/store.js'
import { composeNote } from '../lib/frontmatter.js'

async function storeFor(entries) {
  const store = new MemoryStore({
    listNotes: async () => entries.map((_, index) => ({ path: `decisions/${index}.md`, type: 'decision' })),
    relative: (path) => path,
    read: async (path) => {
      const entry = entries[Number(path.match(/\d+/)[0])]
      return composeNote({ status: 'active', updated: '2026-10-01', ...entry }, entry.body ?? 'Details')
    },
  })
  await store.refresh()
  return store
}

test('Chinese connected keywords find a title with separators', async () => {
  const store = await storeFor([{ id: 'decision/network', title: '代理：配置', body: '网络访问策略' }])
  assert.equal(store.search('代理配置')[0]?.entry.id, 'decision/network')
})

test('Chinese and English keywords rank a combined match before a partial one', async () => {
  const store = await storeFor([
    { id: 'decision/partial', title: '代理', body: '其他配置' },
    { id: 'decision/full', title: 'GitHub 代理配置', body: '网络访问策略' },
  ])
  assert.equal(store.search('代理配置 GitHub')[0]?.entry.id, 'decision/full')
})

test('normalization supports full-width English keywords', async () => {
  const store = await storeFor([{ id: 'decision/github', title: 'GitHub 连接' }])
  assert.equal(store.search('ＧＩＴＨＵＢ')[0]?.entry.id, 'decision/github')
})

test('a short tag does not match an unrelated longer query', async () => {
  const store = await storeFor([{ id: 'decision/unrelated', title: 'Unrelated', tags: ['a'] }])
  assert.deepEqual(store.search('database'), [])
})

test('title and tag matches outrank body and exclude inactive notes', async () => {
  const store = await storeFor([
    { id: 'decision/body', title: 'Body', body: 'proxy' },
    { id: 'decision/tag', title: 'Tag', tags: ['proxy'] },
    { id: 'decision/title', title: 'proxy' },
    { id: 'decision/old', title: 'proxy', status: 'superseded' },
  ])
  assert.deepEqual(store.search('proxy').map((hit) => hit.entry.id), ['decision/title', 'decision/tag', 'decision/body'])
  assert.equal(store.search('proxy', { status: 'any' }).length, 4)
})
