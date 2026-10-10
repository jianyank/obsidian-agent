/**
 * In-memory index over the Obsidian memory tree.
 *
 * The notes are the source of truth and the user may edit them in Obsidian at
 * any time, so the index is a rebuildable cache with a short TTL rather than a
 * durable store. Retrieval is lexical (field-weighted scoring, no embeddings):
 * hundreds of notes do not justify a vector index, and lexical scoring costs no
 * tokens and stays explainable.
 */

import { parseFrontmatter } from './frontmatter.js'

const MAX_BODY_CHARS = 4000
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

function searchable(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
}

/** First meaningful body line, used as the one-line card summary. */
function firstLine(body) {
  for (const line of String(body ?? '').split('\n')) {
    const text = line.trim()
    if (text) return text.replace(/^#+\s*/, '').slice(0, 200)
  }
  return ''
}

/** Segment connected Chinese words, preserving ordinary alphanumeric runs. */
function tokenize(text) {
  const tokens = []
  for (const run of searchable(text).match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(run)) {
      for (const part of segmenter.segment(run)) {
        if (part.isWordLike) tokens.push(part.segment)
      }
    } else {
      tokens.push(run)
    }
  }
  return [...new Set(tokens)]
}

/** Newest-first comparison on the ISO `updated` field. */
function compareUpdatedDesc(a, b) {
  return String(b.updated).localeCompare(String(a.updated))
}

/** Normalize one parsed note into an index entry. */
function normalize(file, vault, data, body) {
  const slug = file.path.split('/').pop().replace(/\.md$/i, '')
  const type = typeof data.type === 'string' && data.type ? data.type : file.type
  return {
    id: typeof data.id === 'string' && data.id ? data.id : `${type}/${slug}`,
    type,
    title: typeof data.title === 'string' && data.title ? data.title : slug,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    status: typeof data.status === 'string' ? data.status : 'active',
    confidence: typeof data.confidence === 'string' ? data.confidence : 'medium',
    stability: typeof data.stability === 'string' ? data.stability : 'durable',
    pinned: data.pinned === true,
    session: typeof data.session === 'string' ? data.session : '',
    updated: typeof data.updated === 'string' ? data.updated : '',
    summary: firstLine(body),
    body: body.slice(0, MAX_BODY_CHARS),
    path: file.path,
    rel: vault.relative(file.path),
  }
}

/** Field-weighted lexical score for one entry. */
function scoreEntry(entry, tokens) {
  const title = searchable(entry.title)
  const tags = entry.tags.map(searchable).filter(Boolean)
  const haystack = searchable(`${entry.summary}\n${entry.body}`)
  let score = 0
  for (const token of tokens) {
    if (title.includes(token)) score += 5
    if (tags.some((tag) => tag.includes(token))) score += 3
    if (haystack.includes(token)) score += 1
  }
  return score
}

/** Rebuildable lexical index over every memory note. */
export class MemoryStore {
  constructor(vault) {
    this.vault = vault
    this.entries = []
    this.loadedAt = 0
    this.loading = null
    this.lastError = undefined
  }

  /** Whether the cache is older than the caller's tolerance. */
  isStale(ttlMs) {
    return Date.now() - this.loadedAt > ttlMs
  }

  /** Rescan the tree; concurrent callers share one in-flight scan. */
  refresh() {
    if (this.loading) return this.loading
    this.loading = this.load().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  async load() {
    try {
      const files = await this.vault.listNotes()
      const entries = []
      for (const file of files) {
        try {
          const text = await this.vault.read(file.path)
          const { data, body } = parseFrontmatter(text)
          entries.push(normalize(file, this.vault, data, body))
        } catch {
          // An unreadable or mid-edit note is skipped, never fatal.
        }
      }
      this.entries = entries
      this.loadedAt = Date.now()
      this.lastError = undefined
    } catch (error) {
      this.lastError = error
      this.loadedAt = Date.now()
    }
  }

  /** Active entries only, newest first. */
  active() {
    return this.entries.filter((entry) => entry.status === 'active').sort(compareUpdatedDesc)
  }

  /** Entries that belong on every card: pinned, or of an always-inject type. */
  alwaysOn(types) {
    const wanted = new Set(types ?? [])
    return this.active().filter((entry) => entry.pinned || wanted.has(entry.type))
  }

  /** Most recently updated active entries. */
  recent(count) {
    return this.active().slice(0, Math.max(0, count))
  }

  byId(id) {
    const key = String(id ?? '').trim()
    if (!key) return undefined
    return (
      this.entries.find((entry) => entry.id === key) ??
      this.entries.find((entry) => entry.rel === key) ??
      this.entries.find((entry) => entry.rel.replace(/\.md$/i, '') === key)
    )
  }

  /** Read current metadata and unbounded body from the source note, not the cache. */
  async read(id) {
    const cached = this.byId(id)
    if (!cached) return undefined
    const { data, body } = parseFrontmatter(await this.vault.read(cached.path))
    const entry = normalize({ path: cached.path, type: cached.type }, this.vault, data, body)
    return { ...data, ...entry, body }
  }

  /**
   * Rank active entries against a query.
   * @returns `{ entry, score }[]`, best first; an empty query returns recency.
   */
  search(query, options = {}) {
    const limit = Math.max(1, options.limit ?? 12)
    const status = options.status ?? 'active'
    let pool = this.entries
    if (status !== 'any') pool = pool.filter((entry) => entry.status === status)
    if (options.type) pool = pool.filter((entry) => entry.type === options.type)

    const tokens = tokenize(query)
    if (tokens.length === 0) {
      return pool
        .slice()
        .sort(compareUpdatedDesc)
        .slice(0, limit)
        .map((entry) => ({ entry, score: 0 }))
    }

    const scored = []
    for (const entry of pool) {
      const score = scoreEntry(entry, tokens)
      if (score > 0) scored.push({ entry, score })
    }
    scored.sort((a, b) => b.score - a.score || compareUpdatedDesc(a.entry, b.entry))
    return scored.slice(0, limit)
  }
}
