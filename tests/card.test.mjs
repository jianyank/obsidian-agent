import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCard } from '../lib/card.js'

const entries = [
  { id: 'preference/a', type: 'preference', title: 'Answer style', summary: 'Short answers', rel: 'preferences/a.md', status: 'active', confidence: 'high' },
  { id: 'decision/b', type: 'decision', title: 'Network', summary: 'Direct connection', rel: 'decisions/b.md', status: 'active', confidence: 'high' },
]
const store = { entries, alwaysOn: () => entries.slice(0, 1), recent: () => entries }
const config = { alwaysInjectTypes: ['preference'], cardRecentCount: 8 }

test('card never exceeds any configured budget including the omission notice', () => {
  for (const budget of [0, 1, 20, 40, 60, 80, 120, 160, 240, 2400]) {
    const card = buildCard(store, { ...config, injectBudgetChars: budget })
    assert.ok(card.length <= budget, `budget=${budget}, actual=${card.length}`)
  }
})

test('cropped card preserves a whole entry and never emits partial paths', () => {
  const card = buildCard(store, { ...config, injectBudgetChars: 130 })
  assert.ok(card.includes('preferences/a.md'))
  assert.ok(!card.includes('decisions/b.md'))
  assert.match(card, /memory_search/)
  const items = card.split('\n').filter((line) => line.startsWith('- '))
  assert.equal(items.length, 1)
  assert.ok(items.every((line) => line.endsWith('.md')))
})

test('full card deduplicates preferred and recent entries', () => {
  const card = buildCard(store, { ...config, injectBudgetChars: 2400 })
  assert.equal(card.split('\n').filter((line) => line.startsWith('- ')).length, 2)
})
