import { useEffect, useRef, useState } from 'react'
import EscapeCloser from './EscapeCloser'
import {
  planProgress,
  RESUMABLE_OUTCOMES,
  type ChatPlan,
  type ChatRun,
  type PlanStepStatus,
  type RunOutcome
} from '../../../shared/plan'

/**
 * The assistant's plan beside the chat dock, and the Continue button of a stopped run. Read-only: the
 * plan belongs to the model, and the user changes it by saying so in the chat — ticks set here would pull
 * what is shown apart from what the model knows.
 */

/** The text a stopped run is labelled with — in the card header, the pill's tooltip, the transcript. */
export function runReason(outcome: RunOutcome | undefined): string {
  switch (outcome) {
    case 'rounds':
      return 'Stopped: round limit'
    case 'cost':
      return 'Stopped: cost limit'
    case 'repetition':
      return 'Stopped: the reply kept repeating itself'
    case 'stalled':
      return 'Stopped: the tool calls kept failing'
    case 'empty':
      return 'Stopped: the model returned nothing'
    case 'output_limit':
      return 'Stopped: output limit'
    case 'cancelled':
      return 'Stopped by you'
    case 'error':
      return 'Stopped: an error'
    case 'interrupted':
      return 'PrismLCA was closed during the run'
    default:
      return 'Stopped'
  }
}

/** A run that stopped short and may be picked up again — the condition for offering Continue. */
export function resumable(run: ChatRun | null | undefined): run is ChatRun & { outcome: RunOutcome } {
  return (
    !!run &&
    (run.state === 'stopped' || run.state === 'interrupted') &&
    !!run.outcome &&
    RESUMABLE_OUTCOMES.has(run.outcome)
  )
}

export const CONTINUE_PLAN = 'Continue with the plan.'
export const CONTINUE_FREE = 'Continue where you stopped.'

const usd = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2))

/**
 * "Continue" — a normal, visible user message through the ordinary send path. After a cost stop
 * it asks twice: the first click names the amount it will allow ("Spend up to another $5"), the
 * second sends. The confirmation is bound to the run and the limit, so a new stop re-arms it, and a
 * double click cannot send twice.
 */
export function ContinueButton({
  run,
  hasPlan,
  disabled,
  fallbackLimit,
  onContinue
}: {
  run: ChatRun & { outcome: RunOutcome }
  hasPlan: boolean
  disabled: boolean
  /**
   * The chat's CURRENT cost limit (Settings → AI). It is what the next run will be stopped against, so
   * it is what the confirmation names — not the limit the stopped run recorded, which the user may have
   * raised since. The recorded one is only the fallback for a chat without settings.
   */
  fallbackLimit: number
  onContinue: (text: string) => void
}): JSX.Element {
  const limit = fallbackLimit > 0 ? fallbackLimit : (run.costLimitUsd ?? 0)
  const key = `${run.runId}:${limit}`
  const [armed, setArmed] = useState<string | null>(null)
  const sent = useRef<string | null>(null)
  const isArmed = run.outcome === 'cost' && armed === key
  return (
    <button
      type="button"
      className={`plan-continue${isArmed ? ' armed' : ''}`}
      disabled={disabled}
      title={
        run.outcome === 'cost'
          ? 'The cost brake is checked after each round is billed, and parallel research can run past it.'
          : undefined
      }
      onClick={() => {
        if (disabled || sent.current === key) return
        if (run.outcome === 'cost' && armed !== key) {
          setArmed(key)
          return
        }
        sent.current = key
        onContinue(hasPlan ? CONTINUE_PLAN : CONTINUE_FREE)
      }}
    >
      {isArmed ? `Spend up to another $${usd(limit)}` : 'Continue'}
    </button>
  )
}

