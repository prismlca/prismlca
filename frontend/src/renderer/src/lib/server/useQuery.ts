/**
 * A small shared read cache for the registered GET routes — exactly what the views were each
 * hand-rolling, and nothing more.
 *
 * What it replaces, measured before the change: six endpoints fetched independently by up to seven
 * call sites each (`databases` ×7, `calc/methods` ×5 — two of them inside JSX callbacks —,
 * `tag-groups` ×4, `unit-vocabulary` ×4 with two private caching strategies, `scenarios`/
 * `activities`/`study` ×3), and fifteen stale-response guards in three styles (`runSeq` counters,
 * `genRef`s, `let alive = true`). One view editing tag groups left every other view's copy stale
 * until remount.
 *
 * Deliberately not a data framework: no TTL, no retries, no persistence. Freshness is event-driven
 * — a mutation calls `invalidate(prefix)`, mounted `useQuery` subscribers refetch, imperative
 * readers get a fresh fetch on their next call. Data survives invalidation until the refetch lands
 * (stale-while-refetch), so lists do not blink out under the user.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { api } from '../api'
import type { GetRoutes, RouteKey } from './routes'

interface Entry {
  data: unknown
  error: unknown
  /** False after `invalidate` — data may still be shown, but the next reader refetches. */
  clean: boolean
  /** Bumped by `invalidate`; a response carrying an older generation is not stored. */
  gen: number
  promise: Promise<unknown> | undefined
  /** Bumped on every visible change; what `useSyncExternalStore` snapshots. */
  version: number
  subs: Set<() => void>
}

const entries = new Map<string, Entry>()

function entry(key: string): Entry {
  let e = entries.get(key)
  if (!e) {
    e = {
      data: undefined,
      error: undefined,
      clean: false,
      gen: 0,
      promise: undefined,
      version: 0,
      subs: new Set()
    }
    entries.set(key, e)
  }
  return e
}

function notify(e: Entry): void {
  e.version++
  for (const fn of e.subs) fn()
}

/**
 * Mark every cached route starting with `prefix` stale and tell its subscribers.
 *
 * Called from the mutation success paths (beside the existing `modelRev` bump and the `onChanged`
 * chains, which stay — this step adds the cache to the one truth, it does not replace the bus).
 */
export function invalidate(prefix: string): void {
  for (const [key, e] of entries) {
    if (!key.startsWith(prefix)) continue
    e.gen++
    e.clean = false
    e.error = undefined // an invalidate is the one thing that retries a failed read
    e.promise = undefined
    notify(e)
  }
}

/**
 * Read a registered route through the cache — the imperative twin of `useQuery`, for code that
 * needs the value inside a callback (Workbench's load paths). Concurrent callers share one request;
 * a response that an `invalidate` overtook is returned to its caller (it is a genuine server answer
 * from after the call began) but not stored.
 */
export function fetchQuery<P extends RouteKey>(path: P): Promise<GetRoutes[P]> {
  const e = entry(path)
  if (e.clean && e.promise === undefined) return Promise.resolve(e.data as GetRoutes[P])
  if (e.promise) return e.promise as Promise<GetRoutes[P]>
  const gen = e.gen
  const p = api<GetRoutes[P]>('GET', path).then(
    (data) => {
      if (entry(path).gen === gen) {
        const cur = entry(path)
        cur.data = data
        cur.error = undefined
        cur.clean = true
        cur.promise = undefined
        notify(cur)
      }
      return data
    },
    (err) => {
      const cur = entry(path)
      if (cur.gen === gen) {
        cur.error = err
        cur.promise = undefined
        notify(cur)
      }
      throw err
    }
  )
  e.promise = p
  return p
}

/** What a component sees: the (possibly stale-while-refetching) data, the last error, a reload. */
export interface QueryState<T> {
  data: T | undefined
  /** `data` is the answer to a request made after the last `invalidate` — not a list kept on show
   *  while the refetch is out. Showing stale data is the point of the cache; deciding on it is not:
   *  whatever drops stored state because it is missing from `data` waits for this. */
  fresh: boolean
  error: unknown
  reload: () => void
}

/**
 * Subscribe a component to a registered route. `null` means "nothing to load yet" (no model
 * selected) — the hook then holds `undefined` and fetches nothing. The stale-response problem the
 * fifteen hand-rolled guards solved disappears structurally: responses are keyed and generation-
 * checked in the cache, so a late answer for an old key cannot reach a component that moved on.
 */
export function useQuery<P extends RouteKey>(path: P | null): QueryState<GetRoutes[P]> {
  const e = path === null ? null : entry(path)
  useSyncExternalStore(
    (onChange) => {
      if (!e) return () => undefined
      e.subs.add(onChange)
      return () => e.subs.delete(onChange)
    },
    () => (e ? e.version : 0)
  )
  useEffect(() => {
    // A failed read stays failed until something invalidates it. Without the `error` guard this
    // effect refetched on its own failure: the rejection bumped the version, the version re-ran the
    // effect, the effect fetched again — a hot loop of requests against a 404, and in a test whose
    // fake API rejects synchronously a promise chain that never yields to a timer, so the test file
    // hung without a word (CanvasChat.dom.test, 2026-09-06, the first `useQuery` on a route the
    // harness does not answer).
    if (path !== null && !entry(path).clean && entry(path).error === undefined) {
      void fetchQuery(path).catch(() => undefined)
    }
    // Re-runs when the entry changes (version): an `invalidate` leaves clean=false, and the
    // subscriber that noticed is the one that triggers the refetch.
  }, [path, e?.version])
  return {
    // Stale-while-refetch: the last data stays visible until the refetch lands.
    data: e?.data as GetRoutes[P] | undefined,
    // Changes only together with a version bump (fetch landed, invalidate), so the render is current.
    fresh: !!e?.clean,
    error: e?.error,
    reload: () => {
      if (path !== null) {
        invalidate(path)
        void fetchQuery(path).catch(() => undefined)
      }
    }
  }
}

/** Test hook (same precedent as main/settings.ts `resetSettingsCache`): the module cache outlives
 *  a component between mounts — which is its job — so a test that asserts mount-time loading has to
 *  start from a cold cache. */
export function resetQueryCache(): void {
  entries.clear()
  slots.clear()
}

// --- latest-wins slots -------------------------------------------------------------------------

const slots = new Map<string, number>()

/**
 * Run an async job in a named slot; if a newer job starts in the same slot before this one lands,
 * the result is withheld (`undefined`). This is the generation guard as a helper — for imperative
 * flows that are not cache reads, like the canvas graph: switching the active model twice in quick
 * succession used to let the slower, older graph response paint over the newer model (open finding
 * #7, "Modellwechsel-Supersession").
 */
export async function latestOnly<T>(slot: string, run: () => Promise<T>): Promise<T | undefined> {
  const ticket = (slots.get(slot) ?? 0) + 1
  slots.set(slot, ticket)
  const value = await run()
  return slots.get(slot) === ticket ? value : undefined
}
