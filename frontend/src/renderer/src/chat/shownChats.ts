/**
 * Which chat each model's panel last showed, with the transcript as it stood.
 *
 * The chat panel exists on the Model view only, so every visit to another view unmounts it, and a model
 * switch empties it. Coming back, it used to start blank and fill in once the chat store had answered two
 * requests — during a run, the opening message vanished and came back, and the run bar was gone in between.
 * The panel now leaves its transcript here when it goes and starts from it when it returns; the store's
 * answer follows right after and replaces it, so the store stays the one truth. Kept for the window's
 * lifetime only, like the turns in flight (chat/turnView.ts).
 */
import type { ChatMessage } from '../lib/ai'
import { workspaceGeneration } from '../lib/modelView'

const shown = new Map<string, { workspace: number; id: string; messages: ChatMessage[] }>()

/** What the panel showed for ``database`` when it last went, if anything — in this workspace. */
export function shownChat(database: string | null): { id: string; messages: ChatMessage[] } | undefined {
  const entry = database ? shown.get(database) : undefined
  return entry && entry.workspace === workspaceGeneration() ? entry : undefined
}

/** The panel goes (another view, another model): keep what it showed for ``database``. */
export function leaveChat(database: string | null, id: string | null, messages: ChatMessage[]): void {
  if (!database) return
  if (id) shown.set(database, { workspace: workspaceGeneration(), id, messages })
  else shown.delete(database)
}

/**
 * The store's copy of the chat shown from memory, with what arrived live meanwhile kept: ``base`` is the
 * transcript the panel started from, ``current`` what it shows now. A turn that ended while the store was
 * answering is on screen and maybe not yet in the store's copy — dropping it would take an answer back.
 */
export function withLiveTail(
  stored: ChatMessage[],
  current: ChatMessage[],
  base: ChatMessage[]
): ChatMessage[] {
  if (current.length <= base.length || base.some((m, i) => current[i] !== m)) return stored
  const tail = current.slice(base.length)
  const same = (a: ChatMessage, b: ChatMessage): boolean =>
    a.role === b.role && a.content === b.content && (!a.turn_id || !b.turn_id || a.turn_id === b.turn_id)
  // What of the tail the store has already saved stands at its end, in the same order and after the
  // remembered part — matched there only: the same words earlier in the chat ("continue") are another message.
  let saved = Math.min(tail.length, Math.max(0, stored.length - base.length))
  while (saved > 0 && !tail.slice(0, saved).every((m, i) => same(stored[stored.length - saved + i], m)))
    saved--
  return saved === tail.length ? stored : [...stored, ...tail.slice(saved)]
}