/** The progress ring of the pill: a full circle once every step is done or dropped. */
function Ring({ done, total }: { done: number; total: number }): JSX.Element {
  const C = 2 * Math.PI * 7
  const frac = total ? done / total : 0
  return (
    <svg className="plan-ring" viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
      <circle cx="9" cy="9" r="7" className="plan-ring-track" />
      <circle
        cx="9"
        cy="9"
        r="7"
        className="plan-ring-fill"
        strokeDasharray={`${frac * C} ${C}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  )
}

/** The collapsed card: progress, live, and a click to open it again. */
export function PlanPill({
  plan,
  run,
  frozen,
  onOpen
}: {
  plan: ChatPlan
  run: ChatRun | null
  frozen: boolean
  onOpen: () => void
}): JSX.Element {
  const { completed, total } = planProgress(plan)
  const finished = total > 0 && completed === total
  const stopped = resumable(run)
  const tip = [
    plan.title,
    stopped ? runReason(run.outcome) : null,
    frozen ? 'Plan from an earlier run; this model does not maintain plans' : null
  ]
    .filter(Boolean)
    .join(' — ')
  return (
    <button
      type="button"
      className={`plan-pill${finished ? ' done' : ''}${stopped ? ' stopped' : ''}`}
      title={tip}
      aria-label={`Show plan: ${plan.title}, ${completed} of ${total} done`}
      onClick={onOpen}
    >
      {finished ? (
        <span className="plan-pill-check" aria-hidden="true">
          ✓
        </span>
      ) : (
        <Ring done={completed} total={total} />
      )}
      <span className="plan-pill-count">
        {completed} / {total}
      </span>
    </button>
  )
}

const MARK: Record<PlanStepStatus, string> = {
  pending: '○',
  in_progress: '●',
  completed: '✓',
  skipped: '✗',
  blocked: '⊘'
}
const STATUS_WORD: Record<PlanStepStatus, string> = {
  pending: 'pending',
  in_progress: 'in progress',
  completed: 'done',
  skipped: 'skipped',
  blocked: 'blocked'
}

/** The open card: header (title, counter, collapse; reason + Continue after a stop), then the steps. */
export function PlanCard({
  plan,
  run,
  frozen,
  overlay,
  canContinue,
  fallbackLimit,
  onContinue,
  onCollapse
}: {
  plan: ChatPlan
  run: ChatRun | null
  frozen: boolean
  /** Opened over the transcript because the canvas column is too narrow for a card beside the dock. */
  overlay: boolean
  /** No run of this chat is in flight — Continue is only offered then. */
  canContinue: boolean
  fallbackLimit: number
  onContinue: (text: string) => void
  onCollapse: () => void
}): JSX.Element {
  const { completed, total } = planProgress(plan)
  const [focused, setFocused] = useState(false)
  const current = useRef<HTMLLIElement | null>(null)
  const active = plan.steps.findIndex((s) => s.status === 'in_progress')

  // Keep the step being worked on in view as the list moves on.
  useEffect(() => {
    current.current?.scrollIntoView?.({ block: 'nearest' })
  }, [active, plan.revision])

  return (
    <section
      className={`plan-card${overlay ? ' overlay' : ''}`}
      aria-label={`Plan: ${plan.title}`}
      tabIndex={-1}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      {/* Escape collapses the card only while it has the focus: everywhere else Escape belongs to the
          composer and the dialogs. */}
      {focused ? <EscapeCloser onClose={onCollapse} /> : null}
      <div className="plan-head">
        <span className="plan-title" title={plan.title}>
          {plan.title}
        </span>
        <span className="plan-count">
          {completed} / {total}
        </span>
        <button
          type="button"
          className="plan-collapse"
          aria-label="Collapse plan"
          title="Collapse plan"
          onClick={onCollapse}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              d="M4 6.5 8 10.5 12 6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {frozen ? (
        <div className="plan-frozen">Plan from an earlier run; this model does not maintain plans</div>
      ) : null}
      {resumable(run) ? (
        <div className="plan-stop">
          <span className="plan-stop-why">{runReason(run.outcome)}</span>
          <ContinueButton
            run={run}
            hasPlan
            disabled={!canContinue}
            fallbackLimit={fallbackLimit}
            onContinue={onContinue}
          />
        </div>
      ) : null}
      <ol className="plan-steps">
        {plan.steps.map((s, i) => (
          <li
            key={i}
            ref={i === active ? current : undefined}
            className={`plan-step ${s.status}`}
            title={s.note || undefined}
          >
            <span className="plan-mark" aria-label={STATUS_WORD[s.status]}>
              {s.status === 'in_progress' ? <span className="chat-trace-pulse" /> : MARK[s.status]}
            </span>
            <span className="plan-text">
              {s.step}
              {s.note ? <span className="plan-note">{s.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}
