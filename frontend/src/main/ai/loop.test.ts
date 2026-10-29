import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from './providers/types'
import { chat, FakeOpenRouterError, type ScriptedRound } from './test/fakeStream'

/**
 * Behaviour tests for the agent loop. `streamChat` is mocked with the scripted stream from
 * test/fakeStream.ts, so these run offline, deterministically and for free — no OpenRouter key, no
 * network, no window. What we assert is exactly what breaks silently in production: tool dispatch,
 * error containment, canvas refreshes, the round budget, history compaction, the context-overflow
 * rescue and the cost circuit breaker.
 *
 * Live end-to-end checks against a real model live in `frontend/scripts/ai-eval.ts` (opt-in).
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())

/** Usage the toolless summariser call reports, so its billing can be asserted. */
let summaryUsage: ScriptedRound['usage']
// The history summariser is a separate, TOOLLESS call — answer it with a canned summary instead of
// consuming one of the scripted agent rounds, and without recording it in `chat.seen` (mirrors how
// it behaves in production).
chat.toolless = () => ({ text: '- earlier results: graph fetched, 3 processes seen', usage: summaryUsage })

const { runAgent, TRACE_PREVIEW_CHARS, markCacheBreakpoints, forgetTranscript } = await import('./agent')
const { setUserModels } = await import('./models')

/**
 * A model with a genuinely small window, registered as a user model so the compaction tests have
 * something to compact: since Hy3 left the catalogue every built-in row holds about a
 * megatoken, and a test that leaned on a catalogue entry would break with the next catalogue change.
 */
const SMALL_WINDOW = 'test/small-window'
setUserModels({
  models: [
    {
      id: SMALL_WINDOW,
      label: 'Small window (test)',
      descriptor: 'test',
      temperature: null,
      intelligence: null,
      agentic: null,
      vision: false,
      contextTokens: 262144,
      userAdded: true
    }
  ],
  problems: []
})

type Ev = {
  type: string
  name?: string
  text?: string
  phase?: string
  detail?: string
  graph?: boolean
  structure?: boolean
}

function deps(overrides: Partial<Record<string, unknown>> = {}): {
  events: Ev[]
  apiCalls: Array<{ method: string; path: string }>
  deps: Parameters<typeof runAgent>[1]
} {
  const events: Ev[] = []
  const apiCalls: Array<{ method: string; path: string }> = []
  return {
    events,
    apiCalls,
    deps: {
      apiRaw: async (method: string, path: string) => {
        apiCalls.push({ method, path })
        return { status: 200, body: { ok: true } }
      },
      // The card of an irreversible action is allowed, a question answered 'Yes' — tests that want
      // otherwise pass their own.
      callUiTool: async (name: string) =>
        name === 'approve_tool' ? { approved: true } : { answers: ['Yes'] },
      emit: (ev) => events.push(ev as Ev),
      getSkills: async () => [],
      ...overrides
    } as Parameters<typeof runAgent>[1]
  }
}

function request(over: Partial<Parameters<typeof runAgent>[0]> = {}): Parameters<typeof runAgent>[0] {
  return {
    chatId: 'c1',
    model: 'z-ai/glm-5.3',
    activeDb: 'demo-model',
    history: [],
    userText: 'hello',
    signal: new AbortController().signal,
    ...over
  }
}

beforeEach(() => {
  chat.rounds = []
  chat.seen.length = 0
  chat.toollessSeen = 0
  summaryUsage = undefined
  // The transcript carried between turns is keyed by chatId, and every test here uses 'c1'.
  forgetTranscript()
})

