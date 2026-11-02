/**
 * What a box takes with it when it leaves the canvas — kept so that a box which comes back lands on its old
 * spot, in its colour and in its group box.
 *
 * Undo of a deleted process restores it under its old code, and Undo of a removed supplier restores the
 * inputs that drew on it, so the node id is the same; but the canvas had dropped the position with the
 * delete, and the box reappeared in the grid's next free cell. The spot is recorded on every rebuild rather
 * than in the delete paths, so it holds whatever took the box away (the Delete key, the assistant, an MCP
 * client) and whatever brings it back (Undo, Redo, the assistant's undo).
 *
 * Colour and group membership are different: they stay put while a box is merely away, and only the delete
 * paths clear them — on purpose, so a later box under the same id (a dataset dragged in again) does not
 * inherit them. Those paths stash both here first (`stashGone`), together with the inputs a box held, and a
 * node that comes back gets them again — a box only with one of those inputs, since a new input of the same
 * dataset and tags lands in a box of the same id without anything having been undone.
 *
 * Kept for the session only and never written to the stored view: the backend's undo stack is in-memory as
 * well, so after a restart nothing can bring the box back, and a deleted process leaves no trace in
 * views.json. One map per model (useBoxes keys them): a box's id names its dataset, not the model, and
 * another model's box of the same dataset must not take what this one left with.
 */
import type { Node } from '@xyflow/react'

import { addToGroup, groupOf, type NodeGroup } from '../lib/groups'

type Pos = { x: number; y: number }

/** A box that left: where it stood, and what a delete path cleared on its way out. */
export interface GoneBox {
  pos: Pos
  color?: string
  /** The group box it was in, as it was then — put back whole if the box went with its last member. */
  group?: NodeGroup
  /** A box's inputs when it was deleted: only a box holding one of them again is the one coming back. */
  uids?: string[]
}

export type GoneBoxes = Record<string, GoneBox>

/** Note the spot of every box of the outgoing canvas that is not in `present`, keeping what a delete path
 *  stashed for it; a box that is still there has nothing to come back with. */
export function rememberGone(prev: Node[], present: Set<string>, gone: GoneBoxes): void {
  for (const n of prev)
    if (present.has(n.id)) delete gone[n.id]
    else gone[n.id] = { ...gone[n.id], pos: { x: n.position.x, y: n.position.y } }
}

/** Before a delete path clears them: the spot, colour and group box of every node it removes. */
export function stashGone(
  ids: Iterable<string>,
  nodes: Node[],
  colors: Record<string, string>,
  groups: NodeGroup[],
  gone: GoneBoxes
): void {
  for (const id of ids) {
    const n = nodes.find((x) => x.id === id)
    if (!n) continue
    const group = groupOf(groups, id)
    const uids = (n.data as { uids?: string[] }).uids
    gone[id] = {
      pos: { x: n.position.x, y: n.position.y },
      ...(colors[id] ? { color: colors[id] } : {}),
      ...(group ? { group } : {}),
      ...(uids?.length ? { uids } : {})
    }
  }
}

/** What a returning node left with — handed out once, then its spot is an ordinary position again. A box
 *  holding none of the inputs it was deleted with is a new one under the same id: it gets the spot, as any
 *  box coming back does, but not the colour and group that went with the deleted one. */
export function takeGone(id: string, gone: GoneBoxes, uids: string[] = []): GoneBox | undefined {
  const g = gone[id]
  if (!g) return undefined
  delete gone[id]
  return !g.uids || g.uids.some((u) => uids.includes(u)) ? g : { pos: g.pos }
}

/** ``groups`` with ``id`` back in the box it was in. A box that went with its last member comes back as it
 *  was, holding just this one; a node that is in a box already stays where it is. */
export function rejoinGroup(groups: NodeGroup[], id: string, was: NodeGroup): NodeGroup[] {
  if (groupOf(groups, id)) return groups
  if (groups.some((g) => g.id === was.id)) return addToGroup(groups, was.id, [id])
  return [...groups, { ...was, members: [id] }]
}
