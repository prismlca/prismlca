/**
 * The status line of a background import with a progress bar, the time it has been running and, while
 * the backend can still stop it, a Cancel button. The bar is determinate while the backend can say how far
 * it is (ecoinvent counts the datasets it has read, BAFU reads file by file) and indeterminate otherwise.
 * Shared by the import wizard and the Background panel so both show the same thing.
 */
import { useEffect, useState } from 'react'
import { elapsedLabel } from '../lib/report/writeStatus'

export interface ImportStatus {
  state: string // idle | running | done | error | cancelled
  step: string
  detail: string
  project?: string | null
  database?: string | null
  /** 0–1 while measurable; null/undefined = running without a measure. */
  progress?: number | null
  /** True while POST /setup/cancel can still stop the job (the ecoinvent import until it writes). */
  cancellable?: boolean
  /** Epoch seconds the job started at. */
  started_at?: number | null
}

export default function ImportProgress({
  status,
  onCancel
}: {
  status: ImportStatus
  /** Asks the backend to stop; the parent keeps polling until the state says `cancelled`. */
  onCancel?: () => Promise<void>
}): JSX.Element | null {
  const [cancelling, setCancelling] = useState(false)
  const [now, setNow] = useState<number | null>(null)
  const running = status.state === 'running'
  useEffect(() => {
    if (!running) {
      setCancelling(false)
      return
    }
    const tick = (): void => setNow(Date.now() / 1000)
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [running])
  if (status.state === 'idle') return null
  const pct = typeof status.progress === 'number' ? Math.max(0, Math.min(1, status.progress)) : null
  const elapsed = running && status.started_at && now !== null ? now - status.started_at : null
  const cancel = async (): Promise<void> => {
    setCancelling(true)
    try {
      await onCancel!()
    } catch {
      setCancelling(false) // the write has begun meanwhile; the next poll hides the button
    }
  }
  return (
    <div className={`setup-status ${status.state}`} role="status">
      <div className="setup-status-line">
        <strong>{status.step}</strong>
        {status.detail ? <span> — {status.detail}</span> : null}
      </div>
      {running || status.state === 'done' ? (
        <div
          className={`setup-progress${pct === null && running ? ' indeterminate' : ''}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct === null ? undefined : Math.round(pct * 100)}
          aria-label="Import progress"
        >
          <i style={pct === null ? undefined : { width: `${Math.round(pct * 100)}%` }} />
          {pct !== null ? <span className="setup-progress-pct">{Math.round(pct * 100)} %</span> : null}
        </div>
      ) : null}
      {elapsed !== null || (running && status.cancellable && onCancel) ? (
        <div className="setup-status-foot">
          {elapsed !== null ? <span className="muted">Running for {elapsedLabel(elapsed)}</span> : null}
          {running && status.cancellable && onCancel ? (
            <button className="btn" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel import'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