describe('runAgent — basics', () => {
  it('returns the streamed answer when the model asks for no tools', async () => {
    chat.rounds = [{ text: 'All done.' }]
    const d = deps()
    const res = await runAgent(request(), d.deps)

    expect(res).toMatchObject({ text: 'All done.', aborted: false, trace: [], outcome: 'answered' })
    expect(res.turnId).toMatch(/^turn-/)
    expect(d.events.filter((e) => e.type === 'delta').map((e) => e.text)).toEqual(['All done.'])
    expect(d.events.at(-1)).toMatchObject({ type: 'done', text: 'All done.' })
  })

  it('runs a tool, feeds the result back and finishes on the next round', async () => {
    chat.rounds = [
      { calls: [{ id: 't1', name: 'list_models', arguments: '{}' }] },
      { text: 'You have one model.' }
    ]
    const d = deps()
    const res = await runAgent(request(), d.deps)

    // The study-language lookup (V291) rides on every turn and is not the tool call under test.
    const toolCalls = d.apiCalls.filter((c) => !c.path.startsWith('/api/v1/study'))
    expect(toolCalls).toEqual([{ method: 'GET', path: '/api/v1/databases' }])
    expect(d.events.filter((e) => e.type === 'tool').map((e) => e.phase)).toEqual(['start', 'done'])
    expect(res.text).toContain('You have one model.')
    // Round two saw the assistant tool-call turn plus the tool result.
    const second = chat.seen[1].messages
    expect(second.some((m) => m.role === 'assistant' && m.tool_calls?.length)).toBe(true)
    expect(second.some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(true)
  })

  it('contains an unknown tool as an error result instead of crashing the run', async () => {
    chat.rounds = [{ calls: [{ id: 't1', name: 'no_such_tool', arguments: '{}' }] }, { text: 'Sorry.' }]
    const d = deps()
    const res = await runAgent(request(), d.deps)

    expect(res.aborted).toBe(false)
    expect(d.events.find((e) => e.type === 'tool' && e.phase === 'error')).toBeTruthy()
    const toolMsg = chat.seen[1].messages.find((m) => m.role === 'tool')
    expect(String(toolMsg?.content)).toContain('Unknown tool')
  })

  it('contains malformed tool arguments the same way', async () => {
    chat.rounds = [{ calls: [{ id: 't1', name: 'list_models', arguments: '{not json' }] }, { text: 'ok' }]
    const d = deps()
    await runAgent(request(), d.deps)
    expect(d.events.find((e) => e.type === 'tool' && e.phase === 'error')).toBeTruthy()
  })

  it('asks the renderer to reload after a mutating tool', async () => {
    chat.rounds = [
      {
        calls: [{ id: 't1', name: 'edit_parameter', arguments: '{"action":"set","name":"mass","value":2}' }]
      },
      { text: 'Set.' }
    ]
    const d = deps()
    await runAgent(request(), d.deps)
    expect(d.events.filter((e) => e.type === 'refresh').length).toBeGreaterThanOrEqual(1)
    // A number changed, no box came or went: the chat must not refit the canvas after this turn.
    expect(d.events.some((e) => e.type === 'refresh' && e.structure)).toBe(false)
  })

  it('marks the reload when a call changed what the canvas draws', async () => {
    chat.rounds = [
      {
        calls: [{ id: 't1', name: 'delete_process', arguments: '{"database":"demo-model","code":"p1"}' }]
      },
      { text: 'Removed.' }
    ]
    const d = deps()
    await runAgent(request(), d.deps)
    expect(d.events.some((e) => e.type === 'refresh' && e.structure === true && e.graph === true)).toBe(true)
  })

  it('does not reload the canvas for a read-only tool', async () => {
    chat.rounds = [{ calls: [{ id: 't1', name: 'list_models', arguments: '{}' }] }, { text: 'ok' }]
    const d = deps()
    await runAgent(request(), d.deps)
    expect(d.events.filter((e) => e.type === 'refresh')).toEqual([])
  })

  it('keeps the ask_user question and answer in the visible transcript', async () => {
    chat.rounds = [
      {
        calls: [
          {
            id: 't1',
            name: 'ask_user',
            arguments: '{"question":"Proceed?","options":[{"label":"Yes"},{"label":"No"}]}'
          }
        ]
      },
      { text: 'Proceeding.' }
    ]
    const d = deps()
    const res = await runAgent(request(), d.deps)
    expect(res.text).toContain('Proceed?')
    expect(res.text).toContain('Yes')
  })

  it('stops at the round budget instead of looping forever', async () => {
    // The model keeps asking for tools; the budget must cut it off.
    chat.rounds = Array.from({ length: 10 }, () => ({
      calls: [{ id: 'x', name: 'list_models', arguments: '{}' }]
    }))
    const d = deps()
    await runAgent(request({ maxRounds: 3 }), d.deps)
    expect(chat.seen.length).toBe(3)
  })

  // A live eval produced an empty answer: the model spent every round on tool calls and never wrote
  // prose, so the chat showed nothing at all and looked like a hang.
  it('says so when it runs out of rounds instead of returning an empty answer', async () => {
    chat.rounds = Array.from({ length: 10 }, () => ({
      calls: [{ id: 'x', name: 'list_models', arguments: '{}' }]
    }))
    const d = deps()
    const res = await runAgent(request({ maxRounds: 2 }), d.deps)
    expect(res.text).toContain('2 tool rounds')
    expect(d.events.some((e) => e.type === 'delta' && String(e.text).includes('2 tool rounds'))).toBe(true)
  })

  // Measured across the built-in models: 3 to 13 byte-identical calls in a single turn.
  it('stops executing a call the model keeps repeating verbatim', async () => {
    chat.rounds = Array.from({ length: 8 }, () => ({
      calls: [{ id: 'x', name: 'list_scenarios', arguments: '{"page":"a"}' }]
    }))
    const d = deps()
    await runAgent(request({ maxRounds: 8 }), d.deps)
    // Minus the per-turn study-language lookup (V291), which is not a tool call.
    const ran = d.apiCalls.filter((c) => !c.path.startsWith('/api/v1/study')).length
    expect(ran).toBe(3) // executed three times, then blocked
    const blocked = d.events.filter((e) => e.type === 'tool' && e.phase === 'error')
    expect(blocked.length).toBe(5)
    expect(String(blocked[0].detail)).toContain('already called')
  })

  it('lets a repeat through again once a mutation moved the state on', async () => {
    chat.rounds = [
      { calls: [{ id: 'a', name: 'list_models', arguments: '{}' }] },
      { calls: [{ id: 'b', name: 'list_models', arguments: '{}' }] },
      { calls: [{ id: 'c', name: 'list_models', arguments: '{}' }] },
      { calls: [{ id: 'd', name: 'delete_process', arguments: '{"database":"demo-model","code":"p1"}' }] },
      { calls: [{ id: 'e', name: 'list_models', arguments: '{}' }] },
      { text: 'done' }
    ]
    const d = deps()
    await runAgent(request({ maxRounds: 8 }), d.deps)
    expect(d.events.filter((e) => e.type === 'tool' && e.phase === 'error')).toEqual([])
  })

  it('stays quiet about rounds when the model actually answered', async () => {
    chat.rounds = [{ text: 'All done.' }]
    const res = await runAgent(request({ maxRounds: 3 }), deps().deps)
    expect(res.text).not.toContain('tool rounds')
  })
})

// The chat used to show only the tool that was running right then and throw the rest away, so a
// wrong call could only be diagnosed by reproducing it against a live model.
describe('runAgent — parallel-safe rounds (V285)', () => {
  /** apiRaw that records how many calls are in flight at once, with a small real delay. */
  function overlappingDeps(): ReturnType<typeof deps> & { maxInflight: () => number } {
    let inflight = 0
    let peak = 0
    const d = deps({
      apiRaw: async () => {
        inflight++
        peak = Math.max(peak, inflight)
        await new Promise((r) => setTimeout(r, 25))
        inflight--
        return { status: 200, body: { ok: true } }
      }
    })
    return Object.assign(d, { maxInflight: () => peak })
  }

  it('runs consecutive read-only calls of one round concurrently', async () => {
    chat.rounds = [
      {
        calls: [
          { id: 't1', name: 'search_background', arguments: '{"query":"steel tube"}' },
          { id: 't2', name: 'search_background', arguments: '{"query":"powder coating"}' }
        ]
      },
      { text: 'ok' }
    ]
    const d = overlappingDeps()
    await runAgent(request(), d.deps)
    expect(d.maxInflight()).toBe(2)
    // …and the tool results still stand in call order in the next round's prompt.
    const next = chat.seen[1].messages
    const toolMsgs = next.filter((m: { role: string }) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['t1', 't2'])
  })

  it('a mutating call is a barrier — nothing runs beside it', async () => {
    chat.rounds = [
      {
        calls: [
          { id: 't1', name: 'search_background', arguments: '{"query":"steel tube"}' },
          { id: 't2', name: 'edit_parameter', arguments: '{"action":"set","name":"mass","value":2}' },
          { id: 't3', name: 'search_background', arguments: '{"query":"powder coating"}' }
        ]
      },
      { text: 'ok' }
    ]
    const d = overlappingDeps()
    await runAgent(request(), d.deps)
    expect(d.maxInflight()).toBe(1)
    const next = chat.seen[1].messages
    const toolMsgs = next.filter((m: { role: string }) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['t1', 't2', 't3'])
  })
})

describe('runAgent — tool trace', () => {
  it('records each call with its arguments, timing and result preview', async () => {
    chat.rounds = [{ calls: [{ id: 't1', name: 'list_scenarios', arguments: '{"x":1}' }] }, { text: 'done' }]
    const res = await runAgent(request(), deps().deps)
    expect(res.trace).toHaveLength(1)
    expect(res.trace[0]).toMatchObject({ name: 'list_scenarios', args: '{"x":1}', status: 'ok' })
    expect(res.trace[0].preview).toContain('ok')
    expect(typeof res.trace[0].ms).toBe('number')
  })

  it('is empty when the model answers without tools', async () => {
    chat.rounds = [{ text: 'no tools needed' }]
    const res = await runAgent(request(), deps().deps)
    expect(res.trace).toEqual([])
  })

  it('separates a returned refusal from a thrown error', async () => {
    chat.rounds = [
      // manage_method_family rejects a rename with no new name (returned {"error": …}, not thrown).
      { calls: [{ id: 'a', name: 'manage_method_family', arguments: '{"action":"rename","family":"F"}' }] },
      { calls: [{ id: 'b', name: 'no_such_tool', arguments: '{}' }] },
      { text: 'ok' }
    ]
    const res = await runAgent(request(), deps().deps)
    expect(res.trace.map((t) => t.status)).toEqual(['rejected', 'error'])
    expect(res.trace[0].detail).toContain('name')
    expect(res.trace[1].detail).toContain('Unknown tool')
  })

  it('keeps the real result length when the preview is truncated', async () => {
    const huge = 'y'.repeat(TRACE_PREVIEW_CHARS * 3)
    chat.rounds = [{ calls: [{ id: 't1', name: 'list_scenarios', arguments: '{}' }] }, { text: 'done' }]
    const d = deps({ apiRaw: async () => ({ status: 200, body: huge }) })
    const res = await runAgent(request(), d.deps)
    expect(res.trace[0].preview?.length).toBe(TRACE_PREVIEW_CHARS)
    expect(res.trace[0].resultChars).toBeGreaterThan(TRACE_PREVIEW_CHARS)
  })

  it('hands the trace to the renderer on done, so it can attach it to the message', async () => {
    chat.rounds = [{ calls: [{ id: 't1', name: 'list_models', arguments: '{}' }] }, { text: 'done' }]
    const d = deps()
    await runAgent(request(), d.deps)
    const done = d.events.find((e) => e.type === 'done') as { trace?: unknown[] }
    expect(done.trace).toHaveLength(1)
  })
})

/** Counts the breakpoints in a snapshot of what was actually sent. */
const bps = (msgs: ChatMessage[]): number =>
  msgs.filter(
    (m) => Array.isArray(m.content) && m.content.some((p) => (p as Record<string, unknown>).cache_control)
  ).length

describe('markCacheBreakpoints', () => {
  const msg = (role: ChatMessage['role'], content: ChatMessage['content']): ChatMessage =>
    ({ role, content }) as ChatMessage

  it('marks system, first user and the last assistant turn with text', () => {
    const messages = [
      msg('system', 'prompt'),
      msg('user', 'build me a bottle'),
      msg('assistant', 'Looking at the model…'),
      msg('tool', 'a huge tool result'),
      msg('assistant', 'Now searching ecoinvent…'),
      msg('tool', 'another huge result')
    ]
    expect(markCacheBreakpoints(messages)).toBe(3)
    expect(bps(messages)).toBe(3)
    expect(Array.isArray(messages[4].content)).toBe(true) // the LAST assistant turn, not the first
    expect(Array.isArray(messages[2].content)).toBe(false)
    // Never on a tool result: a tool message carries a plain string, and re-shaping it is not a form
    // OpenRouter documents — a malformed cache block returns a generic 400 and breaks every chat.
    expect(messages.filter((m) => m.role === 'tool').every((m) => typeof m.content === 'string')).toBe(true)
  })

  it('moves the rolling breakpoint forward without leaving the old one behind', () => {
    const messages = [msg('system', 'prompt'), msg('user', 'task'), msg('assistant', 'round one')]
    markCacheBreakpoints(messages)
    messages.push(msg('tool', 'result'), msg('assistant', 'round two'))
    markCacheBreakpoints(messages)
    expect(bps(messages)).toBe(3) // still three, not four
    expect(Array.isArray(messages[4].content)).toBe(true)
    expect(messages[2].content).toBe('round one') // unmarked AND back to a plain string
  })

  it('never exceeds the four breakpoints Anthropic allows', () => {
    const messages = [
      msg('system', 's'),
      msg('user', 'u1'),
      msg('user', 'u2'),
      msg('assistant', 'a1'),
      msg('assistant', 'a2')
    ]
    expect(markCacheBreakpoints(messages)).toBeLessThanOrEqual(4)
  })

  it('skips an assistant turn that only called tools (content null)', () => {
    const messages = [
      msg('system', 's'),
      msg('user', 'u'),
      { role: 'assistant', content: null } as ChatMessage
    ]
    expect(markCacheBreakpoints(messages)).toBe(2) // system + user; nothing to attach to on the third
  })

  it('marks the last part of a multi-part message rather than replacing it', () => {
    const parts = [
      { type: 'text', text: 'Canvas screenshot:' },
      { type: 'image_url', image_url: { url: 'data:…' } }
    ]
    const messages = [msg('system', 's'), msg('user', parts as never)]
    markCacheBreakpoints(messages)
    const content = messages[1].content as Array<Record<string, unknown>>
    expect(content).toHaveLength(2) // image intact
    expect(content[1].cache_control).toEqual({ type: 'ephemeral' })
  })
})

describe('runAgent — prompt caching', () => {
  it('marks the system prompt as cacheable for Anthropic models', async () => {
    chat.rounds = [{ text: 'hi' }]
    await runAgent(request({ model: 'anthropic/claude-sonnet-5.5' }), deps().deps)
    const system = chat.seen[0].messages[0]
    expect(Array.isArray(system.content)).toBe(true)
    expect((system.content as Array<Record<string, unknown>>)[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('rolls the breakpoint forward as the run progresses', async () => {
    chat.rounds = [
      { text: 'Checking the model.', calls: [{ id: 'a', name: 'list_models', arguments: '{}' }] },
      {
        text: 'Now the details.',
        calls: [{ id: 'b', name: 'get_model_graph', arguments: '{"database":"demo-model"}' }]
      },
      { text: 'done' }
    ]
    await runAgent(request({ model: 'anthropic/claude-sonnet-5.5' }), deps().deps)
    // Every request carries exactly the three breakpoints, never an accumulating pile of them.
    for (const { messages: sent } of chat.seen) expect(bps(sent)).toBeLessThanOrEqual(3)
    // …and by the last round the rolling one sits on a later message than in the first.
    const lastMarked = (msgs: ChatMessage[]): number =>
      msgs.reduce(
        (idx, m, i) =>
          Array.isArray(m.content) && m.content.some((p) => (p as Record<string, unknown>).cache_control)
            ? i
            : idx,
        -1
      )
    expect(lastMarked(chat.seen[2].messages)).toBeGreaterThan(lastMarked(chat.seen[0].messages))
  })

  it('places the breakpoints only after compaction, so they point at surviving content', async () => {
    const huge = 'z'.repeat(120_000)
    chat.rounds = [
      ...Array.from({ length: 18 }, (_, i) => ({
        text: `step ${i}`,
        calls: [
          { id: `t${i}`, name: 'get_model_graph', arguments: `{"database":"demo-model","code":"p${i}"}` }
        ]
      })),
      { text: 'done' }
    ]
    const d = deps({ apiRaw: async () => ({ status: 200, body: huge }) })
    await runAgent(request({ model: 'anthropic/claude-sonnet-5.5' }), d.deps)
    const last = chat.seen.at(-1)!.messages
    // A stub left over from compaction must never be the thing a breakpoint hangs on.
    for (const m of last) {
      if (Array.isArray(m.content) && m.content.some((p) => (p as Record<string, unknown>).cache_control)) {
        expect(m.role === 'system' || m.role === 'user' || m.role === 'assistant').toBe(true)
        expect(JSON.stringify(m.content)).not.toContain('omitted to fit the context')
      }
    }
  })

  it('sends a plain system string for providers that cache on their own', async () => {
    chat.rounds = [{ text: 'hi' }]
    await runAgent(request({ model: 'z-ai/glm-5.3' }), deps().deps)
    expect(typeof chat.seen[0].messages[0].content).toBe('string')
  })
})

describe('runAgent — long-run robustness', () => {
  it('compacts old tool results once the history grows past the threshold', async () => {
    // Tool results are capped at 30k chars each, so it takes ~18 maximal rounds to cross the
    // 524k-char compaction threshold of a 256k-token model — the shape of a real runaway session.
    // Pinned to Hunyuan on purpose: this used to run on the default model and only compacted
    // because that model had no declared context window and fell back to the conservative value.
    // It has one now, so the test would have been quietly measuring nothing.
    const huge = 'x'.repeat(120_000)
    chat.rounds = [
      // Each round queries a different process — the repeat blocker only stops byte-identical calls,
      // and a real runaway session walks through the graph rather than re-sending one call.
      ...Array.from({ length: 30 }, (_, i) => ({
        calls: [
          { id: `t${i}`, name: 'get_model_graph', arguments: `{"database":"demo-model","code":"p${i}"}` }
        ]
      })),
      { text: 'done' }
    ]
    const d = deps({ apiRaw: async () => ({ status: 200, body: huge }) })
    const res = await runAgent(request({ model: SMALL_WINDOW }), d.deps)

    expect(res.aborted).toBe(false)
    const last = chat.seen.at(-1)!.messages
    const stubbed = last.filter(
      (m) => m.role === 'tool' && m.content === '[earlier tool result omitted to fit the context]'
    )
    expect(stubbed.length).toBeGreaterThan(0)
    // Dropped output is summarised (OpenHands measure ~2x lower cost vs. plain truncation) and the
    // gist is handed back, so the agent does not re-fetch what it already learned.
    expect(chat.toollessSeen).toBeGreaterThan(0)
    expect(
      last.some(
        (m) => typeof m.content === 'string' && m.content.startsWith('Summary of earlier tool results')
      )
    ).toBe(true)
    // Every assistant tool-call still has its matching tool message — otherwise the request is invalid.
    const callIds = last.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? [])
    const resultIds = last.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
    for (const id of callIds) expect(resultIds).toContain(id)
  })

  it('rescues a context-overflow rejection by compacting and retrying the round', async () => {
    const huge = 'y'.repeat(120_000)
    chat.rounds = [
      { calls: [{ id: 'a', name: 'get_model_graph', arguments: '{"database":"demo-model"}' }] },
      { calls: [{ id: 'b', name: 'get_model_graph', arguments: '{"database":"demo-model"}' }] },
      { throws: new FakeOpenRouterError("Request too long for this model's context window.", 'context') },
      { text: 'recovered' }
    ]
    const d = deps({ apiRaw: async () => ({ status: 200, body: huge }) })
    const res = await runAgent(request(), d.deps)

    expect(res.text).toContain('recovered')
    expect(d.events.find((e) => e.type === 'error')).toBeUndefined()
  })

  it('surfaces other provider errors instead of retrying them', async () => {
    chat.rounds = [{ throws: new FakeOpenRouterError('OpenRouter credits exhausted', 'credits') }]
    const d = deps()
    await runAgent(request(), d.deps)
    expect(d.events.at(-1)).toMatchObject({ type: 'error', code: 'credits' })
  })

  it('stops the run when the cost limit is reached and says so', async () => {
    chat.rounds = [
      { usage: { cost: 0.6 }, calls: [{ id: 'a', name: 'list_models', arguments: '{}' }] },
      { usage: { cost: 0.6 }, calls: [{ id: 'b', name: 'list_models', arguments: '{}' }] },
      { text: 'should never run' }
    ]
    const d = deps()
    const res = await runAgent(request({ maxCostUsd: 1 }), d.deps)

    expect(res.text).toContain('cost limit')
    expect(res.text).not.toContain('should never run')
    expect(chat.seen.length).toBe(2)
  })

  it('ignores the cost limit when it is switched off', async () => {
    chat.rounds = [
      { usage: { cost: 5 }, calls: [{ id: 'a', name: 'list_models', arguments: '{}' }] },
      { text: 'kept going' }
    ]
    const d = deps()
    const res = await runAgent(request({ maxCostUsd: 0 }), d.deps)
    expect(res.text).toContain('kept going')
  })

  it('records usage per round so aborted runs still account their spend', async () => {
    const recorded: Array<{ id: string; cost?: number; prompt?: number; cached?: number }> = []
    chat.rounds = [
      {
        usage: { cost: 0.25, prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 } },
        calls: [{ id: 'a', name: 'list_models', arguments: '{}' }]
      },
      { usage: { cost: 0.1 }, text: 'done' }
    ]
    const d = deps({ recordUsage: (id: string, u: Record<string, number>) => recorded.push({ id, ...u }) })
    await runAgent(request(), d.deps)
    expect(recorded).toEqual([
      { id: 'z-ai/glm-5.3', cost: 0.25, prompt: 1000, cached: 800 },
      { id: 'z-ai/glm-5.3', cost: 0.1, prompt: undefined, cached: undefined }
    ])
  })

  // The chat header adds these up over the conversation, so they have to arrive on the turn that
  // produced them and cover the same ground the cost covers.
  it('reports what the turn consumed, side models included', async () => {
    const events: Array<Record<string, unknown>> = []
    chat.rounds = [
      {
        usage: {
          cost: 0.25,
          prompt_tokens: 48_000,
          completion_tokens: 900,
          prompt_tokens_details: { cached_tokens: 37_440 }
        },
        calls: [{ id: 'a', name: 'list_models', arguments: '{}' }]
      },
      { usage: { cost: 0.1, prompt_tokens: 2_000, completion_tokens: 300 }, text: 'done' }
    ]
    const d = deps({ emit: (e: Record<string, unknown>) => events.push(e) })
    const res = await runAgent(request(), d.deps)
    const done = events.find((e) => e.type === 'done') as Record<string, number>
    expect(done.promptTokens).toBe(50_000)
    expect(done.cachedTokens).toBe(37_440)
    // The half the price hangs on, and the one the loop never reported before this.
    expect(done.completionTokens).toBe(1_200)
    // Same numbers on the result, because that is what the main process persists on the message.
    expect(res.promptTokens).toBe(50_000)
    expect(res.completionTokens).toBe(1_200)
    // The cached share is PART of the prompt, never a second one — the header's ratio depends on it.
    expect(done.cachedTokens).toBeLessThan(done.promptTokens)
  })

  // The summariser's spend used to bypass the ledger AND the limit entirely, so a long turn could
  // quietly exceed it. It runs on the chat model (it had a cheap model of its own
  // before), and is still booked as a call of its own.
  it('books the summariser under the chat model and counts it against the limit', async () => {
    const recorded: Array<{ id: string; cost?: number }> = []
    const huge = 'x'.repeat(120_000)
    chat.rounds = [
      ...Array.from({ length: 30 }, (_, i) => ({
        calls: [
          { id: `t${i}`, name: 'get_model_graph', arguments: `{"database":"demo-model","code":"p${i}"}` }
        ]
      })),
      { text: 'done' }
    ]
    summaryUsage = { cost: 0.02, prompt_tokens: 500 }
    const d = deps({
      apiRaw: async () => ({ status: 200, body: huge }),
      recordUsage: (id: string, u: { cost?: number }) => recorded.push({ id, cost: u.cost })
    })
    // Same reason as the compaction test above: a model with a genuinely small window, so that
    // there is something to summarise at all.
    await runAgent(request({ model: SMALL_WINDOW }), d.deps)
    expect(chat.toollessSeen).toBeGreaterThan(0)
    // Booked as its own call, under the chat model that wrote it.
    expect(recorded.some((r) => r.id === SMALL_WINDOW && r.cost === 0.02)).toBe(true)
  })
})

describe('runAgent — an empty round is not an answer (V17)', () => {
  it('retries once when a round returns neither text nor a tool call', async () => {
    chat.rounds = [{}, { text: 'Right, carrying on.' }]
    const d = deps()
    const res = await runAgent(request(), d.deps)

    expect(res.text).toBe('Right, carrying on.')
    // The retry has to SAY something, otherwise the model just repeats the empty completion.
    const second = chat.seen[1].messages
    expect(String(second[second.length - 1].content)).toMatch(/response was empty/i)
  })

  it('ends the turn out loud when the model returns nothing twice', async () => {
    chat.rounds = [{}, {}]
    const d = deps()
    const res = await runAgent(request(), d.deps)

    // The failure has to reach the user: before this it was booked as a finished answer, and 19
    // minutes of work vanished without a line in the UI, the log or the cost table.
    expect(res.text).toMatch(/returned nothing/i)
    expect(res.text).toMatch(/provider-side failure/i)
    // …and it must not ALSO claim the round budget ran out — that is a different failure.
    expect(res.text).not.toMatch(/tool rounds was reached/i)
  })

  it('still treats a round with text but no tool calls as the answer', async () => {
    chat.rounds = [{ text: 'All done.' }]
    const d = deps()
    expect((await runAgent(request(), d.deps)).text).toBe('All done.')
  })
})

describe('runAgent — the tool transcript survives the turn (V18)', () => {
  it('carries tool calls and results into the next turn on the same chat', async () => {
    chat.rounds = [
      { calls: [{ id: 't1', name: 'get_model_graph', arguments: '{}' }] },
      { text: 'Seven processes.' }
    ]
    await runAgent(request(), deps().deps)

    // Turn two, with the history the renderer would send back: prose only.
    chat.rounds = [{ text: 'Yes, seven.' }]
    await runAgent(
      request({
        history: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'Seven processes.' }
        ],
        userText: 'how many again?'
      }),
      deps().deps
    )

    const sent = chat.seen.at(-1)!.messages
    expect(sent.some((m) => m.role === 'tool')).toBe(true)
    expect(sent.some((m) => m.role === 'assistant' && m.tool_calls?.length)).toBe(true)
    // The answer the user saw is in there too, so the model is not told it said nothing.
    expect(sent.some((m) => m.role === 'assistant' && m.content === 'Seven processes.')).toBe(true)
  })

  it('falls back to the prose history when the renderer sends something else', async () => {
    chat.rounds = [
      { calls: [{ id: 't1', name: 'get_model_graph', arguments: '{}' }] },
      { text: 'Seven processes.' }
    ]
    await runAgent(request(), deps().deps)

    // A reloaded, edited or truncated chat must not be answered from a transcript that no longer
    // matches what the user can see.
    chat.rounds = [{ text: 'Starting over.' }]
    await runAgent(
      request({ history: [{ role: 'user', content: 'something else entirely' }], userText: 'go' }),
      deps().deps
    )

    const sent = chat.seen.at(-1)!.messages
    expect(sent.some((m) => m.role === 'tool')).toBe(false)
  })
})

describe('runAgent — stops, switched-off tools, spend and truncation', () => {
  it('runs nothing further in a round once the user stopped', async () => {
    const ctrl = new AbortController()
    chat.rounds = [
      {
        calls: [
          { id: 'a', name: 'list_models', arguments: '{}' },
          { id: 'b', name: 'list_models', arguments: '{}' }
        ]
      },
      { text: 'never' }
    ]
    // The turn's own setup calls (briefs, skills) come first; the stop has to land on the TOOL call.
    const saved = chat.rounds
    chat.rounds = [{ text: 'ok' }]
    const baseline = deps()
    await runAgent(request(), baseline.deps)
    chat.rounds = saved
    const d = deps({
      apiRaw: async (method: string, path: string) => {
        d.apiCalls.push({ method, path })
        if (d.apiCalls.length > baseline.apiCalls.length) ctrl.abort() // Stop while the first tool call runs
        return { status: 200, body: { models: [] } }
      }
    })
    const res = await runAgent(request({ signal: ctrl.signal }), d.deps)
    expect(res.aborted).toBe(true)
    // Setup plus ONE tool call; the second call of the round never started.
    expect(d.apiCalls).toHaveLength(baseline.apiCalls.length + 1)
  })

  it('does not execute a tool that is switched off, whatever the model asks', async () => {
    // What a turn calls the backend for on its own (briefs, skills), so the tool's call shows as the difference.
    chat.rounds = [{ text: 'ok' }]
    const baseline = deps()
    await runAgent(request(), baseline.deps)
    chat.rounds = [{ calls: [{ id: 'a', name: 'list_models', arguments: '{}' }] }, { text: 'ok' }]
    const d = deps()
    const res = await runAgent(request({ disabledTools: ['list_models'] }), d.deps)
    expect(d.apiCalls).toHaveLength(baseline.apiCalls.length)
    expect(res.trace[0]).toMatchObject({ name: 'list_models', status: 'error' })
    expect(JSON.stringify(res.trace[0])).toContain('switched off')
  })

  it('returns the spend so far when the run is stopped', async () => {
    const ctrl = new AbortController()
    chat.rounds = [
      {
        usage: { cost: 0.4, prompt_tokens: 100 },
        calls: [{ id: 'a', name: 'list_models', arguments: '{}' }]
      },
      { text: 'never' }
    ]
    const saved = chat.rounds
    chat.rounds = [{ text: 'ok' }]
    const baseline = deps()
    await runAgent(request(), baseline.deps)
    chat.rounds = saved
    const d = deps({
      apiRaw: async (method: string, path: string) => {
        d.apiCalls.push({ method, path })
        if (d.apiCalls.length > baseline.apiCalls.length) ctrl.abort() // Stop while the tool runs
        return { status: 200, body: { models: [] } }
      }
    })
    const res = await runAgent(request({ signal: ctrl.signal }), d.deps)
    expect(res.aborted).toBe(true)
    expect(res.cost).toBeCloseTo(0.4, 6)
    expect(res.promptTokens).toBe(100)
  })

  it('says when the provider cut the answer off at its output limit', async () => {
    chat.rounds = [{ text: 'The table begins | a | b', finish: 'length' }]
    const d = deps()
    const res = await runAgent(request(), d.deps)
    expect(res.text).toContain('cut off at the model')
    expect(d.events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('rebuilds a stored turn with stubs for its attachments', async () => {
    chat.rounds = [{ text: 'ok' }]
    await runAgent(
      request({
        history: [
          {
            role: 'user',
            content: 'What does the datasheet say?',
            attachments: [{ id: 'ab12-spec.pdf', name: 'spec.pdf', kind: 'pdf', bytes: 1000 }]
          },
          { role: 'assistant', content: 'About 2 kg.' }
        ]
      }),
      deps().deps
    )
    const first = chat.seen[0].messages.find((m) => m.role === 'user')
    expect(String(first?.content)).toContain('lookup kind="source", source="ab12-spec.pdf"')
  })
})

describe('durable: the plan tool and the transcript', () => {
  const planCall = (id: string, args: unknown): { id: string; name: string; arguments: string } => ({
    id,
    name: 'plan',
    arguments: JSON.stringify(args)
  })
  const firstPlan = {
    title: 'Bottle model',
    steps: [
      { step: 'Record goal and scope', status: 'in_progress' },
      { step: 'Link PET granulate', status: 'pending' }
    ]
  }
  const toolNames = (call: { tools?: unknown[] }): string[] =>
    (call.tools ?? []).map((t) => (t as { function: { name: string } }).function.name)

  it('writes an accepted plan through persistPlan, emits the plan event and hands the list back', async () => {
    chat.rounds = [{ calls: [planCall('p1', firstPlan)] }, { text: 'Planned.' }]
    const saved: unknown[] = []
    const d = deps({ persistPlan: async (p: unknown) => void saved.push(p) })
    const res = await runAgent(request(), d.deps)
    expect(res.outcome).toBe('answered')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ title: 'Bottle model', revision: 1 })
    expect(d.events.find((e) => e.type === 'plan')).toMatchObject({ type: 'plan' })
    const toolMsg = chat.seen[1].messages.find((m) => m.role === 'tool')
    expect(String(toolMsg?.content)).toContain('Plan updated · 0/2')
    expect(String(toolMsg?.content)).toContain('[>] 1. Record goal and scope')
  })

  it('refuses a bad update with the reason and the list that still stands', async () => {
    chat.rounds = [
      { calls: [planCall('p1', firstPlan)] },
      {
        calls: [
          planCall('p2', {
            steps: [
              { step: 'Record goal and scope', status: 'in_progress' },
              { step: 'Link PET granulate', status: 'in_progress' }
            ]
          })
        ]
      },
      { text: 'ok' }
    ]
    const saved: unknown[] = []
    const d = deps({ persistPlan: async (p: unknown) => void saved.push(p) })
    await runAgent(request(), d.deps)
    expect(saved).toHaveLength(1) // the second call changed nothing
    const second = chat.seen[2].messages.filter((m) => m.role === 'tool').at(-1)
    const body = JSON.parse(String(second?.content)) as { error: string; current_plan?: string }
    expect(body.error).toContain('in_progress')
    expect(body.current_plan).toContain('Bottle model')
  })

  it('planTool false: no spec, no prompt paragraph, and a guessed call is refused', async () => {
    chat.rounds = [{ calls: [planCall('p1', firstPlan)] }, { text: 'ok' }]
    const saved: unknown[] = []
    const d = deps({ persistPlan: async (p: unknown) => void saved.push(p) })
    await runAgent(request({ planTool: false }), d.deps)
    expect(toolNames(chat.seen[0])).not.toContain('plan')
    const system = chat.seen[0].messages.find((m) => m.role === 'system')
    expect(String(system?.content)).not.toContain('Task plan')
    const toolMsg = chat.seen[1].messages.find((m) => m.role === 'tool')
    expect(String(toolMsg?.content)).toContain('switched off')
    expect(saved).toHaveLength(0)
  })

  it('planTool on by default: the spec and the paragraph are there', async () => {
    chat.rounds = [{ text: 'ok' }]
    await runAgent(request(), deps().deps)
    expect(toolNames(chat.seen[0])).toContain('plan')
    expect(String(chat.seen[0].messages[0].content)).toContain('Task plan')
  })

  it('Stop keeps the transcript — in memory and in the store — with outcome cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    const stored: unknown[] = []
    const d = deps({
      transcriptStore: {
        load: async () => null,
        save: async (_id: string, t: unknown) => void stored.push(t)
      }
    })
    const res = await runAgent(request({ signal: ac.signal }), d.deps)
    expect(res).toMatchObject({ aborted: true, outcome: 'cancelled' })
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ turnId: res.turnId })
    expect(
      (stored[0] as { messages: unknown[] }).messages.some((m) => (m as { role: string }).role === 'system')
    ).toBe(false)
  })

  it('tells the model the plan and the stop reason when the transcript is rebuilt from prose', async () => {
    chat.rounds = [{ text: 'Continuing.' }]
    const plan = {
      title: 'Bottle model',
      steps: [{ step: 'Link PET granulate', status: 'in_progress' as const }],
      revision: 3,
      updated: 'x'
    }
    await runAgent(
      request({
        history: [
          { role: 'user', content: 'build it' },
          { role: 'assistant', content: 'Stopped at round limit.' }
        ],
        userText: 'Continue with the plan.',
        plan,
        resumeFrom: 'rounds'
      }),
      deps().deps
    )
    const sent = chat.seen[0].messages
    const preface = sent[sent.length - 2]
    expect(preface.role).toBe('user')
    expect(String(preface.content)).toContain('Current plan (from the previous run)')
    expect(String(preface.content)).toContain('[>] 1. Link PET granulate')
    expect(String(preface.content)).toContain('round limit was reached')
    expect(String(preface.content)).toContain('Verify the model state')
    // The user turn opens with the per-turn note (study language, V418); the prose follows it.
    const last = sent[sent.length - 1]
    expect(last.role).toBe('user')
    expect(String(last.content)).toMatch(/^\[(Study language|No study language)/)
    expect(String(last.content).endsWith('Continue with the plan.')).toBe(true)
  })

  it('carries a stored transcript from disk when the history matches, and rebuilds when it is unpaired', async () => {
    const history = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'Earlier answer' }
    ]
    const tool = {
      role: 'assistant' as const,
      content: null,
      tool_calls: [
        { id: 't1', type: 'function' as const, function: { name: 'list_models', arguments: '{}' } }
      ]
    }
    const good = {
      turnId: 'turn-old',
      historyAfter: history,
      messages: [
        { role: 'user' as const, content: 'hello' },
        tool,
        { role: 'tool' as const, tool_call_id: 't1', content: '[]' },
        { role: 'assistant' as const, content: 'Earlier answer' }
      ]
    }
    chat.rounds = [{ text: 'ok' }]
    await runAgent(
      request({ history, userText: 'next' }),
      deps({ transcriptStore: { load: async () => good, save: async () => undefined } }).deps
    )
    expect(chat.seen[0].messages.some((m) => m.role === 'tool' && m.tool_call_id === 't1')).toBe(true)

    chat.seen.length = 0
    chat.rounds = [{ text: 'ok' }]
    forgetTranscript()
    const unpaired = { ...good, messages: good.messages.filter((m) => m.role !== 'tool') }
    await runAgent(
      request({ history, userText: 'next' }),
      deps({ transcriptStore: { load: async () => unpaired, save: async () => undefined } }).deps
    )
    expect(chat.seen[0].messages.some((m) => m.role === 'tool')).toBe(false)
  })
})

