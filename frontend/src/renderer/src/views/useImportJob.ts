/**
 * Following the background import job (GET /setup/status) — one loop for the import wizard and the
 * Background data sheet, which used to carry a copy each.
 *
 * - **A failed request does not end it.** The next request used to be scheduled only after an answer,
 *   so one failure froze the view mid-import without a word. Now a failure is retried with growing
 *   pauses; after a few in a row the view says it has lost contact and keeps trying.
 * - **Only an engine that has stopped ends it.** After a failure the hook asks the main process whether
 *   the backend process has ended. Nothing starts it again, so then the view says what happened and that
 *   only a restart helps, instead of showing the last step forever.
 * - **A running job is found on opening.** The job runs in the backend whichever view started it; a view
 *   that opens while one runs (after a reload, or a job started in the other view) follows it.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { ipcErrorReason, type BackendExit } from '../../../shared/ipc'
import type { ImportStatus, ImportTrouble } from '../components/ImportProgress'

/** The pause between two requests while the job runs. */
export const POLL_MS = 1500
/** The pauses after the 1st, 2nd, 3rd … failed request in a row; the last one repeats. */
export const RETRY_MS = [1500, 3000, 5000, 10_000]
/** From this many failures in a row on, the view says it has lost contact. */
export const SAY_AFTER_FAILURES = 3

export interface ImportJob {
  /** The job's last known status: null until this view started one or found one running when it opened. */
  status: ImportStatus | null
  trouble: ImportTrouble | null
  /** Follow the job this view has just started; `started` is the start request's answer. */
  follow: (started?: ImportStatus) => void
}

/** What the user is told once the engine has stopped under a running job. */
export function stoppedMessage(last: ImportStatus | null, exit: BackendExit): string {
  const oom = exit.signal === 'SIGKILL'
  const how = oom
    ? ': the system ended it, most likely because the computer ran out of memory'
    : exit.signal
      ? ` (${exit.signal})`
      : ` (exit code ${exit.code})`
  const restart = oom
    ? 'Restart PrismLCA to go on, and close other programs before you import again.'
    : 'Restart PrismLCA to go on.'
  const writing =
    last?.step === 'writing'
      ? ' It was writing the database at the time: if the next import stops because the database “exists' +
        ' but is empty — a previous import was interrupted”, remove that database under Background data' +
        ' (Remove… on its card) and import again.'
      : ''
  return `PrismLCA's engine stopped during the import${how}. ${restart}${writing}`
}

/** What the user is told while requests fail and the engine still runs. */
export function unansweredMessage(e: unknown): string {
  return `PrismLCA's engine is not answering (${ipcErrorReason(e, 'no reply')}) — still trying.`
}

async function backendExit(): Promise<BackendExit | null> {
  try {
    return (await window.prism.backendExit()) ?? null
  } catch {
    return null
  }
}

/**
 * `onSettled` runs once with the final status when a followed job ends (done, error, cancelled) — not when
 * the engine stops under it, and not for a job that had already ended when the view opened.
 */
export function useImportJob(onSettled: (st: ImportStatus) => void | Promise<void>): ImportJob {
  const [status, setStatus] = useState<ImportStatus | null>(null)
  const [trouble, setTrouble] = useState<ImportTrouble | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const mounted = useRef(false)
  // Every follow() starts a new loop; an answer that belongs to an older one is dropped.
  const loop = useRef(0)
  const failures = useRef(0)
  const last = useRef<ImportStatus | null>(null)
  const settled = useRef(onSettled)
  settled.current = onSettled

  /** One request of loop `n`. `looking`: the check on opening — it adopts a running job, leaves one
   *  that has ended alone, and says nothing about trouble, as no job of its own is on screen yet. */
  const tick = useCallback(async (n: number, looking = false): Promise<void> => {
    const stale = (): boolean => !mounted.current || loop.current !== n
    let st: ImportStatus
    try {
      st = await api<ImportStatus>('GET', '/api/v1/setup/status')
    } catch (e) {
      if (stale()) return
      const exit = await backendExit()
      if (stale()) return
      if (exit) {
        if (!looking) setTrouble({ message: stoppedMessage(last.current, exit), final: true })
        return
      }
      failures.current += 1
      if (!looking && failures.current >= SAY_AFTER_FAILURES) {
        setTrouble({ message: unansweredMessage(e), final: false })
      }
      const pause = RETRY_MS[Math.min(failures.current, RETRY_MS.length) - 1]
      timer.current = setTimeout(() => void tick(n, looking), pause)
      return
    }
    if (stale()) return
    failures.current = 0
    if (looking && st.state !== 'running') return
    last.current = st
    setTrouble(null)
    setStatus(st)
    if (st.state === 'running') timer.current = setTimeout(() => void tick(n), POLL_MS)
    else await settled.current(st)
  }, [])

  const follow = useCallback(
    (started?: ImportStatus) => {
      clearTimeout(timer.current)
      const n = ++loop.current
      failures.current = 0
      setTrouble(null)
      if (started) {
        last.current = started
        setStatus(started)
      }
      void tick(n)
    },
    [tick]
  )

  // On opening: a job that is running already is followed; one that has ended belongs to whoever saw
  // it end. A failed check is tried again like any request — a view that gave up here would miss a
  // job for good — and an engine that has stopped is left to the view's own loading to report.
  useEffect(() => {
    mounted.current = true
    void tick(loop.current, true)
    return () => {
      mounted.current = false
      // Retires whatever loop is in flight — also the check above when StrictMode mounts twice.
      loop.current += 1
      clearTimeout(timer.current)
    }
  }, [tick])

  return { status, trouble, follow }
}
