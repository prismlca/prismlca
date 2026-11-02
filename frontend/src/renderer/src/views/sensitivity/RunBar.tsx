import { CalculatorIcon } from '../../components/icons'
import { fmtDuration, fmtWhen, type RunState } from './helpers'
import type { JobSnapshot, StoredRun } from './types'

/**
 * The foot row of a sensitivity card, under its chart: Calculate, or — while the card's job runs — its
 * progress bar, the step it is on and Cancel. Each card has its own, with the chart it fills: the two runs have
 * different settings and their own progress, and a button for one of them in the rail's foot was a button
 * looked for.
 */
export function RunBar({
  job,
  canRun,
  hint,
  state,
  stored,
  error,
  onRun,
  onCancel
}: {
  job: JobSnapshot<unknown> | null
  canRun: boolean
  /** Why Calculate is greyed — shown in its place, so the button never looks like a missing feature. */
  hint: string
  state: RunState
  stored: StoredRun<unknown> | null
  error: string | null
  onRun: () => void
  onCancel: () => void
}): JSX.Element {
  if (job) {
    const { done, total, label } = job.progress
    return (
      <div className="calcbar sens-run sens-foot-row">
        <span className="spinner" />
        <div className="calc-progress-bar">
          <span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
        </div>
        <button className="btn sm" onClick={onCancel}>
          Cancel
        </button>
        <span className="calc-progress-label">{total ? `${label} · ${done}/${total}` : label}</span>
      </div>
    )
  }
  const status = !canRun
    ? hint
    : state === 'none'
      ? 'Ready — click Calculate.'
      : state === 'settings'
        ? 'Settings changed — the chart shows the last run.'
        : state === 'model'
          ? 'The model changed since this run — calculate again.'
          : stored
            ? `Computed ${fmtWhen(stored.startedAt)}${stored.seconds != null ? ` in ${fmtDuration(stored.seconds)}` : ''}.${
                state === 'unknown' ? ' Could not check whether the model changed since.' : ''
              }`
            : ''
  return (
    <div className="sens-foot-row">
      <div className="calcbar sens-run">
        <span className={`calc-stale${state === 'model' || state === 'settings' ? ' sens-stale' : ''}`}>
          {status}
        </span>
        <button className="btn primary" disabled={!canRun} onClick={onRun}>
          <CalculatorIcon /> Calculate
        </button>
      </div>
      {error ? <p className="sens-error">{error}</p> : null}
    </div>
  )
}
