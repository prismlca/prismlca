/**
 * The plan a chat's assistant keeps, and the run state a chat carries — the contract between the
 * `plan` tool (main), the chat store (backend, `plan` and `run` fields on a chat) and the plan card
 * (renderer). Plain values and pure functions only: this module is compiled into both bundles.
 *
 * The rules in short: the model sends the WHOLE list on every call (Codex's shape — nothing can be
 * orphaned), at most one step is `in_progress`, a step that cannot proceed is `blocked` with a reason, and a
 * non-terminal step may only disappear with an `explanation`, so unfinished work cannot be quietly
 * cut from the list. Every rule is enforced here with a diagnostic message, never by bending the
 * schema (the GLM lesson, V277/V279).
 */

export type PlanStepStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'skipped'

export const PLAN_STATUSES: readonly PlanStepStatus[] = [
  'pending',
  'in_progress',
  'blocked',
  'completed',
  'skipped'
]

/** Done one way or the other — nothing more will happen to this step. */
export const TERMINAL_STATUSES: ReadonlySet<PlanStepStatus> = new Set(['completed', 'skipped'])

export interface PlanStep {
  step: string
  status: PlanStepStatus
  /** Required on `blocked` and `skipped` (why); optional on `completed` (what came out). */
  note?: string
}

/** The accepted revision of a chat's plan, as the store keeps it and the card shows it. */
export interface ChatPlan {
  title: string
  steps: PlanStep[]
  /** Counts accepted updates; a rejected call never increments it. */
  revision: number
  /** ISO timestamp of the accepted update. */
  updated: string
}

export type RunState = 'idle' | 'running' | 'stopped' | 'interrupted'

/**
 * How a run ended — structured, so nothing derives the state from italic prose in the answer.
 *   answered       the model finished with an answer
 *   rounds         the round budget was spent
 *   cost           the cost circuit breaker tripped
 *   repetition     the reply collapsed into repeating itself
 *   stalled        six rounds in a row produced only rejected or failed tool calls
 *   empty          the provider returned nothing twice
 *   output_limit   the answer was cut at the output-token limit (counts as answered, resumable)
 *   cancelled      the user pressed Stop
 *   error          the run threw
 *   interrupted    PrismLCA was closed while the run was going (set at the next start)
 */
export type RunOutcome =
  | 'answered'
  | 'rounds'
  | 'cost'
  | 'repetition'
  | 'stalled'
  | 'empty'
  | 'output_limit'
  | 'cancelled'
  | 'error'
  | 'interrupted'

/** Outcomes after which "Continue" makes sense — everything but a finished answer. */
export const RESUMABLE_OUTCOMES: ReadonlySet<RunOutcome> = new Set([
  'rounds',
  'cost',
  'repetition',
  'stalled',
  'empty',
  'output_limit',
  'cancelled',
  'error',
  'interrupted'
])

export interface ChatRun {
  runId: string
  state: RunState
  outcome?: RunOutcome
  startedAt?: string
  endedAt?: string
  /** What the stopped run had spent, and the limit it was stopped against (outcome 'cost'). */
  costUsd?: number
  costLimitUsd?: number
  rounds?: number
  /** The turn id of the run — the key under which its transcript is stored. */
  turnId?: string
}

export const PLAN_LIMITS = {
  steps: 20,
  stepChars: 120,
  noteChars: 300,
  explanationChars: 300,
  titleChars: 60
} as const

/** What the model sends: the whole list, an optional title, an optional explanation. */
export interface PlanUpdateInput {
  title?: string
  explanation?: string
  steps: PlanStep[]
}

export type PlanValidation =
  | { ok: true; input: PlanUpdateInput; cleared: boolean }
  | { ok: false; error: string }

const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * Check one `plan` call against the rules and the previous accepted revision. Returns the cleaned
 * input, or ONE sentence saying what is wrong and what to do — the previous revision stays valid
 * either way.
 */
