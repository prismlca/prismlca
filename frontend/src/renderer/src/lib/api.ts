/** Thin typed wrapper over the IPC bridge to the local backend. */
import { ApiError, apiError } from '../../../shared/backendError'

// The class (and the unwrapping) live in shared/backendError.ts — the main process reads backend
// failures through the same function now, so a 422's field names reach every consumer.
export { ApiError }

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await window.prism.api(method, path, body)
  const failure = apiError(res.status, res.body)
  if (failure) throw failure
  return res.body as T
}

/** True for the 409 raised when a newer results request supersedes this one. */
export function isSuperseded(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'calc_superseded'
}

export interface ActivityInfo {
  database: string
  code: string
  name: string
  product: string | null
  location: string | null
  unit: string | null
  read_only: boolean
}

export interface GraphNode extends ActivityInfo {
  id: string
  external: boolean
  upstream?: number
  /** On a box, `inherited` marks a value none of its inputs holds itself — passed down by the process using
   *  it, or the own tag of a process from another model — which is where the calculation books it too. */
  tags?: { dimension: string; value: string; inherited?: boolean }[]
  /** A box of an outside dataset: the dataset (`db/code`) and the model inputs (uids) that draw on it.
   *  One dataset may have several boxes, one per tag combination (see lib/occurrences.ts). */
  dataset_id?: string
  uids?: string[]
}

export interface GraphEdge {
  uid: string
  type: string
  amount: number
  source: string
  target: string
  /** The input's own tags (an input from outside the model only). */
  tags?: { dimension: string; value: string }[]
}

export interface Graph {
  database: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  // Links from a background input into a foreground node; drawn only when that
  // input is on the canvas as a reference. Absent from older backends.
  bg_edges?: GraphEdge[]
  // The direct (tier-1) background inputs, so the canvas can always show the first
  // ecoinvent tier on open (whoever added the input — user or AI). Absent from older backends.
  bg_nodes?: GraphNode[]
}

export interface AuditEntry {
  index: number
  timestamp: string
  source: string
  action: string
  summary: string
  /** False = audit-only note (e.g. database lifecycle) that is NOT part of the undo history. */
  undoable?: boolean
  /** The model that changed. Absent on project-wide actions AND on every line written before
   *  2026-08-24, which is why `isAttributed` asks about all three fields and not about this one. */
  database?: string | null
  /** Where the change came from: copy, localize, duplicate model, bundle import. */
  related?: string | null
  /** Only for a project-wide action with consequences inside models (a deleted tag group strips
   *  assignments everywhere): the models it actually reached into. */
  databases?: string[] | null
  /** On a `rename_model` note: the name the model had until this line. The read side links the two
   *  names by position in the log; the sentence in `summary` is for the reader, not for code. */
  previous_name?: string | null
  /** The assistant turn (one chat message → one agent run) this change belongs to. Written by the
   *  backend from the id the AI loop sends, never inferred — consecutive entries sharing it are
   *  rendered as one dashed group, and undo/redo can take the whole turn back in one go. */
  turn?: string | null

  // --- resolved by the backend on read, never stored ------------------------
  /** What the model is called *today*, when it differs from `database` — i.e. it was renamed after
   *  this line was written. The stored name is never rewritten (the log is append-only). */
  current_name?: string | null
  /** The model this entry belongs to no longer exists. The entry stays: an append-only history
   *  outlives the model, and saying so is better than letting the line vanish. */
  model_gone?: boolean | null
  /** Set on the one entry that created the model being viewed out of another one: where it came
   *  from. Only ever present in a model-scoped answer. */
  copied_from?: string | null
  /** Model-scoped answers only: a workspace-wide action (a tag group, a tag) — it stands in every
   *  model's list, marked, rather than in the "earlier history" block. */
  workspace?: boolean
}

/** Whether the entry names any model at all. False for the history written before the field
 *  existed — shown as its own collapsed block, never mixed into a model's list, and never
 *  backfilled by looking for the model's name in `summary` (that guess is what broke the bundle). */
export function isAttributed(e: AuditEntry): boolean {
  return !!(e.database || e.related || e.databases?.length || e.workspace)
}

/** Undo/redo availability, from `GET /model/history?database=` — what the buttons would do on the open
 *  model. One stack for the workspace, session-local by design (the steps hold snapshots of the
 *  pre-change state). Scoped to a model, Undo reaches past other models' steps that are on the positive
 *  list (local edits: amounts, parameters, fields, scenarios); any other step of another model holds it
 *  and is named in `undo_elsewhere`. */
export interface UndoState {
  can_undo: boolean
  can_redo: boolean
  next_undo: string | null
  next_redo: string | null
  /** The contiguous assistant-turn block on top of each stack, if any — what the undo/redo buttons
   *  use to offer "the whole turn, or just the last step?". Contiguous is the point: a turn with
   *  something else on top of it is not offered, because that would pull from the middle of the
   *  stack. */
  next_undo_turn?: { turn: string; size: number } | null
  next_redo_turn?: { turn: string; size: number } | null
  /** When the step Undo / Redo would act on was first made (epoch ms) — the canvas's own undo history
   *  goes first when its step is newer (lib/viewHistory.ts). */
  next_undo_at?: number | null
  next_redo_at?: number | null
  /** Not from the server: the model this answer was asked for (the Workbench stamps it). Absent while the
   *  open model's answer is still out — the canvas's own history then waits rather than guess the order. */
  model?: string | null
  /** The newest step belongs to another model: which one, and what it was. */
  undo_elsewhere?: { model: string | null; summary: string } | null
  redo_elsewhere?: { model: string | null; summary: string } | null
}

export interface DatabaseInfo {
  name: string
  node_count: number
  read_only: boolean
  kind: string
}
