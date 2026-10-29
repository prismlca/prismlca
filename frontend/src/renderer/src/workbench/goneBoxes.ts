/**
 * Where boxes stood that the model's graph no longer has — kept so that a box which comes back
 * lands on its old spot.
 *
 * Undo of a deleted process restores it under its old code, so its node id is the same; but the
 * canvas had dropped the position with the delete, and the box reappeared in the grid's next free
 * cell. Recorded on every rebuild rather than in the delete paths, so it holds
 * whatever took the box away (the Delete key, the assistant, an MCP client) and whatever brings it
 * back (Undo, Redo, the assistant's undo).
 *
 * Kept for the session only and never written to the stored view: the backend's undo stack is
 * in-memory as well, so after a restart nothing can bring the box back, and a deleted process
 * leaves no trace in views.json. Node ids carry the model name, so one map serves every model and
 * survives switching between them — undo history does too.
 */
import type { Node } from '@xyflow/react'

type Pos = { x: number; y: number }

/** Note the spot of every box of the outgoing canvas that is not in `present`. */
export function rememberGone(prev: Node[], present: Set<string>, gone: Record<string, Pos>): void {
  for (const n of prev) if (!present.has(n.id)) gone[n.id] = { x: n.position.x, y: n.position.y }
}

/** The spot a returning box stood on — handed out once, then it is an ordinary position again. */
export function takeGone(id: string, gone: Record<string, Pos>): Pos | undefined {
  const p = gone[id]
  if (p) delete gone[id]
  return p
}
