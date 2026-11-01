import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { useViewField } from '../../lib/modelView'
import type { JobSnapshot } from './types'

/** How often a running job is asked for its progress. A step takes seconds; once a second is plenty. */
const POLL_MS = 1000

/**
 * One card's sensitivity job: start it, follow its progress, cancel it, and hand the answer over.
 *
 * The job runs in the backend (engine/sensitivity_jobs.py), so it does not stop when the page does. Its id
 * is kept with the model's view: leave for another model and come back, and the card picks the run up
 * where it is — or reads its answer, if it finished meanwhile — instead of offering to start it again.
 */
export function useSensitivityJob<R>(
  activeDb: string | null,
  kind: 'tornado' | 'curve',
  onDone: (result: R, job: JobSnapshot<R>, key: string) => void
): {
  job: JobSnapshot<R> | null
  error: string | null
  /** `key` names the settings the run is for; it comes back with the answer (see `StoredRun.key`). */
  start: (body: unknown, key: string) => Promise<void>
  cancel: () => void
  clearError: () => void
} {
  // The running job and the settings it was started with, kept together: the answer may arrive after a
  // remount, when nothing but the stored view remembers what was asked.
  const [running, setRunning] = useViewField<{ id: string; key: string } | null>(
    activeDb,
    'sensitivity',
    `${kind}Job`,
    null
  )
  const jobId = running?.id ?? ''
  const jobKey = running?.key ?? ''
  const [job, setJob] = useState<JobSnapshot<R> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    if (!jobId) {
      setJob(null)
      return
    }
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const snap = await api<JobSnapshot<R>>(
          'GET',
          `/api/v1/calc/sensitivity/jobs/${encodeURIComponent(jobId)}?result=true`
        )
        if (!alive) return
        if (snap.state === 'running') {
          setJob(snap)
          return
        }
        setRunning(null)
        setJob(null)
        if (snap.state === 'done' && snap.result) done.current(snap.result, snap, jobKey)
        else if (snap.state !== 'cancelled') setError(snap.error ?? 'The run stopped without an answer.')
      } catch (e) {
        if (!alive) return
        // Kept for an hour after it finished, then forgotten: nothing left to pick up.
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) setRunning(null)
        else setError(e instanceof Error ? e.message : String(e))
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [jobId, jobKey, setRunning])

  const start = useCallback(
    async (body: unknown, key: string) => {
      setError(null)
      try {
        const snap = await api<JobSnapshot<R>>('POST', '/api/v1/calc/sensitivity/jobs', {
          kind,
          [kind]: body
        })
        setJob(snap)
        setRunning({ id: snap.job_id, key })
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [kind, setRunning]
  )

  const cancel = useCallback(() => {
    if (!jobId) return
    // The bar stays until the job says it stopped: a step in flight finishes first, and its restore with it.
    void api('POST', `/api/v1/calc/sensitivity/jobs/${encodeURIComponent(jobId)}/cancel`).catch(() => {})
  }, [jobId])

  return { job, error, start, cancel, clearError: () => setError(null) }
}
