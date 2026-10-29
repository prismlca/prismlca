/**
 * A model's view state — canvas arrangement, node colours, results setup — with the backend as the
 * truth and `localStorage` as a write-behind cache.
 *
 * The browser store used to be the truth, which made the arrangement the property of a
 * browser profile: it never travelled to another machine, a reinstall dropped it, "clear application
 * data" took it, and a renamed model stranded its layout under the dead name. It lives in the project
 * now (`prism_meta/views.json`), which is also what lets it travel in a model bundle.
 *
 * Why keep a cache at all: drawing a canvas must not wait for a round trip, and a backend that is
 * still starting must not cost the arrangement. Read order is cache → server (server wins when they
 * differ); write order is cache at once → server after a pause.
 *
 * Two shapes on purpose. The canvas loads imperatively — it has to seed `posRef` before the graph is
 * built — so it uses `viewSync`/`viewFetch`/`viewSet`. The panels are declarative and use
 * `useViewSection`, which has the signature of `usePersisted` so the call sites read the same.
 *
 * What this is *not*: a two-way sync. One writer per window, last write wins, no merge — two windows
 * on one model is not worth a conflict algorithm.
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { renameDatabaseInView } from './subjectKey'

/** How long a section sits still before it goes to the backend: dragging a node across the canvas
 *  becomes one write instead of sixty, and `flushViews()` covers the moment the window closes. */
const SETTLE_MS = 400

export interface CanvasRef {
  id: string
  name: string
  location: string | null
  unit: string | null
  upstream?: number
  x: number
  y: number
  /** A copy not yet connected: its dataset and the tags its first input will get (lib/occurrences.ts). */
  dataset_id?: string
  tags?: { dimension: string; value: string }[]
}

/** Additive by contract: a new section is a new key, never a renamed one — the backend keeps keys it
 *  does not know (see `ViewStore.put`), and this side must not drop them either. */
export interface ModelView {
  layout?: { pos?: Record<string, { x: number; y: number }>; refs?: CanvasRef[] }
  colors?: Record<string, string>
  results?: Record<string, unknown>
  detailed?: Record<string, unknown>
  [section: string]: unknown
}

const cacheKey = (db: string): string => `prism.view.${db}`

/** What every component sees, so a Workbench write is visible to a panel without a round trip. */
const live = new Map<string, ModelView>()
const listeners = new Map<string, Set<() => void>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const fetched = new Set<string>()
/** Models whose view the backend has actually answered for — unlike `fetched`, a failed GET is not in
 *  it. Whoever wants to write a decision derived from the stored view (a migration) waits for this. */
const hydrated = new Set<string>()

function emit(db: string): void {
  for (const fn of listeners.get(db) ?? []) fn()
}

function readCache(db: string): ModelView | null {
  try {
    const raw = localStorage.getItem(cacheKey(db))
    return raw ? (JSON.parse(raw) as ModelView) : null
  } catch {
    return null
  }
}

/**
 * The legacy browser keys, read once per model so nobody loses an arrangement made before the move.
 *
 * Deliberately not deleted afterwards: they stay for one version, so a rollback to the previous build
 * finds its own data. `prism.nodeColors` was global — keyed by node code with no model — so it is
 * taken as it is; another model's codes simply never match a node here.
 */
export function legacyView(db: string): ModelView | null {
  const read = <T>(key: string): T | undefined => {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? undefined : (JSON.parse(raw) as T)
    } catch {
      return undefined
    }
  }
  const canvas = read<{ refs?: CanvasRef[]; pos?: Record<string, { x: number; y: number }> }>(
    `prism.canvas.${db}`
  )
  const colors = read<Record<string, string>>('prism.nodeColors')
  const pick = (prefix: string, keys: string[]): Record<string, unknown> | undefined => {
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      // Model-scoped keys carry the database in the key; see modelKey() in lib/persist.ts.
      const v = read<unknown>(`${prefix}.${k}.${db}`) ?? read<unknown>(`${prefix}.${k}`)
      if (v !== undefined) out[k] = v
    }
    return Object.keys(out).length ? out : undefined
  }
  const view: ModelView = {}
  if (canvas && (canvas.pos || canvas.refs)) view.layout = { pos: canvas.pos, refs: canvas.refs }
  if (colors && Object.keys(colors).length) view.colors = colors
  const results = pick('prism.ov', [
    'fgSubjects',
    'bgSubjects',
    'subjSel',
    'scenSel',
    'refCode',
    'picked',
    'family',
    'baseline',
    'colors'
  ])
  const detailed = pick('prism.dr', [
    'subject',
    'methodKey',
    'family',
    'cutoff',
    'maxDepth',
    'flows',
    'groupBy',
    'bgDb',
    'shown'
  ])
  if (results) view.results = results
  if (detailed) view.detailed = detailed
  return Object.keys(view).length ? view : null
}

