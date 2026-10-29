import { useSyncExternalStore } from 'react'

/**
 * Which reports have a "Write all" run in flight, by the report's API base.
 *
 * The run lives in the main process and outlives the chapter panel that started it: pick "—" in the report
 * list and the panel unmounts, pick the report again and the new panel knows nothing of a run that is still
 * writing chapters into it. Counted here, at module level, by `aiWriteAll` itself — so whatever asks "may this
 * report be deleted?" gets an answer that does not depend on which component happens to be mounted.
 */
const running = new Map<string, number>()
const listeners = new Set<() => void>()

const notify = (): void => listeners.forEach((l) => l())

/** The API base of a stored report — the key the runs are counted under. */
export const reportBase = (database: string, reportId: string): string =>
  `/api/v1/report/one/${encodeURIComponent(database)}/${encodeURIComponent(reportId)}`

/** Count a run for `base` until `done` settles. */
export function trackWriteAll<T>(base: string, done: Promise<T>): Promise<T> {
  running.set(base, (running.get(base) ?? 0) + 1)
  notify()
  return done.finally(() => {
    const left = (running.get(base) ?? 1) - 1
    if (left > 0) running.set(base, left)
    else running.delete(base)
    notify()
  })
}

export function isWritingAll(base: string): boolean {
  return running.has(base)
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Whether a "Write all" run is writing into this report right now; '' asks about no report. */
export function useWritingAll(base: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (base ? running.has(base) : false),
    () => false
  )
}
