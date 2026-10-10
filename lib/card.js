/**
 * Prompt contributions: a static usage protocol and the bounded memory card.
 *
 * The card is deliberately an INDEX, not a retrieval result. `PromptContext`
 * providers receive only an `AssembleContext` (scope + signal), never the
 * pending messages, so query-aware injection is impossible at this hook.
 * Precision recall is delegated to the `memory_search` tool, which costs
 * nothing until the model actually needs it.
 */

/** Static protocol telling the model how to treat the memory layer. */
export const MEMORY_PROTOCOL = `## 长期记忆（Obsidian 记忆库）
「记忆库」区块只是索引卡片，不是完整内容；每条末尾的相对路径指向真正的笔记。
- 需要记忆中的事实时：先 memory_search，再 memory_read 读原文。不要凭卡片摘要复述细节。
- 卡片中标注 (low) 或 [superseded] / [retracted] 的条目不可直接采信。
- 出现耐久结论（决策 / 用户偏好 / 当前状态 / 经验教训 / 待确认问题）时，用 memory_write 落库。
- type=project-state 表示"当前事实"：应改写同一条（同标题即同一条），不要新增重复条目。
- 记忆未覆盖的问题，直接问用户，不要推断或编造。`

/** One compact card line for an entry. */
function renderLine(entry) {
  const flags = []
  if (entry.status !== 'active') flags.push(`[${entry.status}]`)
  if (entry.confidence === 'low') flags.push('(low)')
  else if (entry.confidence === 'medium') flags.push('(?)')
  const prefix = flags.length > 0 ? `${flags.join('')} ` : ''
  const summary = entry.summary ? ` — ${entry.summary}` : ''
  return `- [${entry.type}] ${prefix}${entry.title}${summary} · ${entry.rel}`
}

/**
 * Build the bounded memory card.
 * @returns card text, or `''` when the vault holds nothing worth carrying.
 */
export function buildCard(store, config) {
  const budget = Math.max(0, config.injectBudgetChars ?? 2400)
  if (budget === 0 || store.entries.length === 0) return ''

  const lines = []
  const seen = new Set()
  const candidates = [...store.alwaysOn(config.alwaysInjectTypes), ...store.recent(config.cardRecentCount)]

  for (const entry of candidates) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    lines.push(renderLine(entry))
  }
  if (lines.length === 0) return ''

  const header = `## 记忆库（共 ${store.entries.length} 条，以下为常驻 + 最近更新）`
  const full = `${header}\n${lines.join('\n')}`
  if (full.length <= budget) return full

  const notice = '\n…（卡片已截断，请用 memory_search 检索）'
  if (header.length + notice.length > budget) return ''
  let text = header
  for (const line of lines) {
    if (text.length + 1 + line.length + notice.length > budget) break
    text += `\n${line}`
  }
  return text + notice
}
