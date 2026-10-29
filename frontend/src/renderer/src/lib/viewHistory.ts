/**
 * The canvas's own undo history: how a model is laid out — positions, colours, group boxes — step by step.
 *
 * The arrangement is view state, deliberately not on the backend's command bus (api/v1/views.py says why),
 * so it gets a history of its own here, one per model and kept for the session. A step holds the whole
 * arrangement as it was BEFORE a change the user (or the assistant's auto-layout) made; taking it back
 * puts that arrangement back and keeps the one it replaced for Redo. Changes that follow from a model edit
 * — a box renamed after a tag, a group losing a deleted process — are not steps: the model edit is, and the
 * toolbar takes back whichever of the two histories holds the newer step (`firstUndo`, `firstRedo`).
 */
import type { NodeGroup } from './groups'

export interface ViewSnapshot {
  pos: Record<string, { x: number; y: number }>
  colors: Record<string, string>
  groups: NodeGroup[]
}

export interface ViewStep {
  /** What the change was, for the toolbar's "Undo: …". */
  label: string
  /** When it was made (ms) — compared with the backend's `next_undo_at`. Kept when the step moves. */
  at: number
  /** The arrangement on the other side of the step: before it on the undo stack, after it on redo. */
  snap: ViewSnapshot
}

export interface ViewStacks {
  undo: ViewStep[]
  redo: ViewStep[]
}

/** How many steps a model keeps; older ones fall off. */
export const VIEW_HISTORY_LIMIT = 100

/** Whether Undo takes back the canvas step before the model's: it is newer than the model's own newest step,
 *  or the model has none. ``modelAt`` is that step's time even when another model's step holds it — a canvas
 *  step must not jump ahead of a model change made after it. */
export function firstUndo(view: ViewStep | undefined, modelAt: number | null | undefined): boolean {
  return !!view && (modelAt == null || view.at > modelAt)
}

/** Whether Redo brings back the canvas step first. Undo always took back the newest step, so the step to
 *  bring back first is the OLDER of the two redo stacks' tops — the one taken back last. ``modelAt`` is null
 *  when the model has nothing to bring back (or its Redo was ended by a newer canvas change). */
export function firstRedo(view: ViewStep | undefined, modelAt: number | null | undefined): boolean {
  return !!view && (modelAt == null || view.at < modelAt)
}

/** Whether a canvas step taken back may still be brought back: no model step is newer than it. One made
 *  since ends it, as any new change ends Redo; taking that one back again makes it valid again. */
export function redoable(view: ViewStep | undefined, modelUndoAt: number | null | undefined): boolean {
  return !!view && (modelUndoAt == null || view.at > modelUndoAt)
}

/** A new step: the history grows, its Redo is gone, and the oldest steps fall off past the limit. */
export function pushStep(stacks: ViewStacks, step: ViewStep): ViewStacks {
  return { undo: [...stacks.undo, step].slice(-VIEW_HISTORY_LIMIT), redo: [] }
}

/** Take back the newest step: ``now`` (the arrangement on screen) goes to Redo under the same label and time. */
export function undoStep(
  stacks: ViewStacks,
  now: ViewSnapshot
): { stacks: ViewStacks; restore: ViewSnapshot } | null {
  const top = stacks.undo[stacks.undo.length - 1]
  if (!top) return null
  return {
    stacks: { undo: stacks.undo.slice(0, -1), redo: [...stacks.redo, { ...top, snap: now }] },
    restore: top.snap
  }
}

/** Bring back the step taken back last: the mirror of {@link undoStep}. */
export function redoStep(
  stacks: ViewStacks,
  now: ViewSnapshot
): { stacks: ViewStacks; restore: ViewSnapshot } | null {
  const top = stacks.redo[stacks.redo.length - 1]
  if (!top) return null
  return {
    stacks: { undo: [...stacks.undo, { ...top, snap: now }], redo: stacks.redo.slice(0, -1) },
    restore: top.snap
  }
}
