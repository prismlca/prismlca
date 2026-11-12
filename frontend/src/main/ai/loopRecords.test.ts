import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, FakeOpenRouterError } from './test/fakeStream'

/**
 * What the agent loop leaves behind for a reader after the fact: the log line of every round, the
 * cache warning, the record of a failed request, the call keys on the live tool events, and — since
 * the announced-work nudge is gone — what a run that ends on an announcement does. Offline, on the
 * scripted stream (test/fakeStream.ts), like loop.test.ts.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())

const { runAgent, forgetTranscript } = await import('./agent')
const { localDate } = await import('./localTime')

type Ev = { type: string; name?: string; phase?: string; callId?: string; pattern?: string }

function deps(): { events: Ev[]; deps: Parameters<typeof runAgent>[1] } {
  const events: Ev[] = []
  return {
    events,
    deps: {
      apiRaw: async () => ({ status: 200, body: { ok: true } }),
      callUiTool: async () => ({ approved: true }),
      emit: (ev) => events.push(ev as Ev),
      getSkills: async () => []
    } as Parameters<typeof runAgent>[1]
  }
}

const request = (over: Partial<Parameters<typeof runAgent>[0]> = {}): Parameters<typeof runAgent>[0] => ({
  chatId: 'c-records',
  model: 'z-ai/glm-5.3',
  activeDb: 'demo-model',
  history: [],
  userText: 'hello',
  signal: new AbortController().signal,
  ...over
})

const usage = (prompt: number, cached: number) => ({
  cost: 0.01,
  prompt_tokens: prompt,
  completion_tokens: 50,
  prompt_tokens_details: { cached_tokens: cached }
})
const servedBy = (name: string) => [{ type: 'provider' as const, name }]
const listModels = (id: string) => ({ calls: [{ id, name: 'list_models', arguments: '{}' }] })

let logged: string[]
let warned: string[]
beforeEach(() => {
  chat.rounds = []
  chat.seen.length = 0
  forgetTranscript()
  logged = []
  warned = []
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logged.push(String(m)))
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void warned.push(String(m)))
})
afterEach(() => vi.restoreAllMocks())

describe('the log of a run', () => {
  it('writes one line per round with route and cache — also when the cache served nothing', async () => {
    chat.rounds = [
      { before: servedBy('Sail'), ...listModels('t1'), usage: usage(125_600, 0) },
      { before: servedBy('Sail'), text: 'One model.', usage: usage(126_000, 125_000) }
    ]
    await runAgent(request(), deps().deps)
    const rounds = logged.filter((l) => l.includes('[prism-ai] cache:'))
    expect(rounds).toHaveLength(2)
    expect(rounds[0]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[prism-ai\] cache: 0\/125600 prompt tokens \(0%\), \$0\.0100, /
    )
    expect(rounds[0]).toContain('via OpenRouter/Sail')
    expect(rounds[0]).toMatch(/— z-ai\/glm-5\.3 \(round 1\)$/)
    expect(rounds[1]).toContain('cache: 125000/126000 prompt tokens (99%)')
    // Every line of the loop carries the stamp.
    expect(logged.filter((l) => l.includes('[prism-ai]')).every((l) => /^\d{4}-\d{2}-\d{2} /.test(l))).toBe(
      true
    )
  })

  it('warns when the cache stops working, and tells the run bar once', async () => {
    chat.rounds = [
      { ...listModels('t1'), usage: usage(50_000, 40_000) },
      { ...listModels('t2'), usage: usage(70_000, 0) },
      { ...listModels('t3'), usage: usage(90_000, 89_000) },
      { ...listModels('t4'), usage: usage(110_000, 0) },
      { text: 'Done.', usage: usage(111_000, 110_000) }
    ]
    const d = deps()
    await runAgent(request(), d.deps)
    expect(d.events.filter((e) => e.type === 'cache-warning')).toEqual([
      { chatId: 'c-records', type: 'cache-warning', pattern: 'dropped' }
    ])
    expect(warned.filter((l) => l.includes('[prism-ai] cache warning:'))).toHaveLength(2)
  })

  it('stays quiet about a model that never caches', async () => {
    chat.rounds = [
      { ...listModels('t1'), usage: usage(50_000, 0) },
      { ...listModels('t2'), usage: usage(70_000, 0) },
      { text: 'Done.', usage: usage(90_000, 0) }
    ]
    const d = deps()
    await runAgent(request(), d.deps)
    expect(d.events.some((e) => e.type === 'cache-warning')).toBe(false)
    expect(warned.some((l) => l.includes('cache warning'))).toBe(false)
  })
})

describe('a request the provider refused', () => {
  it('leaves one log line and the reason on the result, for the stored answer', async () => {
    const refused = new FakeOpenRouterError('ZDR violation (account settings): 4 endpoints excluded', 'http')
    refused.status = 404
    chat.rounds = [{ throws: refused }]
    const res = await runAgent(request(), deps().deps)
    expect(res.outcome).toBe('error')
    expect(res.error).toBe('HTTP 404 — ZDR violation (account settings): 4 endpoints excluded')
    const lines = warned.filter((l) => l.includes('provider error'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(
      '[prism-ai] provider error: openrouter z-ai/glm-5.3 — HTTP 404 — ZDR violation'
    )
    // Nothing of the prompt goes into the line.
    expect(lines[0]).not.toContain('hello')
  })

  it('closes the round that failed mid-stream with its own line before the error ends the run', async () => {
    chat.rounds = [
      {
        before: [
          { type: 'provider', name: 'Sail' },
          { type: 'delta', text: 'Linking the' },
          { type: 'usage', usage: usage(80_000, 70_000) }
        ],
        throws: new FakeOpenRouterError('The connection to the model dropped mid-answer.', 'network')
      }
    ]
    const res = await runAgent(request(), deps().deps)
    expect(res.error).toBe('network — The connection to the model dropped mid-answer.')
    const round = logged.filter((l) => l.includes('[prism-ai] cache:'))
    expect(round).toHaveLength(1)
    expect(round[0]).toMatch(
      /cache: 70000\/80000 prompt tokens \(88%\), \$0\.0100, first token .*, failed, .*via OpenRouter\/Sail/
    )
    expect(
      warned.filter((l) => l.includes('provider error: openrouter/Sail z-ai/glm-5.3 — network'))
    ).toHaveLength(1)
  })

  it('carries no error on a run that answered', async () => {
    chat.rounds = [{ text: 'Fine.' }]
    expect((await runAgent(request(), deps().deps)).error).toBeUndefined()
  })
})

describe('the user turn', () => {
  it("carries today's date behind the study language", async () => {
    chat.rounds = [{ text: 'Noted.' }]
    await runAgent(request(), deps().deps)
    const last = chat.seen[0].messages.at(-1)!
    expect(String(last.content)).toMatch(
      /^\[(Study language: [^\]]+|No study language recorded yet)\]\n\[Today: /
    )
    expect(String(last.content)).toContain(`[Today: ${localDate()}]`)
  })
})

describe('live tool events', () => {
  it('carry a key per call, so two parallel calls of one tool keep their rows', async () => {
    chat.rounds = [
      {
        calls: [
          { id: 'x', name: 'search_background', arguments: '{"query":"widget, plastic"}' },
          { id: 'x', name: 'search_background', arguments: '{"query":"granulate"}' }
        ]
      },
      { text: 'Found.' }
    ]
    const d = deps()
    await runAgent(request(), d.deps)
    const calls = d.events.filter((e) => e.type === 'tool' && e.name === 'search_background')
    // Keys are the loop's own (round.position): a host that repeats a call id cannot merge two rows.
    expect(calls.filter((e) => e.phase === 'start').map((e) => e.callId)).toEqual(['0.0', '0.1'])
    expect(
      calls
        .filter((e) => e.phase !== 'start')
        .map((e) => e.callId)
        .sort()
    ).toEqual(['0.0', '0.1'])
  })
})

describe('a run that ends on an announcement', () => {
  it('ends there without a nudge — one request, and a line in the log', async () => {
    chat.rounds = [
      { text: 'I can see the full picture now.\n\nLet me execute everything now in parallel batches:' },
      { text: 'should never be requested' }
    ]
    const res = await runAgent(request(), deps().deps)
    expect(chat.seen).toHaveLength(1)
    expect(res.outcome).toBe('answered')
    expect(logged.some((l) => l.includes('ended on an announcement of further work'))).toBe(true)
  })

  it('takes an offer to the user as the end it is, and logs nothing for a plain answer', async () => {
    chat.rounds = [
      { text: 'Report done. If you have a real recipe, give it to me and I will replace the estimates.' }
    ]
    await runAgent(request(), deps().deps)
    expect(chat.seen).toHaveLength(1)
    chat.rounds = [{ text: 'The model is built: 1.16 kg CO2-Eq per litre.' }]
    logged = []
    await runAgent(request({ chatId: 'c-plain' }), deps().deps)
    expect(logged.some((l) => l.includes('announcement'))).toBe(false)
  })
})