describe('runAgent — the stall guard (rounds that only hear "no")', () => {
  const failing = (id: string) => ({ calls: [{ id, name: 'no_such_tool', arguments: '{}' }] })

  it('nudges after three failed rounds and stops after six', async () => {
    chat.rounds = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => failing(`f${n}`))
    chat.rounds.push({ text: 'never reached' })
    const d = deps()
    const res = await runAgent(request(), d.deps)
    expect(res.outcome).toBe('stalled')
    expect(res.text).toMatch(/Stopped: 6 rounds in a row produced only rejected or failed tool calls/)
    // Six rounds were requested, the seventh was not.
    expect(chat.seen.length).toBe(6)
    // The nudge sits in the request of round four, after round three's results.
    const fourth = chat.seen[3].messages
    const nudge = fourth.findIndex(
      (m) => m.role === 'user' && String(m.content).includes('produced only rejected or failed tool calls')
    )
    expect(nudge).toBeGreaterThan(0)
    expect(chat.seen[2].messages.some((m) => String(m.content).includes('produced only rejected'))).toBe(
      false
    )
  })

  it('is reset by any call that lands, so a batch of refusals worked through one by one is progress', async () => {
    const ok = (id: string) => ({ calls: [{ id, name: 'list_models', arguments: '{}' }] })
    chat.rounds = [
      failing('a'),
      failing('b'),
      ok('c'),
      failing('d'),
      failing('e'),
      ok('f'),
      failing('g'),
      { text: 'done' }
    ]
    const d = deps()
    const res = await runAgent(request(), d.deps)
    expect(res.outcome).toBe('answered')
    expect(
      chat.seen.flatMap((c) => c.messages).some((m) => String(m.content).includes('produced only rejected'))
    ).toBe(false)
  })
})

