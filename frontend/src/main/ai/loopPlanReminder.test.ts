import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatPlan } from '../../shared/plan'
import { chat } from './test/fakeStream'

/**
 * The plan reminder inside the loop (planReminder.ts): where it lands in the conversation, and the runs
 * that must never hear it. Offline, on the scripted stream (test/fakeStream.ts), like loop.test.ts.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())

const { runAgent, forgetTranscript } = await import('./agent')

function deps(): Parameters<typeof runAgent>[1] {
  return {
    apiRaw: async () => ({ status: 200, body: { ok: true } }),
    callUiTool: async () => ({ approved: true }),
    emit: () => {},
    getSkills: async () => []
  } as unknown as Parameters<typeof runAgent>[1]
}

const request = (over: Partial<Parameters<typeof runAgent>[0]> = {}): Parameters<typeof runAgent>[0] => ({
  chatId: 'c-plan-reminder',
  model: 'z-ai/glm-5.3',
  activeDb: 'demo-model',
  history: [],
  userText: 'Model a wheelbarrow.',
  signal: new AbortController().signal,
  ...over
})

type Call = { id: string; name: string; arguments: string }
const planCall = (id: string, steps: Array<{ step: string; status: string }>): Call => ({
  id,
  name: 'plan',
  arguments: JSON.stringify({ title: 'Wheelbarrow LCA', steps })
})
/** `n` read calls with distinct arguments, so the repeat guard never steps in. */
const searches = (prefix: string, n: number): { calls: Call[] } => ({
  calls: Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    name: 'search_background',
    arguments: JSON.stringify({ query: `${prefix} material ${i}` })
  }))
})
const listModels = (id: string): { calls: Call[] } => ({
  calls: [{ id, name: 'list_models', arguments: '{}' }]
})
const twoSteps = (first: string, second: string): Array<{ step: string; status: string }> => [
  { step: 'Research the bill of materials', status: first },
  { step: 'Build the frame', status: second }
]

const REMINDER = 'The plan beside the chat has not changed'
/** The index of the round whose request carries the reminder, or -1. */
const remindedAt = (): number[] =>
  chat.seen.flatMap((r, i) =>
    r.messages.some((m) => m.role === 'user' && String(m.content).startsWith(REMINDER)) ? [i] : []
  )

beforeEach(() => {
  chat.rounds = []
  chat.seen.length = 0
  forgetTranscript()
})

describe('runAgent — the plan reminder', () => {
  it('reminds after 25 calls without an update, behind that round’s results, naming the step', async () => {
    chat.rounds = [
      { calls: [planCall('p1', twoSteps('in_progress', 'pending'))] },
      searches('a', 24),
      listModels('m1'),
      listModels('m2'),
      { text: 'Done.' }
    ]
    await runAgent(request(), deps())
    // Round three made the 25th call; round four's request is the first to carry the reminder.
    expect(remindedAt()).toEqual([3, 4])
    const msgs = chat.seen[3].messages
    const at = msgs.findIndex((m) => m.role === 'user' && String(m.content).startsWith(REMINDER))
    expect(msgs[at - 1]).toMatchObject({ role: 'tool', tool_call_id: 'm1' })
    expect(at).toBe(msgs.length - 1)
    expect(String(msgs[at].content)).toContain(
      'for 25 tool calls; it still shows step 1 of 2 in progress: "Research the bill of materials"'
    )
    // Said once for the span: the request after the next round carries the same one message, no second.
    expect(chat.seen[4].messages.filter((m) => String(m.content).startsWith(REMINDER))).toHaveLength(1)
  })

  it('never reminds a model that keeps its plan current, however long the run', async () => {
    chat.rounds = [
      { calls: [planCall('p1', twoSteps('in_progress', 'pending'))] },
      searches('a', 20),
      { calls: [planCall('p2', twoSteps('completed', 'in_progress'))] },
      searches('b', 20),
      { calls: [planCall('p3', twoSteps('completed', 'completed'))] },
      { text: 'Done.' }
    ]
    await runAgent(request(), deps())
    expect(chat.seen).toHaveLength(6)
    expect(remindedAt()).toEqual([])
  })

  it('never reminds a short task with a three-step plan', async () => {
    const three = (a: string, b: string, c: string): Array<{ step: string; status: string }> => [
      { step: 'Find the dataset', status: a },
      { step: 'Create and link the process', status: b },
      { step: 'Calculate the footprint', status: c }
    ]
    chat.rounds = [
      { calls: [planCall('p1', three('in_progress', 'pending', 'pending'))] },
      searches('a', 2),
      { calls: [planCall('p2', three('completed', 'in_progress', 'pending'))] },
      listModels('m1'),
      { calls: [planCall('p3', three('completed', 'completed', 'completed'))], text: 'Done.' },
      { text: 'Done.' }
    ]
    await runAgent(request(), deps())
    expect(remindedAt()).toEqual([])
  })

  it('counts on in the next turn from the carried transcript — a stopped run does not start over', async () => {
    let kept: ChatPlan | null = null
    const keep = { ...deps(), persistPlan: async (p: ChatPlan | null) => void (kept = p) }
    chat.rounds = [
      { calls: [planCall('p1', twoSteps('in_progress', 'pending'))] },
      searches('a', 20),
      { text: 'Paused here.' }
    ]
    await runAgent(request(), keep)
    expect(remindedAt()).toEqual([])
    chat.seen.length = 0
    chat.rounds = [searches('b', 4), listModels('m1'), { text: 'Done.' }]
    await runAgent(
      request({
        history: [
          { role: 'user', content: 'Model a wheelbarrow.' },
          { role: 'assistant', content: 'Paused here.' }
        ],
        userText: 'Continue.',
        plan: kept
      }),
      keep
    )
    // 20 calls of the first turn, 4 + 1 of this one: the 25th is the list_models of round two.
    expect(remindedAt()).toEqual([2])
    expect(JSON.stringify(chat.seen[2].messages)).toContain('has not changed for 25 tool calls')
  })

  it('a refused plan call after an accepted one in the same round does not reset the count', async () => {
    chat.rounds = [
      {
        calls: [
          planCall('p1', twoSteps('in_progress', 'pending')),
          ...searches('a', 24).calls,
          planCall('p2', twoSteps('in_progress', 'in_progress'))
        ]
      },
      listModels('m1'),
      { text: 'Done.' }
    ]
    await runAgent(request(), deps())
    expect(remindedAt()).toEqual([2])
  })

  it('stays silent when the plan tool is off, even over a stored plan with a step in progress', async () => {
    const stored: ChatPlan = {
      title: 'Wheelbarrow LCA',
      steps: [
        { step: 'Research the bill of materials', status: 'in_progress' },
        { step: 'Build the frame', status: 'pending' }
      ],
      revision: 3,
      updated: '2026-11-14T18:00:00.000Z'
    }
    chat.rounds = [searches('a', 30), listModels('m1'), { text: 'Done.' }]
    await runAgent(request({ planTool: false, plan: stored }), deps())
    expect(remindedAt()).toEqual([])
    // …while the same stored plan with the tool on is reminded of after the 25th call.
    chat.seen.length = 0
    forgetTranscript()
    chat.rounds = [searches('a', 30), listModels('m1'), { text: 'Done.' }]
    await runAgent(request({ planTool: true, plan: stored }), deps())
    expect(remindedAt()).toEqual([1, 2])
  })
})
