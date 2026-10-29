/**
 * The time a search-index build has left, for the line under its progress bar. Recomputed on every
 * progress step from the rate seen so far, and per database: after an import ecoinvent's activities are
 * indexed first and the biosphere's flows after them, and an estimate across both would have to guess
 * a phase that has not started.
 */
import { useEffect, useRef, useState } from 'react'
import type { IndexBuildStatus } from '../workbench/useSearchIndexStatus'

interface Sample {
  database: string
  at: number
  count: number
}

/** Seconds left, or null while too little has happened to say: the first seconds and the first per
 *  cent carry the model loading and would promise a time that never comes. */
export function etaSeconds(start: Sample, now: { at: number; count: number }, total: number): number | null {
  const done = now.count - start.count
  const elapsed = (now.at - start.at) / 1000
  if (done <= 0 || elapsed < 20 || now.count < total * 0.01) return null
  return (elapsed / done) * Math.max(0, total - now.count)
}

export function etaLabel(seconds: number | null): string {
  if (seconds === null) return 'estimating…'
  if (seconds < 60) return 'less than a minute left'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} min left`
  return `about ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min left`
}

/** The label for the running build, or null when none runs. */
export function useIndexEta(status: IndexBuildStatus | null): string | null {
  const start = useRef<Sample | null>(null)
  const [label, setLabel] = useState<string | null>(null)
  const running = status?.state === 'running' && status.total > 0
  const database = status?.database ?? ''
  const count = status?.count ?? 0
  const total = status?.total ?? 0
  useEffect(() => {
    if (!running) {
      start.current = null
      setLabel(null)
      return
    }
    const now = { at: Date.now(), count }
    const s = start.current
    if (!s || s.database !== database || count < s.count) {
      start.current = { database, ...now }
      setLabel(etaLabel(null))
      return
    }
    setLabel(etaLabel(etaSeconds(s, now, total)))
  }, [running, database, count, total])
  return label
}