describe("runAgent — context accounting by the provider's own count", () => {
  it('compacts on prompt_tokens even when the character guess says there is room, and emits the level', async () => {
    // SMALL_WINDOW: 262 144 tokens, budget 131 072. The characters never come near the 524k-char
    // threshold — but the provider reports the fourth request at 131 000 tokens, and the next
    // round's tool result takes the projection over the budget.
    const call = (i: number) => ({
      calls: [{ id: `t${i}`, name: 'get_model_graph', arguments: `{"database":"demo-model","code":"p${i}"}` }]
    })
    chat.rounds = [
      { ...call(1), usage: { prompt_tokens: 20_000 } },
      { ...call(2), usage: { prompt_tokens: 20_000 } },
      { ...call(3), usage: { prompt_tokens: 20_000 } },
      { ...call(4), usage: { prompt_tokens: 131_000 } },
      { ...call(5), usage: { prompt_tokens: 50_000 } },
      { text: 'done' }
    ]
    const d = deps({ apiRaw: async () => ({ status: 200, body: 'y'.repeat(2_000) }) })
    const res = await runAgent(request({ model: SMALL_WINDOW }), d.deps)
    expect(res.outcome).toBe('answered')
    // Round 5's request was compacted: round 1's result is a stub, the last three are not.
    const fifth = chat.seen[4].messages
    const stubs = fifth.filter(
      (m) => m.role === 'tool' && m.content === '[earlier tool result omitted to fit the context]'
    )
    expect(stubs.length).toBe(1)
    // The character guess alone would not have compacted anything (the old trigger).
    expect(JSON.stringify(chat.seen[3].messages).length).toBeLessThan(100_000)
    // The level after every counted round, window and budget included; the turn keeps the last one.
    const levels = d.events.filter((e) => e.type === 'context') as unknown as Array<{
      tokens: number
      window?: number
      budget: number
    }>
    expect(levels.map((l) => l.tokens)).toEqual([20_000, 20_000, 20_000, 131_000, 50_000])
    expect(levels[0]).toMatchObject({ window: 262144, budget: 131072 })
    expect(res.contextTokens).toBe(50_000)
    expect(d.events.at(-1)).toMatchObject({ type: 'done', contextTokens: 50_000 })
  })
})

