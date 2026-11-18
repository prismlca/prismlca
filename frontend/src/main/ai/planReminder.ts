/**
 * The plan reminder: how long the chat's plan has stood still, and what the loop tells the model about it.
 *
 * The plan card beside the chat is how the user follows a long task. Several models keep it in name only:
 * they lay it out early, work for 40 to 70 tool calls without touching it, and tick everything off at the
 * end — the card shows step 2 of 8 while the model is on step 6. The prompt rule and the tool description
 * already say "tick each step off as it finishes"; this is the reminder for a model that does not. While a
 * step is in progress, it speaks once PLAN_REMINDER_EVERY calls have passed without an accepted plan update,
 * and again after every further PLAN_REMINDER_EVERY until the plan moves. A model that keeps its plan current
 * never hears it, and neither does a short task.
 *
 * Nothing is kept beside the conversation: both the count and the last reminder are read from it after every
 * round. The count runs back to the `plan` call that produced the plan in force, so a refused update resets
 * nothing, and the next reminder is due PLAN_REMINDER_EVERY calls after the later of that update and the last
 * reminder — counted by position, never by the number a reminder named, because bounding a stored transcript
 * drops old rounds and keeps the prose between them. A run that goes on from a stopped one (Continue, the next
 * turn) therefore counts on where the carried transcript stands, including a round that Stop cut short at a
 * mark, whose reminder then comes in the next run. A transcript rebuilt from prose holds no calls and starts
 * the count again.
 *
 * Loop behaviour, so the chat's alone: an MCP client has no `plan` tool and keeps its own list.
 */
import { validatePlanUpdate, type ChatPlan } from '../../shared/plan'
import type { ChatMessage } from './providers/types'
import { aiLog } from './aiLog'

/** Tool calls without an accepted plan update after which the model is reminded — and again after each further span. */
export const PLAN_REMINDER_EVERY = 25

/** The `plan` tool's own calls are the updates being waited for, not work done in between. */
const PLAN_TOOL = 'plan'

const REMINDER_HEAD = 'The plan beside the chat has not changed for '

/** A refused call answers `{"error": …}` — the tool's own refusal, the loop's, and a call a stop cut off. */
function refused(result: string): boolean {
  if (!result.startsWith('{')) return false
  try {
    return typeof (JSON.parse(result) as { error?: unknown }).error === 'string'
  } catch {
    return false
  }
}

/**
 * Whether a plan call's arguments would pass the plan's own checks and are the list now in force, step for
 * step with status and note. The checks are run without a previous revision: the one they need it for, an
 * unfinished step dropped without a reason, cannot refuse a list identical to the plan it replaced.
 */
function sentThePlanInForce(args: string, plan: ChatPlan): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    return false
  }
  const v = validatePlanUpdate(null, parsed)
  if (!v.ok) return false
  const sent = v.input.steps
  return (
    sent.length === plan.steps.length &&
    sent.every(
      (s, i) =>
        s.step === plan.steps[i].step &&
        s.status === plan.steps[i].status &&
        (s.note ?? '') === (plan.steps[i].note ?? '')
    )
  )
}

/**
 * Whether this `plan` call produced the plan in force. The tool's answer says so — "Plan updated …" or
 * "Plan withdrawn." against a refusal. Compaction replaces older results, refusals among them, with a stub
 * that says neither; then the call counts only if it sent the very list in force.
 */
function producedThePlan(call: { arguments: string }, result: unknown, plan: ChatPlan): boolean {
  if (typeof result === 'string') {
    if (result.startsWith('Plan updated') || result.startsWith('Plan withdrawn')) return true
    if (refused(result)) return false
  }
  return sentThePlanInForce(call.arguments, plan)
}

/**
 * Walking back to the plan call that produced the plan in force (or to the start): the tool calls since
 * then, and the calls since the newest reminder after it (the same number when there was none).
 */
export function sincePlanUpdate(
  messages: readonly ChatMessage[],
  plan: ChatPlan
): { calls: number; sinceReminder: number } {
  const results = new Map<string, ChatMessage['content']>()
  let calls = 0
  let sinceReminder: number | null = null
  const done = (): { calls: number; sinceReminder: number } => ({
    calls,
    sinceReminder: sinceReminder ?? calls
  })
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, m.content)
    // The newest reminder: the calls counted so far are the ones after it.
    const reminder = m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(REMINDER_HEAD)
    if (reminder && sinceReminder === null) sinceReminder = calls
    if (m.role !== 'assistant' || !m.tool_calls?.length) continue
    for (let j = m.tool_calls.length - 1; j >= 0; j--) {
      const tc = m.tool_calls[j]
      if (tc.function.name !== PLAN_TOOL) calls++
      else if (producedThePlan(tc.function, results.get(tc.id), plan)) return done()
    }
  }
  return done()
}

/**
 * After a round's results are in the conversation: the reminder, when a step is in progress and
 * PLAN_REMINDER_EVERY calls have passed since the plan's last update and since the last reminder; else null.
 */
export function planReminderDue(
  messages: readonly ChatMessage[],
  plan: ChatPlan | null,
  every = PLAN_REMINDER_EVERY
): string | null {
  const step = plan?.steps.findIndex((s) => s.status === 'in_progress') ?? -1
  if (!plan || step < 0) return null
  const { calls, sinceReminder } = sincePlanUpdate(messages, plan)
  if (sinceReminder < every) return null
  aiLog(`plan unchanged for ${calls} calls, step ${step + 1}/${plan.steps.length} in progress — nudging`)
  return planReminder(calls, plan, step)
}

/** What the model is told. Says which step the card still shows, so the model can compare it with
 *  where it is — and says that still being on that step needs no call, or the reminder buys an
 *  empty update every time it speaks. */
export function planReminder(calls: number, plan: ChatPlan, step: number): string {
  return (
    `${REMINDER_HEAD}${calls} tool calls; it still shows step ${step + 1} of ` +
    `${plan.steps.length} in progress: "${plan.steps[step].step}". If that step is done, send the updated ` +
    'plan now, then carry on. If you are still on it, carry on without a plan call.'
  )
}