export function validatePlanUpdate(prev: ChatPlan | null, raw: unknown): PlanValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'plan expects an object with a `steps` array.' }
  }
  const a = raw as Record<string, unknown>
  const title = typeof a.title === 'string' ? a.title.trim() : undefined
  const explanation = typeof a.explanation === 'string' ? a.explanation.trim() : undefined
  if (title && title.length > PLAN_LIMITS.titleChars)
    return {
      ok: false,
      error: `title is ${title.length} characters; keep it under ${PLAN_LIMITS.titleChars}.`
    }
  if (explanation && explanation.length > PLAN_LIMITS.explanationChars)
    return {
      ok: false,
      error: `explanation is ${explanation.length} characters; keep it under ${PLAN_LIMITS.explanationChars}.`
    }
  if (!Array.isArray(a.steps)) {
    return {
      ok: false,
      error:
        'steps must be an ARRAY of {step, status} objects — the whole list, not one step and not a string.'
    }
  }
  if (a.steps.length > PLAN_LIMITS.steps)
    return {
      ok: false,
      error: `${a.steps.length} steps is too many; a plan has at most ${PLAN_LIMITS.steps} — merge small steps.`
    }

  // Empty list: the plan is withdrawn. Only with a reason, so it cannot vanish by accident.
  if (a.steps.length === 0) {
    if (!prev) return { ok: false, error: 'steps is empty and there is no plan to clear — send the steps.' }
    if (!explanation)
      return { ok: false, error: 'an empty steps list clears the plan; say why in `explanation`.' }
    return { ok: true, input: { title, explanation, steps: [] }, cleared: true }
  }

  const steps: PlanStep[] = []
  for (const [i, s] of a.steps.entries()) {
    if (!s || typeof s !== 'object' || Array.isArray(s))
      return { ok: false, error: `steps[${i}] must be an object {step, status}.` }
    const o = s as Record<string, unknown>
    const text = typeof o.step === 'string' ? o.step.trim().replace(/\s+/g, ' ') : ''
    if (!text) return { ok: false, error: `steps[${i}] has no \`step\` text.` }
    if (text.length > PLAN_LIMITS.stepChars)
      return {
        ok: false,
        error: `steps[${i}] is ${text.length} characters; a step is one short sentence (under ${PLAN_LIMITS.stepChars}).`
      }
    const status = o.status
    if (status === undefined) {
      // The status written as a KEY — `{"in_progress": true, "step": …}` — six times in one GLM run (V364);
      // the plain "status undefined" refusal left the model guessing for five
      // rounds. Name where its status went, and the retry lands.
      const asKey = Object.keys(o).find((k) => (PLAN_STATUSES as readonly string[]).includes(k))
      if (asKey)
        return {
          ok: false,
          error: `steps[${i}] has no "status" — you wrote "${asKey}" as a key; write "status": "${asKey}".`
        }
    }
    if (typeof status !== 'string' || !(PLAN_STATUSES as readonly string[]).includes(status))
      return {
        ok: false,
        error: `steps[${i}].status "${String(status)}" is not one of ${PLAN_STATUSES.join(', ')}.`
      }
    const note = typeof o.note === 'string' ? o.note.trim() : undefined
    if (note && note.length > PLAN_LIMITS.noteChars)
      return {
        ok: false,
        error: `steps[${i}].note is too long; keep it under ${PLAN_LIMITS.noteChars} characters.`
      }
    if ((status === 'blocked' || status === 'skipped') && !note)
      return {
        ok: false,
        error: `steps[${i}] is ${status} but has no \`note\` — say why (what blocks it / why it is dropped).`
      }
    steps.push(
      note
        ? { step: text, status: status as PlanStepStatus, note }
        : { step: text, status: status as PlanStepStatus }
    )
  }

  const inProgress = steps.filter((s) => s.status === 'in_progress')
  if (inProgress.length > 1)
    return {
      ok: false,
      error:
        `two steps are in_progress ("${inProgress[0].step}" and "${inProgress[1].step}"); ` +
        'exactly one step is in_progress at a time — finish or block one of them.'
    }
  const allTerminal = steps.every((s) => TERMINAL_STATUSES.has(s.status))
  if (inProgress.length === 0 && !allTerminal) {
    const next = steps.find((s) => s.status === 'pending' || s.status === 'blocked')
    return {
      ok: false,
      error:
        'no step is in_progress while work remains — mark the step you are on (e.g. "' +
        `${next?.step ?? steps[0].step}") as in_progress, or finish the list.`
    }
  }

  if (!prev && !title) return { ok: false, error: 'the first plan of a chat needs a `title` (3–6 words).' }

  // A non-terminal step of the previous revision that is gone now: allowed, but said.
  if (prev) {
    const now = new Set(steps.map((s) => norm(s.step)))
    const lost = prev.steps.filter((s) => !TERMINAL_STATUSES.has(s.status) && !now.has(norm(s.step)))
    if (lost.length && !explanation)
      return {
        ok: false,
        error:
          `"${lost[0].step}" was ${lost[0].status} and is no longer in the list; ` +
          'dropping or rewording unfinished steps needs an `explanation`.'
      }
  }

  return { ok: true, input: { title, explanation, steps }, cleared: false }
}

export function planProgress(plan: ChatPlan | null | undefined): { completed: number; total: number } {
  if (!plan) return { completed: 0, total: 0 }
  return {
    completed: plan.steps.filter((s) => TERMINAL_STATUSES.has(s.status)).length,
    total: plan.steps.length
  }
}

const MARK: Record<PlanStepStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  blocked: '[!]',
  completed: '[x]',
  skipped: '[-]'
}

/** The compact list the model reads back — what the `plan` tool returns and what a rebuilt turn is given. */
export function formatPlanForModel(plan: ChatPlan): string {
  const { completed, total } = planProgress(plan)
  const lines = plan.steps.map(
    (s, i) => `${MARK[s.status]} ${i + 1}. ${s.step}${s.note ? ` — ${s.note}` : ''}`
  )
  return `Plan "${plan.title}" (rev ${plan.revision}, ${completed}/${total} done)\n${lines.join('\n')}`
}