describe('runAgent — the confirmation card before irreversible actions', () => {
  const asked: Array<[string, Record<string, unknown>]> = []
  const ui =
    (answer: unknown) =>
    async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      asked.push([name, args])
      return name === 'approve_tool' ? answer : { answers: ['Yes'] }
    }
  beforeEach(() => {
    asked.length = 0
  })

  // Renaming its own model is the one model-level operation the chat keeps (modelScope.ts).
  const RENAME = '{"action":"rename","database":"demo-model","name":"demo-2"}'

  it('asks before an irreversible call, runs it when allowed, and hands preApproved to the tool', async () => {
    chat.rounds = [{ calls: [{ id: 'd', name: 'manage_model', arguments: RENAME }] }, { text: 'renamed' }]
    const d = deps({ callUiTool: ui({ approved: true }) })
    const res = await runAgent(request(), d.deps)
    expect(res.outcome).toBe('answered')
    expect(asked.map(([n]) => n)).toEqual(['approve_tool'])
    expect(asked[0][1]).toMatchObject({
      tool: 'manage_model',
      effect: 'irreversible',
      database: 'demo-model'
    })
    expect(d.apiCalls.some((c) => c.path === '/api/v1/databases/foreground/rename')).toBe(true)
  })

  it('moves the chat along when it renames its own model', async () => {
    chat.rounds = [{ calls: [{ id: 'd', name: 'manage_model', arguments: RENAME }] }, { text: 'renamed' }]
    const renamed: string[] = []
    const uiModels: unknown[] = []
    const d = deps({
      callUiTool: async (name: string, _args: unknown, opts: { activeDb?: string }) => {
        uiModels.push(opts?.activeDb)
        return name === 'approve_tool' ? { approved: true } : { ok: true }
      },
      onModelRenamed: (name: string) => renamed.push(name)
    })
    await runAgent(request(), d.deps)
    expect(renamed).toEqual(['demo-2'])
  })

  it('refuses the call with the model-facing sentence when the card is declined', async () => {
    chat.rounds = [{ calls: [{ id: 'd', name: 'manage_model', arguments: RENAME }] }, { text: 'ok' }]
    const d = deps({ callUiTool: ui({ approved: false }) })
    await runAgent(request(), d.deps)
    const toolMsg = chat.seen[1].messages.find((m) => m.role === 'tool')
    expect(String(toolMsg?.content)).toContain('declined this action on the confirmation card')
    expect(d.apiCalls.filter((c) => !c.path.startsWith('/api/v1/study'))).toEqual([])
  })

  it('never shows the card for undo/redo, for an ordinary write, or when the setting says never', async () => {
    chat.rounds = [
      { calls: [{ id: 'a', name: 'history', arguments: '{"action":"undo"}' }] },
      { calls: [{ id: 'b', name: 'delete_process', arguments: '{"code":"p1"}' }] },
      { text: 'ok' }
    ]
    await runAgent(request(), deps({ callUiTool: ui({ approved: false }) }).deps)
    expect(asked).toEqual([])
    chat.rounds = [
      {
        calls: [
          { id: 'd', name: 'edit_lcia_method', arguments: '{"action":"delete","method":["Mine","GWP"]}' }
        ]
      },
      { text: 'ok' }
    ]
    await runAgent(request({ approval: 'never' }), deps({ callUiTool: ui({ approved: false }) }).deps)
    // No approval card — but deleting a custom method asks its own question in every mode: it cannot
    // be undone.
    expect(asked.map((a) => a[0])).toEqual(['ask_user'])
  })

  it("refuses a call outside the chat's model before any card is shown", async () => {
    chat.rounds = [
      {
        calls: [
          {
            id: 'd',
            name: 'manage_model',
            arguments: '{"action":"rename","database":"production","name":"p2"}'
          }
        ]
      },
      { text: 'ok' }
    ]
    const d = deps({
      callUiTool: ui({ approved: true }),
      apiRaw: async (method: string, path: string) => {
        d.apiCalls.push({ method, path })
        const body =
          path === '/api/v1/databases' ? [{ name: 'production', kind: 'foreground' }] : { ok: true }
        return { status: 200, body }
      }
    })
    await runAgent(request({ activeDb: 'scratch' }), d.deps)
    expect(asked).toEqual([])
    const toolMsg = chat.seen[1].messages.find((m) => m.role === 'tool')
    expect(JSON.parse(String(toolMsg?.content)).error).toContain('this chat changes only "scratch"')
    expect(d.apiCalls.some((c) => c.path.includes('/rename'))).toBe(false)
  })

  it('tells the model to confirm itself when the card is switched off, and not to when it is on', async () => {
    chat.rounds = [{ text: 'ok' }]
    await runAgent(request(), deps().deps)
    const withCard = String(chat.seen.at(-1)!.messages[0].content)
    expect(withCard).toMatch(/shows the user a confirmation card/)
    expect(withCard).not.toMatch(/confirm intent with the user first/)
    chat.rounds = [{ text: 'ok' }]
    await runAgent(request({ approval: 'never' }), deps().deps)
    const without = String(chat.seen.at(-1)!.messages[0].content)
    expect(without).toMatch(/confirm intent with the user first/)
    expect(without).not.toMatch(/shows the user a confirmation card/)
  })

  it('lets a tool with its own question skip it once the card has answered (custom-method delete)', async () => {
    chat.rounds = [
      {
        calls: [{ id: 'd', name: 'edit_lcia_method', arguments: '{"action":"delete","method":["My","GWP"]}' }]
      },
      { text: 'ok' }
    ]
    await runAgent(request(), deps({ callUiTool: ui({ approved: true }) }).deps)
    expect(asked.map(([n]) => n)).toEqual(['approve_tool'])
  })
})