/** The view to draw right now: whatever is in memory, else the cache, else the legacy keys. */
export function viewSync(db: string): ModelView {
  const known = live.get(db)
  if (known) return known
  const seed = readCache(db) ?? legacyView(db) ?? {}
  live.set(db, seed)
  return seed
}

function put(db: string): void {
  if (switching) return // nothing goes out while the backend moves
  const body = live.get(db)
  const t = timers.get(db)
  if (t) {
    clearTimeout(t)
    timers.delete(db)
  }
  if (!body) return
  // What is written stays marked until the backend has taken it. It used to be unmarked as the PUT
  // left: a PUT that failed then had nothing protecting it — the next start's GET replaced the cached
  // arrangement with the older stored one, and a GET answering while the PUT was out took the edited
  // values back before the failure was even known.
  const rev = revs.get(db) ?? 0
  const gen = generation
  // Its own entry, so an earlier PUT finishing later cannot clear the bookkeeping of this one.
  const mine = { rev }
  sentRev.set(db, mine)
  const sent = api('PUT', `/api/v1/views/${encodeURIComponent(db)}`, { view: body })
    .then(() => {
      // Only if nothing was written meanwhile, and only in the workspace it was written in.
      if (gen === generation && (revs.get(db) ?? 0) === rev) dirty.delete(db)
    })
    .catch(() => {
      /* offline or backend restarting — still marked, so the next write or flush sends it again */
    })
    .finally(() => {
      if (sentRev.get(db) === mine) sentRev.delete(db)
    })
  inFlightPuts.add(sent)
  void sent.finally(() => inFlightPuts.delete(sent))
}

/** PUTs on their way — a workspace switch waits for them (see beginWorkspaceSwitch). */
const inFlightPuts = new Set<Promise<unknown>>()

/** Another model-scoped write that a workspace switch and an update's save-now must wait for, like
 *  the view PUTs: Model info's save on close or on departure (components/ModelInfo). */
export function holdForDeparture(write: Promise<unknown>): void {
  inFlightPuts.add(write)
  void write.catch(() => {}).finally(() => inFlightPuts.delete(write))
}

/**
 * Views are keyed by model name only, and the backend writes a PUT into whichever workspace is
 * active when it arrives. Two workspaces may hold a model of the same name: a layout write still in
 * its 400 ms pause, or the old canvas saving itself on its way out after the backend had already
 * switched, landed in the OTHER workspace's view of that name.
 * So a switch is fenced: everything pending is sent — and awaited — while the backend still stands
 * in the old workspace, writes are dropped while it moves, and the caches are emptied before the
 * new workspace's first model loads.
 */
let switching = false
/** Bumped at every finished switch: a GET answering after it belongs to the workspace left behind. */
let generation = 0
/** Which switch owns the fence: an older switch finishing late must not take down a newer one's
 *  (A→B ending in its `finally` released B→C's fence). */
let fenceOwner = 0

/** Which workspace the model names on screen belong to: a memory kept per model name outside this module
 *  (the chat panel's, chat/shownChats.ts) is worthless after a switch — names repeat across workspaces. */
export function workspaceGeneration(): number {
  return generation
}

/** Before the backend switches: send what is pending into the workspace it belongs to, then let
 *  nothing else through — fenced before the wait, so a write made while the PUTs are out cannot slip
 *  in behind them. The caller saves the outgoing canvas first: it writes its layout
 *  only on departure, and a departure behind the fence would be lost. */
export async function beginWorkspaceSwitch(): Promise<number> {
  flushViews()
  switching = true
  const id = ++fenceOwner
  await Promise.allSettled(Array.from(inFlightPuts))
  return id
}

/** The switch did not happen (the backend refused): writes go on as before. Safe to call twice; only
 *  the switch that raised the fence can take it down. */
export function cancelWorkspaceSwitch(id: number): void {
  if (id !== fenceOwner) return
  switching = false
}

/** After the switch, once the old canvas has gone and before the new model loads: nothing held here
 *  belongs to the new workspace — not the in-memory views, not the fetch markers, not the browser
 *  copies under the same names. Safe to call twice: only a switch in progress is ended. */
