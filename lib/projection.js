/**
 * Host-only `sessionProjections` unit that folds the session log into a small
 * per-session digest.
 *
 * The fold is pure and synchronous and returns the SAME state reference for
 * every event it does not care about, so unrelated events cost nothing
 * downstream. It is the capture layer for later distillation: it never calls a
 * model and never writes a note.
 */

import z from '@deepseek-ai/schemastery'

/** Registry key of this projection unit. */
export const DIGEST_KEY = 'obsidian-memory-digest'

const RECENT_LIMIT = 8
const TEXT_LIMIT = 400

/** Plain-JSON state: bump `stateVersion` whenever the shape or fold changes. */
const stateSchema = z.object({
  turns: z.natural().default(0),
  userTurns: z.natural().default(0),
  toolResults: z.natural().default(0),
  toolErrors: z.natural().default(0),
  recentUserText: z.array(z.string()).default([]),
})

/** Extract visible text from a message's content blocks. */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Push one string onto a bounded copy of an array. */
function pushBounded(list, value) {
  const next = [...list, value.slice(0, TEXT_LIMIT)]
  return next.length > RECENT_LIMIT ? next.slice(next.length - RECENT_LIMIT) : next
}

/**
 * Build the projection definition for `sessionProjections.register`.
 * @returns a definition with `key`, `stateSchema`, `init`, `apply`, `stateVersion`.
 */
export function createDigestUnit() {
  return {
    key: DIGEST_KEY,
    stateSchema,
    stateVersion: 1,

    init() {
      return { turns: 0, userTurns: 0, toolResults: 0, toolErrors: 0, recentUserText: [] }
    },

    apply(state, event) {
      switch (event?.type) {
        case 'turn/end':
          return { ...state, turns: state.turns + 1 }
        case 'user/message': {
          const text = messageText(event.data).trim()
          return {
            ...state,
            userTurns: state.userTurns + 1,
            recentUserText: text ? pushBounded(state.recentUserText, text) : state.recentUserText,
          }
        }
        case 'tool/result':
          return {
            ...state,
            toolResults: state.toolResults + 1,
            toolErrors: state.toolErrors + (event.data?.error ? 1 : 0),
          }
        default:
          // Same reference: unchanged state costs nothing downstream.
          return state
      }
    },
  }
}