describe('runAgent — steering: what the user types while the run works', () => {
  it('hands a queued message to the model at the next round boundary and shows it in the answer', async () => {
    chat.rounds = [
      { text: 'Reading.', calls: [{ id: 'a', name: 'list_models', arguments: '{}' }] },
      { text: 'Ok, using kg.', calls: [{ id: 'b', name: 'list_models', arguments: '{}' }] },
      { text: 'Done.' }
    ]
    // Nothing left over from an earlier run, nothing queued when round 1 goes out; typed while
    // round 1's tool runs. (The first drain is the leftover check at run start.)
    const queue = [[], [], ['use kilograms, not tonnes']]
    const d = deps({ takeSteering: () => queue.shift() ?? [] })
    const res = await runAgent(request(), d.deps)
    // Round 1's request had nothing queued yet (the queue is read before each request).
    expect(chat.seen[0].messages.some((m) => String(m.content).includes('kilograms'))).toBe(false)
    // Round 2's request: the tool result of round 1, then the user's words, as a user turn.
    const second = chat.seen[1].messages
    const at = second.findIndex(
      (m) => m.role === 'user' && String(m.content).includes('use kilograms, not tonnes')
    )
    expect(at).toBeGreaterThan(0)
    expect(second[at - 1].role).toBe('tool')
    expect(String(second[at].content)).toMatch(/Sent while you were working/)
    // And in the visible answer, quoted, between the two rounds' prose.
    expect(res.text).toMatch(/Reading\.[\s\S]*> \*\*You:\*\* use kilograms, not tonnes[\s\S]*Ok, using kg/)
    expect(res.outcome).toBe('answered')
  })

  it('turns a message queued during the final answer into another round instead of ending', async () => {
    chat.rounds = [{ text: 'All done.' }, { text: 'Also checked the unit.' }]
    // No leftover, nothing queued before round 1's request; one message by the time the model has answered.
    const answers = [[], [], ['and check the unit']]
    const d = deps({ takeSteering: () => answers.shift() ?? [] })
    const res = await runAgent(request(), d.deps)
    expect(chat.seen.length).toBe(2)
    const second = chat.seen[1].messages
    expect(second.at(-2)).toMatchObject({ role: 'assistant', content: 'All done.' })
    expect(String(second.at(-1)?.content)).toContain('and check the unit')
    expect(res.text).toMatch(/All done\.[\s\S]*> \*\*You:\*\* and check the unit[\s\S]*Also checked the unit/)
  })

  it('puts a message left over from the previous run BEFORE the new message, not after it', async () => {
    chat.rounds = [{ text: 'ok' }]
    const queue = [['set the mass to 10 kg']]
    await runAgent(
      request({ userText: 'actually use 20 kg' }),
      deps({ takeSteering: () => queue.shift() ?? [] }).deps
    )
    const msgs = chat.seen[0].messages.map((m) => String(m.content))
    const older = msgs.findIndex((c) => c.includes('set the mass to 10 kg'))
    const newer = msgs.findIndex((c) => c.endsWith('actually use 20 kg')) // behind the per-turn note (V418)
    expect(older).toBeGreaterThan(0)
    expect(older).toBeLessThan(newer)
    expect(msgs[older]).toMatch(/previous run was working, before the message below/)
  })

  it('changes nothing when the caller offers no steering', async () => {
    chat.rounds = [{ text: 'All done.' }]
    const res = await runAgent(request(), deps().deps)
    expect(res.text).toBe('All done.')
    expect(chat.seen.length).toBe(1)
  })
})

