/**
 * Minimal YAML frontmatter reader/writer for the fixed memory-note schema.
 *
 * Deliberately dependency-free: notes are user-editable in Obsidian, so the
 * reader is tolerant, while the writer emits only scalars and inline string
 * lists that Obsidian, Dataview, and `js-yaml` all accept.
 */

const KEY_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/
const ITEM_RE = /^\s*-\s+(.*)$/

/** Render one scalar as a double-quoted YAML string (JSON escaping is valid YAML). */
function inline(value) {
  return JSON.stringify(String(value))
}

/** Render one sequence item, keeping numbers and booleans unquoted. */
function inlineItem(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return 'null'
  return inline(value)
}

/** Split an inline `[a, b, "c, d"]` body on top-level commas only. */
function splitInlineList(inner) {
  const out = []
  let buf = ''
  let quote = null
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote) {
      if (ch === '\\') {
        buf += ch + (inner[i + 1] ?? '')
        i += 1
        continue
      }
      buf += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      continue
    }
    if (ch === ',') {
      out.push(buf)
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim() !== '') out.push(buf)
  return out
}

/** Parse one already-trimmed scalar. */
function parseScalar(raw) {
  const text = String(raw).trim()
  if (text === '') return ''
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+$/.test(text)) return Number(text)
  if (text.startsWith('"') || text.startsWith("'")) {
    if (text.startsWith('"')) {
      try {
        return JSON.parse(text)
      } catch {
        return text.slice(1, -1)
      }
    }
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    return inner === '' ? [] : splitInlineList(inner).map(parseScalar)
  }
  return text
}

/**
 * Split a note into its frontmatter object and markdown body.
 * A note without a leading `---` block yields an empty object and the whole text.
 */
export function parseFrontmatter(source) {
  const text = String(source ?? '')
  if (!text.startsWith('---')) return { data: {}, body: text }
  const lines = text.split(/\r?\n/)
  if (lines[0].trim() !== '---') return { data: {}, body: text }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { data: {}, body: text }

  const data = {}
  let currentKey = null
  for (let i = 1; i < end; i += 1) {
    const line = lines[i]
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const item = ITEM_RE.exec(line)
    if (item && currentKey) {
      const list = Array.isArray(data[currentKey]) ? data[currentKey] : (data[currentKey] = [])
      list.push(parseScalar(item[1]))
      continue
    }
    const match = KEY_RE.exec(line)
    if (!match) continue
    currentKey = match[1]
    data[currentKey] = match[2].trim() === '' ? [] : parseScalar(match[2])
  }
  return { data, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') }
}

/** Serialize a frontmatter object into a `---` block (no trailing newline). */
export function serializeFrontmatter(data) {
  const out = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      out.push(`${key}: [${value.map(inlineItem).join(', ')}]`)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out.push(`${key}: ${value}`)
    } else if (value === null) {
      out.push(`${key}: null`)
    } else {
      out.push(`${key}: ${inline(value)}`)
    }
  }
  out.push('---')
  return out.join('\n')
}

/** Compose a complete note file from frontmatter and body. */
export function composeNote(data, body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim()
  return `${serializeFrontmatter(data)}\n\n${text}\n`
}
