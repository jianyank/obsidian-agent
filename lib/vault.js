/**
 * Vault paths and file access for the Obsidian memory tree.
 *
 * Access goes through `ctx.fs` so the Host's filesystem provider, observation
 * policy, and sandbox policy stay in charge instead of a private `node:fs`
 * shortcut.
 */

/** Memory type → directory name inside the memory root. */
export const TYPE_DIRS = {
  preference: 'preferences',
  'project-state': 'project-state',
  decision: 'decisions',
  lesson: 'lessons',
  'error-fix': 'error-fixes',
  'open-question': 'open-questions',
  glossary: 'glossary',
}

/** Stable, ordered list of memory types. */
export const MEMORY_TYPE_LIST = Object.keys(TYPE_DIRS)

/** Join path segments with `/`, dropping empties and redundant separators. */
export function joinPath(...parts) {
  const out = []
  for (const raw of parts) {
    if (raw === undefined || raw === null || raw === '') continue
    out.push(String(raw).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
  }
  return out.join('/')
}

/**
 * Filename-safe slug that keeps CJK intact.
 * The slug IS the note identity: the same title always maps to the same note.
 */
export function slugify(title, max = 64) {
  const base = String(title ?? '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const cut = base.slice(0, max).replace(/-+$/g, '')
  return cut || 'untitled'
}

/** One Obsidian vault subtree holding classified conversation memory. */
export class Vault {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
  }

  /** Absolute (host) path of the memory root. */
  get memoryRoot() {
    return joinPath(this.config.vaultPath, this.config.memoryRoot)
  }

  /** Directory name for one memory type. */
  dirFor(type) {
    return TYPE_DIRS[type] ?? 'notes'
  }

  /** Note path for one type + slug. */
  pathFor(type, slug) {
    return joinPath(this.memoryRoot, this.dirFor(type), `${slug}.md`)
  }

  /** Path of the generated map-of-content note. */
  indexPath() {
    return joinPath(this.memoryRoot, '_index.md')
  }

  /** Strip the memory root, yielding an Obsidian-friendly relative path. */
  relative(path) {
    const root = `${this.memoryRoot}/`
    return path.startsWith(root) ? path.slice(root.length) : path
  }

  async target(path) {
    return await this.ctx.fs.resolve(path)
  }

  async stat(path) {
    try {
      return await this.ctx.fs.stat(await this.target(path))
    } catch {
      return undefined
    }
  }

  async read(path) {
    return await this.ctx.fs.readText(await this.target(path))
  }

  /**
   * Sandbox policy for vault mutations.
   *
   * The vault normally lives OUTSIDE the session workspace, so the ambient
   * `workspace-write` policy denies it. Declaring the vault itself as the
   * policy's workspace root grants writes under the vault and nothing else —
   * deliberately narrower than `danger-full-access`.
   */
  writePolicy() {
    const allowed = ['workspace-write', 'danger-full-access']
    const configured = this.config.sandboxMode
    return {
      mode: allowed.includes(configured) ? configured : 'workspace-write',
      workspaceRoot: String(this.config.vaultPath).replace(/\//g, '\\'),
    }
  }

  /** Create-or-overwrite under the vault-scoped sandbox policy. */
  async write(path, content) {
    return await this.ctx.fs.writeText(await this.target(path), content, undefined, undefined, this.writePolicy())
  }

  async listDir(path) {
    try {
      return await this.ctx.fs.listDir(await this.target(path))
    } catch {
      return []
    }
  }

  /** Every existing `.md` note under the memory tree. */
  async listNotes() {
    const found = []
    for (const type of MEMORY_TYPE_LIST) {
      const dir = joinPath(this.memoryRoot, this.dirFor(type))
      for (const entry of await this.listDir(dir)) {
        if (entry.type !== 'file') continue
        if (!entry.name.toLowerCase().endsWith('.md')) continue
        found.push({ path: joinPath(dir, entry.name), type })
      }
    }
    return found
  }
}