describe('runAgent — reasoning effort', () => {
  it('sends the chosen level with every round, and nothing when none is chosen', async () => {
    chat.rounds = [{ calls: [{ id: 'a', name: 'list_models', arguments: '{}' }] }, { text: 'ok' }]
    await runAgent(request({ reasoningEffort: 'high' }), deps().deps)
    expect(chat.seen.map((c) => c.reasoningEffort)).toEqual(['high', 'high'])
    chat.rounds = [{ text: 'ok' }]
    await runAgent(request(), deps().deps)
    expect(chat.seen.at(-1)?.reasoningEffort).toBeUndefined()
  })

  it('falls back to the default once when the API rejects the level, and says so', async () => {
    chat.rounds = [
      {
        throws: new FakeOpenRouterError(
          'OpenRouter error (HTTP 400) — reasoning.effort "xhigh" is not supported.',
          'http'
        )
      },
      { text: 'fine without it' }
    ]
    const res = await runAgent(request({ reasoningEffort: 'xhigh' }), deps().deps)
    expect(res.outcome).toBe('answered')
    expect(chat.seen.map((c) => c.reasoningEffort)).toEqual(['xhigh', undefined])
    expect(res.text).toMatch(/rejected the reasoning effort "xhigh"/)
    expect(res.text).toContain('fine without it')
  })
})

