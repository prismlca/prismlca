/**
 * The status line of a background import with a progress bar, the time it has been running and, while
 * the backend can still stop it, a Cancel button. The bar is determinate while the backend can say how far
 * it is (ecoinvent counts the datasets it has read, BAFU reads file by file) and indeterminate otherwise.
 * Shared by the import wizard and the Background panel so both show the same thing.
 *
 * `trouble` comes from following the job (views/useImportJob.ts): while requests fail the last status stays
 * up with a note under it; once the engine has stopped, the step it stopped at and what to do replace the
 * bar, the clock and Cancel — none of them would move again.
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

/** Why the job cannot be followed right now. `final`: the engine has stopped; nothing answers until a restart. */
export interface ImportTrouble {
  message: string
  final: boolean
}

export default function ImportProgress({
  status,
  trouble,
  onCancel
}: {
  status: ImportStatus
  trouble?: ImportTrouble | null
  /** Asks the backend to stop; the parent keeps polling until the state says `cancelled`. */
  onCancel?: () => Promise<void>
}): JSX.Element | null {
  const [cancelling, setCancelling] = useState(false)
  const [now, setNow] = useState<number | null>(null)
  const stopped = trouble?.final === true
  const running = status.state === 'running' && !stopped
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
  if (stopped) {
    return (
      <div className="setup-status error" role="alert">
        <div className="setup-status-line">
          <strong>{status.step}</strong>
          {status.detail ? <span> — {status.detail}</span> : null}
        </div>
        <p className="setup-status-note">{trouble.message}</p>
      </div>
    )
  }
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
      {trouble ? <p className="setup-status-note">{trouble.message}</p> : null}
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