export function endWorkspaceSwitch(id: number): void {
  if (!switching || id !== fenceOwner) return
  generation++
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  live.clear()
  fetched.clear()
  hydrated.clear()
  dirty.clear()
  revs.clear()
  sentRev.clear()
  inflight.clear()
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith('prism.view.')) localStorage.removeItem(k)
    }
  } catch {
    /* localStorage optional */
  }
  switching = false
}

/** Sections written since the last PUT, per model: a GET answering late must not take them back. */
//: Per section, WHICH fields were written when the section is an object (`null` = the whole section):
//: an automatic write of one field — the Results page pruning its scenario ticks while the GET is still
//: out — must not make the whole cached section outrank the server's answer, or a stale colour from
//: the cache survives the merge and is written back over a newer one.
const dirty = new Map<string, Map<string, Set<string> | null>>()
/** Per model, a counter bumped on every write — so a PUT's answer knows whether it still describes
 *  what is marked — and the counter of the PUT now on its way, so a flush does not send it twice. */
const revs = new Map<string, number>()
const sentRev = new Map<string, { rev: number }>()

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function markDirty(db: string, name: string, prev: unknown, value: unknown): void {
  revs.set(db, (revs.get(db) ?? 0) + 1)
  const sections = dirty.get(db) ?? new Map<string, Set<string> | null>()
  dirty.set(db, sections)
  const had = sections.get(name)
  // A section the cache does not hold yet is an empty object, not an unknown whole: the first field a
  // page writes into a model it has never cached (the Results page pruning its scenario ticks while the
  // GET is out) used to mark the WHOLE section, and the merge then dropped the server's other fields
  // — the stored subject and indicators were replaced by the opening defaults.
  const before = prev === undefined && isObj(value) ? {} : prev
  if (had === null || !isObj(before) || !isObj(value)) {
    sections.set(name, null)
    return
  }
  const fields = had ?? new Set<string>()
  for (const k of new Set([...Object.keys(before), ...Object.keys(value)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(value[k])) fields.add(k)
  }
  sections.set(name, fields)
}

/** Write one section: memory and cache at once, backend after `SETTLE_MS` of quiet. */
export function viewSet(db: string, name: string, value: unknown): void {
  // Mid-switch the writer is the old canvas tidying up; its model is not this workspace's.
  if (switching) return
  const cur = viewSync(db)
  markDirty(db, name, cur[name], value)
  const next = { ...cur, [name]: value }
  live.set(db, next)
  try {
    localStorage.setItem(cacheKey(db), JSON.stringify(next))
  } catch {
    /* quota — the backend still gets it */
  }
  emit(db)
  const t = timers.get(db)
  if (t) clearTimeout(t)
  timers.set(
    db,
    setTimeout(() => put(db), SETTLE_MS)
  )
}

/**
 * Point this module at a model's new name, right after the backend renamed it.
 *
 * The 400 ms debounce is the reason this exists: a layout write still waiting in it fires under the
 * OLD name — a `PUT /views/<gone>` for a model that no longer exists, and a cache key under it that
 * the startup prune then has to clean up (both seen in the running app while the rename was built).
 * Moving the pending write instead of dropping it also keeps the last arrangement, which is what the
 * user just did and would otherwise be the one thing a rename lost.
 */
export function renameCachedView(from: string, to: string): void {
  if (!from || !to || from === to) return
  const pending = timers.get(from)
  if (pending) {
    clearTimeout(pending)
    timers.delete(from)
  }
  const view = live.get(from)
  if (view !== undefined) {
    // Renamed before the pending write below goes out: the canvas keys name the model.
    live.set(to, (renameDatabaseInView(view, from, to) as ModelView | null) ?? view)
    live.delete(from)
  }
  if (fetched.has(from)) {
    fetched.delete(from)
    fetched.add(to)
  }
  if (hydrated.has(from)) {
    hydrated.delete(from)
    hydrated.add(to)
  }
  // Unacknowledged writes follow the name; a bumped counter tells a PUT still out under the old name
  // that its answer no longer describes them.
  const marks = dirty.get(from)
  dirty.delete(from)
  revs.delete(from)
  sentRev.delete(from)
  if (marks) {
    dirty.set(to, marks)
    revs.set(to, (revs.get(to) ?? 0) + 1)
  }
  try {
    const raw = localStorage.getItem(cacheKey(from))
    // The renamed copy when there is one in memory: the loop below finds nothing left to rename in it, so
    // copying the old text here kept the canvas keys of the old name in the cache.
    const moved = view !== undefined ? live.get(to) : undefined
    if (moved !== undefined) localStorage.setItem(cacheKey(to), JSON.stringify(moved))
    else if (raw != null) localStorage.setItem(cacheKey(to), raw)
    localStorage.removeItem(cacheKey(from))
  } catch {
    /* localStorage optional */
  }
  if (pending || marks) put(to) // the write that was waiting belongs to the new name now
  emit(to)
  // Every other model's view may compare a process of the renamed one. The backend rewrote the stored
  // views; the copies held here follow, or a write still pending would send the old name back.
  const others = new Set<string>(live.keys())
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith('prism.view.')) others.add(k.slice('prism.view.'.length))
    }
  } catch {
    /* localStorage optional */
  }
  for (const db of others) {
    const cur = live.get(db) ?? readCache(db)
    const next = cur ? renameDatabaseInView(cur, from, to) : null
    if (!next) continue
    if (live.has(db)) live.set(db, next)
    try {
      localStorage.setItem(cacheKey(db), JSON.stringify(next))
    } catch {
      /* quota */
    }
    emit(db)
    // A write of this view that went out between the server's rename and this call carried the old
    // name back; send the corrected copy after it. Only for a view the server has answered for here —
    // a cache-only copy may be older than what the server holds, and the server renamed that itself.
    if (live.has(db) && hydrated.has(db)) {
      // A write like any other: marked and counted, so a PUT already out for this model cannot clear
      // the marks when it lands, and a corrected copy that fails is sent again.
      for (const name of new Set([...Object.keys(cur ?? {}), ...Object.keys(next)])) {
        if (JSON.stringify(cur?.[name]) !== JSON.stringify(next[name])) {
          markDirty(db, name, cur?.[name], next[name])
        }
      }
      put(db)
    }
  }
}