// The provider's own web lookups inside a reply (OpenRouter server tools). Nothing else in the stream
// shows them, and each one re-runs the whole conversation through the model — one real run
// billed 375k prompt tokens for an 85k conversation that way, with the model claiming it had never
// used the web (V398). One trace row, before the round's own calls, from the usage counters.
describe('web lookups by the provider', () => {
  it('adds one trace row per round that ran lookups, and none otherwise', async () => {
    const events: Array<Record<string, unknown>> = []
    chat.rounds = [
      {
        usage: {
          cost: 0.24,
          prompt_tokens: 375_585,
          prompt_tokens_details: { cached_tokens: 327_340 },
          server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 }
        },
        calls: [{ id: 'a', name: 'list_models', arguments: '{}' }]
      },
      { usage: { cost: 0.02, prompt_tokens: 70_000 }, text: 'done' }
    ]
    const d = deps({ emit: (e: Record<string, unknown>) => events.push(e) })
    const res = await runAgent(request(), d.deps)
    const rows = res.trace.filter((t) => t.name === 'web_lookups')
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('ok')
    expect(rows[0].preview).toContain('2 web searches, 1 page fetched')
    expect(rows[0].preview).toContain('4 passes')
    // Before the round's own call, which is the order things happened in.
    expect(res.trace.map((t) => t.name)).toEqual(['web_lookups', 'list_models'])
    // Live too: a start and a done event, so the row fills in place while the turn runs.
    const live = events.filter((e) => e.type === 'tool' && e.name === 'web_lookups').map((e) => e.phase)
    expect(live).toEqual(['start', 'done'])
  })

  it('ignores empty or zero counters', async () => {
    chat.rounds = [
      {
        usage: { cost: 0.01, prompt_tokens: 1000, server_tool_use: { web_search_requests: 0 } },
        text: 'done'
      }
    ]
    const res = await runAgent(request(), deps().deps)
    expect(res.trace.some((t) => t.name === 'web_lookups')).toBe(false)
  })
})
