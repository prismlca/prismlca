import { describe, expect, it } from 'vitest'
import type { ChatPlan, PlanStep } from '../../shared/plan'
import type { ChatMessage } from './providers/types'
import { PLAN_REMINDER_EVERY, planReminder, planReminderDue, sincePlanUpdate } from './planReminder'
import { compactMessages } from './contextBudget'

const plan = (steps: PlanStep[], revision = 1): ChatPlan => ({
  title: 'Wheelbarrow LCA',
  steps,
  revision,
  updated: '2026-11-14T18:00:00.000Z'
})
const STEPS: PlanStep[] = [
  { step: 'Record goal and scope', status: 'completed' },
  { step: 'Research the bill of materials', status: 'in_progress' },
  { step: 'Build the frame', status: 'pending' }
]
const onStep2 = plan(STEPS)
/** A list other than the one in force — what a refused update sends. */
const REFUSED_STEPS = STEPS.map((s) => ({ ...s, status: 'in_progress' }))

const ACCEPTED = 'Plan updated · 1/3 · in progress: Research the bill of materials'
const REFUSED = JSON.stringify({ error: 'plan not updated: two steps are in_progress.' })
const STUB = '[earlier tool result omitted to fit the context]'

/** The conversation the loop holds, built round by round, with the reminder pushed where the loop pushes it. */
class Talk {
  messages: ChatMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'Model it.' }
  ]
  private n = 0
  /** One round: a number is that many read calls; 'ok' an accepted plan update, 'no' a refused one. */
  round(...calls: Array<number | 'ok' | 'no'>): this {
    const tool_calls: NonNullable<ChatMessage['tool_calls']> = []
    const results: ChatMessage[] = []
    for (const c of calls) {
      for (let k = 0; k < (typeof c === 'number' ? c : 1); k++) {
        const id = `c${this.n++}`
        const plan = typeof c !== 'number'
        const args = plan ? JSON.stringify({ steps: c === 'ok' ? STEPS : REFUSED_STEPS }) : '{}'
        tool_calls.push({
          id,
          type: 'function',
          function: { name: plan ? 'plan' : 'search_background', arguments: args }
        })
        const content = c === 'ok' ? ACCEPTED : c === 'no' ? REFUSED : '{"results": []}'
        results.push({ role: 'tool', tool_call_id: id, content })
      }
    }
    this.messages.push({ role: 'assistant', content: '', tool_calls }, ...results)
    return this
  }
  /** What the loop does after the round: ask, and push the reminder when there is one. */
  check(p: ChatPlan | null = onStep2): string | null {
    const due = planReminderDue(this.messages, p)
    if (due) this.messages.push({ role: 'user', content: due })
    return due
  }
}

describe('sincePlanUpdate', () => {
  it('counts back to the last accepted plan call, across rounds', () => {
    const t = new Talk().round(3).round('ok').round(4).round(2, 5)
    expect(sincePlanUpdate(t.messages)).toEqual({ calls: 11, sinceReminder: 11 })
  })

  it('resets at the accepted call itself, not at a refused one after it in the same round', () => {
    const t = new Talk().round(10).round('ok', 24, 'no', 1)
    expect(sincePlanUpdate(t.messages).calls).toBe(25)
  })

  it('counts everything when no plan call was ever accepted', () => {
    const t = new Talk().round(5).round('no').round(7)
    expect(sincePlanUpdate(t.messages).calls).toBe(12)
  })

  it('keeps the answer that accepted the plan in force through compaction, so the walk stops there', () => {
    const t = new Talk().round(10).round('ok').round(5).round('no').round(6).round('no').round(3)
    compactMessages(t.messages, 1)
    const answers = t.messages.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(answers.filter((c) => c === ACCEPTED)).toHaveLength(1)
    expect(answers.filter((c) => c === REFUSED)).toHaveLength(1) // the newest plan result, the other went
    expect(sincePlanUpdate(t.messages).calls).toBe(14)
  })

  it('lets compaction take the answers of older updates', () => {
    const t = new Talk().round('ok').round(3).round('ok').round(4).round(2)
    compactMessages(t.messages, 1)
    const answers = t.messages.filter((m) => m.role === 'tool').map((m) => m.content)
    expect(answers.filter((c) => c === ACCEPTED)).toHaveLength(1)
    expect(sincePlanUpdate(t.messages).calls).toBe(6)
  })

  it('never takes a stubbed answer for the update, not even one whose call sent the very list in force', () => {
    const t = new Talk().round('ok').round(8)
    // The same steps, refused for a title that is not text; then another refusal; then compaction stubbed it.
    t.messages.push(
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'same',
            type: 'function',
            function: { name: 'plan', arguments: JSON.stringify({ title: 7, steps: STEPS }) }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'same', content: STUB }
    )
    t.round(6).round('no').round(3)
    expect(sincePlanUpdate(t.messages).calls).toBe(17)
  })

  it('takes a call a stop cut off as not run', () => {
    const t = new Talk().round('ok').round(4)
    t.messages.push(
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'cut',
            type: 'function',
            function: { name: 'plan', arguments: JSON.stringify({ steps: STEPS }) }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'cut',
        content: JSON.stringify({ error: 'not executed — the run stopped.' })
      }
    )
    expect(sincePlanUpdate(t.messages).calls).toBe(4)
  })
})

