import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, FakeOpenRouterError } from './test/fakeStream'

/**
 * Where the closing answer of a turn begins. The text of a turn is one message: the questions the
 * user answered, every note the model wrote between tool rounds, then the answer. The `done` event
 * says where that last part starts, so a one-line reader (the banner of a turn that ended out of
 * sight) does not quote a question from the first minute. Offline, on the scripted stream
 * (test/fakeStream.ts), like loop.test.ts.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())

const { runAgent, forgetTranscript } = await import('./agent')

type Ev = { type: string; text?: string; answerFrom?: number }

function deps(overrides: Partial<Record<string, unknown>> = {}): {
  events: Ev[]
  deps: Parameters<typeof runAgent>[1]
} {
  const events: Ev[] = []
  return {
    events,
    deps: {
      apiRaw: async () => ({ status: 200, body: { ok: true } }),
      callUiTool: async (name: string) =>
        name === 'approve_tool' ? { approved: true } : { answers: ['1 wheelbarrow over its life'] },
      emit: (ev) => events.push(ev as Ev),
      getSkills: async () => [],
      ...overrides
    } as Parameters<typeof runAgent>[1]
  }
}

const request = (over: Partial<Parameters<typeof runAgent>[0]> = {}): Parameters<typeof runAgent>[0] => ({
  chatId: 'c-closing',
  model: 'z-ai/glm-5.3',
  activeDb: 'demo-model',
  history: [],
  userText: 'hello',
  signal: new AbortController().signal,
  ...over
})

const listModels = (id: string, text?: string) => ({
  ...(text ? { text } : {}),
  calls: [{ id, name: 'list_models', arguments: '{}' }]
})

/** The closing answer as the `done` event marks it, and the event's whole text. */
function closing(events: Ev[]): { closing: string; text: string } {
  const done = events.find((e) => e.type === 'done')
  const text = done?.text ?? ''
  return { closing: text.slice(done?.answerFrom ?? 0), text }
}

/** What the chat received while the run wrote: every delta, in order — the stored text, piece by piece. */
const streamed = (events: Ev[]): string =>
  events
    .filter((e) => e.type === 'delta')
    .map((e) => e.text)
    .join('')

beforeEach(() => {
  chat.rounds = []
  chat.seen.length = 0
  forgetTranscript()
})

describe('runAgent — where the closing answer begins', () => {
  it('marks the text behind the last tool round, after a question and five rounds of notes', async () => {
    const ANSWER = 'The wheelbarrow comes to about 75 kg CO2-eq over its life.\n\nSteel carries most of it.'
    chat.rounds = [
      {
        text: 'One question first.',
        calls: [
          {
            id: 'q',
            name: 'ask_user',
            arguments:
              '{"question":"What is the functional unit?","options":[{"label":"1 wheelbarrow over its life"},{"label":"1 year of use"}]}'
          }
        ]
      },
      listModels('a', 'Now I build the model.'),
      listModels('b', 'The health check is clean.'),
      listModels('c'),
      listModels('d', 'Now the recalculation.'),
      listModels('e', 'Record the review outcomes.'),
      { text: ANSWER }
    ]
    const d = deps()
    const res = await runAgent(request(), d.deps)
    const out = closing(d.events)

    expect(out.closing).toBe(ANSWER)
    // The message itself is unchanged: the exchange and every note stay in it, in order, so a
    // reloaded chat still shows them.
    expect(out.text).toBe(res.text)
    expect(res.text).toMatch(
      /^One question first\.[\s\S]*> ❓ What is the functional unit\?[\s\S]*> ➤ 1 wheelbarrow over its life[\s\S]*Now I build the model\.[\s\S]*Record the review outcomes\.\n\nThe wheelbarrow comes to/
    )
    expect(res.text.endsWith(ANSWER)).toBe(true)
    // Prose, separators and the question with its answer reached the chat exactly as they are stored.
    expect(streamed(d.events)).toBe(res.text)
  })

  it('is the whole text when the model answers without tools', async () => {
    chat.rounds = [{ text: 'All done.' }]
    const d = deps()
    await runAgent(request(), d.deps)
    expect(d.events.at(-1)).toMatchObject({ type: 'done', text: 'All done.', answerFrom: 0 })
  })

  it('starts behind a line the user sent while the run worked', async () => {
    // Typed while the model wrote what it took for its answer: the reply to it is what the turn ended on.
    chat.rounds = [{ text: 'All done.' }, { text: 'Also checked the unit.' }]
    const queue = [[], [], ['and check the unit']]
    const d = deps({ takeSteering: () => queue.shift() ?? [] })
    await runAgent(request(), d.deps)
    const out = closing(d.events)
    expect(out.text).toMatch(/All done\.[\s\S]*> \*\*You:\*\* and check the unit/)
    expect(out.closing).toBe('Also checked the unit.')
    expect(streamed(d.events)).toBe(out.text)
  })

  it('starts behind a line left over from the run before', async () => {
    chat.rounds = [{ text: 'Using 20 kg.' }]
    const queue = [['set the mass to 10 kg']]
    const d = deps({ takeSteering: () => queue.shift() ?? [] })
    await runAgent(request({ userText: 'actually use 20 kg' }), d.deps)
    const out = closing(d.events)
    expect(out.text).toMatch(/^> \*\*You \(earlier\):\*\* set the mass to 10 kg/)
    expect(out.closing).toBe('Using 20 kg.')
    expect(streamed(d.events)).toBe(out.text)
  })

  it('starts behind the notice of a reasoning level the API refused, once and twice', async () => {
    // The notice alone is longer than a one-line excerpt: left in front, it is all a reader would see.
    const refused = (level: string): { throws: FakeOpenRouterError } => ({
      throws: new FakeOpenRouterError(
        `OpenRouter error (HTTP 400) — reasoning.effort "${level}" is not supported.`,
        'http'
      )
    })
    chat.rounds = [refused('xhigh'), { text: 'Fine without it.' }]
    let d = deps()
    await runAgent(request({ reasoningEffort: 'xhigh' }), d.deps)
    expect(closing(d.events).text).toMatch(/rejected the reasoning effort "xhigh"/)
    expect(closing(d.events).closing).toBe('Fine without it.')

    chat.rounds = [refused('max'), refused('high'), { text: 'On the default.' }]
    d = deps()
    await runAgent(request({ model: 'openai/gpt-6-luna', reasoningEffort: 'max' }), d.deps)
    expect(closing(d.events).text).toMatch(/"max"[\s\S]*"high"/)
    expect(closing(d.events).closing).toBe('On the default.')
    expect(streamed(d.events)).toBe(closing(d.events).text)
  })

  it('is the stop note when the run ends on tool rounds, not a note from an earlier round', async () => {
    chat.rounds = [listModels('a', 'Reading the model.'), listModels('b'), listModels('c')]
    const d = deps()
    const res = await runAgent(request({ maxRounds: 3 }), d.deps)
    expect(res.outcome).toBe('rounds')
    expect(closing(d.events).closing.trim()).toMatch(/^_Stopped: the limit of 3 tool rounds was reached/)
    expect(streamed(d.events)).toBe(res.text)
  })
})