/** Send every pending write now — on model switch, page change and window close. That includes a
 *  write whose PUT failed earlier: it has no timer any more, but it is still marked. */
export function flushViews(): void {
  const due = new Set(timers.keys())
  for (const db of dirty.keys()) if (sentRev.get(db)?.rev !== (revs.get(db) ?? 0)) due.add(db)
  for (const db of due) put(db)
}

/** Dispatched on `window` when everything should be saved at once: an open canvas answers it by
 *  writing its layout (useCanvasModel), the way it does when the window closes. */
export const SAVE_NOW_EVENT = 'prism:save-views-now'

/**
 * Save every view while the backend still runs, and wait for the writes to land. Main asks for this
 * before it stops the backend for an update: the usual
 * departure save happens on `beforeunload`, which an install reaches only after the backend is gone —
 * the PUT failed and the next start replaced the cached layout with the older one on the server.
 */
export async function saveViewsNow(): Promise<void> {
  window.dispatchEvent(new Event(SAVE_NOW_EVENT))
  flushViews()
  await Promise.allSettled(Array.from(inFlightPuts))
}

/**
 * Drop everything this module holds for a model that has just been deleted.
 *
 * The debounce is the reason, as with the rename: a layout write still waiting in it would fire after
 * the delete — a `PUT /views/<gone>` that the backend now refuses (404) but that used to be stored,
 * leaving an entry under a name nothing can reach again. Cancelling it here means the request is never
 * made; the cache key goes too, so the startup prune has nothing to find.
 */
export function forgetView(db: string): void {
  const pending = timers.get(db)
  if (pending) clearTimeout(pending)
  timers.delete(db)
  live.delete(db)
  fetched.delete(db)
  hydrated.delete(db)
  listeners.delete(db)
  dirty.delete(db)
  revs.delete(db)
  sentRev.delete(db)
  try {
    localStorage.removeItem(cacheKey(db))
  } catch {
    /* localStorage optional */
  }
}

/**
 * Ask the backend for a model's view, and hand it the local one if it has none yet.
 *
 * That second half is the whole migration: on first open per model, an arrangement that only this
 * browser knew about is uploaded once. Returns what to draw, so the caller can await it before
 * building the graph.
 */
//: One fetch per model at a time: the nineteen useViewField call sites of a results page all
//: notice the missing model in the same render, and each used to be a candidate for its own
//: round trip.
const inflight = new Map<string, Promise<ModelView>>()

export async function viewFetch(db: string): Promise<ModelView> {
  const running = inflight.get(db)
  if (running) return running
  const job = _viewFetch(db).finally(() => inflight.delete(db))
  inflight.set(db, job)
  return job
}