describe('planReminderDue', () => {
  it('speaks when 25 calls pass without an update while a step is in progress, and 25 calls later again', () => {
    const t = new Talk().round('ok')
    expect(t.round(24).check()).toBeNull()
    expect(t.round(1).check()).toMatch(/not changed for 25 tool calls/)
    expect(t.round(24).check()).toBeNull()
    expect(t.round(1).check()).toMatch(/not changed for 50 tool calls/)
  })

  it('names the count it reached when a round passes the mark, and counts the next span from the reminder', () => {
    const t = new Talk().round('ok')
    expect(t.round(20).check()).toBeNull()
    expect(t.round(10).check()).toMatch(/for 30 tool calls/)
    expect(t.round(24).check()).toBeNull()
    expect(t.round(1).check()).toMatch(/for 55 tool calls/)
  })

  it('starts again at an accepted update; reminders before it no longer count', () => {
    const t = new Talk().round('ok')
    expect(t.round(30).check()).toMatch(/for 30 tool calls/)
    expect(t.round(3, 'ok', 2).check()).toBeNull()
    expect(t.round(22).check()).toBeNull()
    expect(t.round(1).check()).toMatch(/for 25 tool calls/)
  })

  it('does not let a refused update after the accepted one swallow the work in between', () => {
    const t = new Talk().round('ok')
    expect(t.round('ok', 24, 'no').check()).toBeNull()
    expect(t.round(1).check()).toMatch(/for 25 tool calls/)
  })

  it('counts on from a carried transcript: a run resumed after 20 calls speaks at the 25th', () => {
    const t = new Talk().round('ok').round(20)
    expect(t.round(4).check()).toBeNull()
    expect(t.round(1).check()).toMatch(/for 25 tool calls/)
  })

  it('does not repeat a reminder the carried transcript already holds', () => {
    const t = new Talk().round('ok').round(30)
    expect(t.check()).toMatch(/for 30 tool calls/)
    expect(t.round(24).check()).toBeNull()
    expect(t.round(1).check()).toMatch(/for 55 tool calls/)
  })

  it('counts from the reminder’s place, not its number, when bounding dropped the rounds it counted', () => {
    // A stored transcript bounded to fit: the plan call and the early rounds are gone, the reminder stayed.
    const t = new Talk().round(10)
    t.messages.push({ role: 'user', content: planReminder(100, onStep2, 1) })
    expect(t.round(10).check()).toBeNull()
    expect(t.round(15).check()).toMatch(/for 35 tool calls/)
  })

  it('gives the reminder a stopped round owed, in the first round of the next run', () => {
    // The round that reached 25 was cut by Stop: no reminder was pushed.
    const t = new Talk().round('ok').round(25)
    expect(t.round(1).check()).toMatch(/for 26 tool calls/)
  })

  it('keeps silent without a plan, with a withdrawn one, and with every step closed', () => {
    const closed = plan([
      { step: 'Record goal and scope', status: 'completed' },
      { step: 'Build the frame', status: 'skipped', note: 'Bought in.' }
    ])
    for (const p of [null, closed]) expect(new Talk().round(100).check(p)).toBeNull()
  })

  it('starts counting at the run when the conversation holds no calls (a transcript rebuilt from prose)', () => {
    const t = new Talk()
    expect(t.round(PLAN_REMINDER_EVERY - 1).check()).toBeNull()
    expect(t.round(1).check()).not.toBeNull()
  })
})

describe('planReminder', () => {
  it('says which step the card still shows, and that staying on it needs no call', () => {
    const text = planReminder(25, onStep2, 1)
    expect(text).toContain('step 2 of 3 in progress: "Research the bill of materials"')
    expect(text).toMatch(/If that step is done, send the updated plan now/)
    expect(text).toMatch(/If you are still on it, carry on without a plan call\./)
  })
})