async function _viewFetch(db: string): Promise<ModelView> {
  const asked = generation
  try {
    const r = await api<{ view: ModelView }>('GET', `/api/v1/views/${encodeURIComponent(db)}`)
    // Asked in the workspace left behind: the answer is that workspace's, not this one's.
    if (asked !== generation || switching) return {}
    const answer = r?.view ?? {}
    hydrated.add(db)
    // What the user set while the GET was out stays set: the answer replaced the live state whole, the
    // pending PUT then read that reset state, and a baseline switched off during the round trip came
    // back on and was saved so. The write timer keeps running and sends the merge.
    const local = live.get(db) ?? {}
    const stored: ModelView = { ...answer }
    // A server that holds nothing yet is the migration case below: merging a dirty field into an
    // empty section would upload that field alone and drop the cached rest of the section.
    for (const [name, fields] of Object.keys(answer).length ? (dirty.get(db) ?? []) : []) {
      if (!(name in local)) continue
      if (fields === null || !isObj(local[name])) {
        stored[name] = local[name]
        continue
      }
      // Only the fields written here; the rest of the section is the server's.
      const mine = local[name] as Record<string, unknown>
      const merged: Record<string, unknown> = isObj(answer[name]) ? { ...answer[name] } : {}
      for (const f of fields) {
        if (f in mine) merged[f] = mine[f]
        else delete merged[f]
      }
      stored[name] = merged
    }
    if (Object.keys(stored).length) {
      live.set(db, stored)
      try {
        localStorage.setItem(cacheKey(db), JSON.stringify(stored))
      } catch {
        /* quota */
      }
      emit(db)
    } else {
      const local = viewSync(db)
      if (Object.keys(local).length) put(db) // one-time migration of this browser's arrangement
    }
  } catch {
    /* unreachable: draw from the cache rather than from nothing */
  }
  fetched.add(db)
  return viewSync(db)
}

/**
 * Wait until the backend's answer for this model's view is in memory; `true` when it is, `false` when
 * the backend could not be reached. A fetch already running is waited for first — its answer may be
 * newer than an earlier one — and only a real answer counts: a failed GET also marks the model as
 * `fetched`, and a decision written from the cache then would overwrite the stored view with it.
 */
export async function viewLoaded(db: string): Promise<boolean> {
  const running = inflight.get(db)
  if (running) await running
  if (hydrated.has(db)) return true
  await viewFetch(db)
  return hydrated.has(db)
}

/**
 * One section of one model's view, with the signature of `usePersisted` so call sites read the same.
 *
 * The subscription matters: the canvas and the panels write different sections of the same entry, and
 * a component that cached a stale copy would send it back on its next write.
 */
export function useViewSection<T>(
  db: string | null,
  name: string,
  initial: T
): [T, (next: T | ((prev: T) => T)) => void] {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!db) return
    const set = listeners.get(db) ?? new Set()
    const fn = (): void => bump((n) => n + 1)
    set.add(fn)
    listeners.set(db, set)
    // Self-sufficient: whoever reads a model's view makes sure it is fetched. Switching the model
    // while on the Results page left every panel on empty defaults until the CANVAS — the only
    // caller of viewFetch — happened to mount for the new model. The emit at
    // the end of the fetch re-renders this subscriber with the stored values.
    if (!fetched.has(db)) void viewFetch(db)
    return () => {
      set.delete(fn)
    }
  }, [db])

  const raw = db ? (viewSync(db)[name] as T | undefined) : undefined
  const value = raw === undefined ? initial : raw

  const setValue = useCallback(
    (next: T | ((prev: T) => T)): void => {
      if (!db) return
      const prev = (viewSync(db)[name] as T | undefined) ?? initial
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next
      viewSet(db, name, resolved)
    },
    // `initial` is a fresh literal at most call sites; including it would rebuild this every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [db, name]
  )

  return [value, setValue]
}

/**
 * One field inside one section, with the signature of `usePersisted` — the drop-in for the panels.
 *
 * Field-level rather than section-level because the call sites are field-level: nineteen separate
 * `[value, setValue]` pairs across Results and Detailed results. They all land in the same section
 * object, so the whole setup travels as one thing and one debounced write carries the lot.
 */
export function useViewField<T>(
  db: string | null,
  sectionName: string,
  field: string,
  initial: T
): [T, (next: T | ((prev: T) => T)) => void] {
  const [sec, setSec] = useViewSection<Record<string, unknown>>(db, sectionName, {})
  const raw = sec?.[field] as T | undefined
  const value = raw === undefined ? initial : raw
  const setValue = useCallback(
    (next: T | ((prev: T) => T)): void => {
      setSec((prev) => {
        const cur = (prev?.[field] as T | undefined) ?? initial
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(cur) : next
        return { ...(prev ?? {}), [field]: resolved }
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setSec, field]
  )
  return [value, setValue]
}
