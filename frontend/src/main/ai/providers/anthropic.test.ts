/**
 * The direct-Anthropic transport, checked where its differences bite: the Messages request (pinned API
 * version, no sampling parameters, reasoning that degrades instead of failing), the content blocks that
 * must travel back with every tool round inside the turn and must not outlive it, the cache breakpoints,
 * the locally synthesized cost (cache writes, cache reads, Haiku's longer-prompt tier, the search fee),
 * the citations, a paused server-tool turn and the error shapes. The event fixtures are trimmed copies of
 * streams the live API sent on 2026-11-08.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-anthropic-test', getAppPath: () => '/tmp/prism-anthropic-test' }
}))

process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'

const { streamChat, transcribeAudio } = await import('../client')
const { setActiveProvider } = await import('./state')
const { anthropicTransport, API_VERSION, BETA_THINKING_BINDING, effortFor, toMessages, usageEvent } =
  await import('./anthropic')
import { assistantToolTurn, type ChatMessage, type StreamEvent } from './types'

const API = 'https://api.anthropic.com/v1/messages'

/** One SSE response made of Messages events, in the API's own framing (`event:` + `data:`). */
function sse(events: Array<Record<string, unknown>>): Response {
  const chunk = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join('')
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(chunk))
        c.close()
      }
    })
  } as unknown as Response
}

function fail(status: number, body: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => body,
    body: null
  } as unknown as Response
}

const usage0 = {
  input_tokens: 487,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 6
}
const messageStart = (usage: Record<string, unknown> = usage0, extra: Record<string, unknown> = {}) => ({
  type: 'message_start',
  message: { id: 'msg_1', type: 'message', model: 'claude-sonnet-5-5', usage, ...extra }
})
const blockStart = (index: number, content_block: Record<string, unknown>) => ({
  type: 'content_block_start',
  index,
  content_block
})
const blockDelta = (index: number, delta: Record<string, unknown>) => ({
  type: 'content_block_delta',
  index,
  delta
})
const blockStop = (index: number) => ({ type: 'content_block_stop', index })
const messageDelta = (stop_reason: string, usage: Record<string, unknown>) => ({
  type: 'message_delta',
  delta: { stop_reason, stop_sequence: null },
  usage
})
const messageStop = { type: 'message_stop' }

/** A thinking round that ends in one tool call — the shape a live Haiku round had. */
const toolRound = [
  messageStart(),
  blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
  blockDelta(0, { type: 'thinking_delta', thinking: 'I can compare the two packages.' }),
  blockDelta(0, { type: 'signature_delta', signature: 'CAQS6RoKEAgTGAI4AU' }),
  blockStop(0),
  blockStart(1, {
    type: 'tool_use',
    id: 'toolu_01J2',
    name: 'get_weather',
    input: {},
    caller: { type: 'direct' }
  }),
  blockDelta(1, { type: 'input_json_delta', partial_json: '' }),
  blockDelta(1, { type: 'input_json_delta', partial_json: '{"city": "Pari' }),
  blockDelta(1, { type: 'input_json_delta', partial_json: 's"}' }),
  blockStop(1),
  messageDelta('tool_use', { ...usage0, output_tokens: 1458 }),
  messageStop
]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  setActiveProvider('anthropic')
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setActiveProvider('openrouter')
})

async function collect(opts: Partial<Parameters<typeof streamChat>[0]> = {}): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const ev of streamChat({
    model: 'claude-sonnet-5-5',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: null,
    ...opts
  }))
    out.push(ev)
  return out
}

const sentBody = (call = 0): Record<string, any> => JSON.parse(fetchMock.mock.calls[call][1].body)

describe('the request', () => {
  it('pins the API version, asks to drop reasoning a changed conversation invalidated, sends no sampling', async () => {
    fetchMock.mockResolvedValueOnce(sse(toolRound))
    await collect({ temperature: 0.7, reasoningEffort: 'high', maxTokens: 500_000 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(API)
    expect(init.headers['anthropic-version']).toBe(API_VERSION)
    expect(init.headers['anthropic-beta']).toBe(BETA_THINKING_BINDING)
    expect(init.headers['x-api-key']).toBe('test-anthropic-key')
    const body = sentBody()
    expect(body.temperature).toBeUndefined()
    expect(body.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' }
    })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.max_tokens).toBe(128_000)
    expect(body.tool_choice).toBeUndefined()
  })

  it('maps the effort vocabulary onto the levels the API has, and leaves the default alone', () => {
    expect(effortFor(undefined)).toBeUndefined()
    expect(effortFor('none')).toBe('low')
    expect(effortFor('minimal')).toBe('low')
    expect(effortFor('xhigh')).toBe('xhigh')
  })

  it('carries web search as the basic server tool, with its cap and its domain list', async () => {
    fetchMock.mockResolvedValueOnce(sse(toolRound))
    await collect({ webSearch: true, webLookupsCap: 3, webDomains: ['plasticseurope.org'] })
    expect(sentBody().tools).toEqual([
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
        allowed_domains: ['plasticseurope.org']
      }
    ])
  })

  it('adds the moving cache breakpoint to a tool loop, never to a one-shot request, never as a fifth', async () => {
    const tool = {
      type: 'function' as const,
      function: { name: 'list_models', description: 'List', parameters: { type: 'object', properties: {} } }
    }
    // A fresh stream per request: a body can be read once.
    fetchMock.mockImplementation(async () => sse(toolRound))
    await collect({ tools: [tool] })
    expect(sentBody(0).cache_control).toEqual({ type: 'ephemeral' })
    expect(sentBody(0).tools[0]).toEqual({
      name: 'list_models',
      description: 'List',
      input_schema: tool.function.parameters
    })
    await collect()
    expect(sentBody(1).cache_control).toBeUndefined()
    await collect({ cacheTail: true })
    expect(sentBody(2).cache_control).toEqual({ type: 'ephemeral' })
    // Four breakpoints placed already: the automatic one would be the fifth, a 400.
    const marked = (text: string): ChatMessage['content'] => [
      { type: 'text', text, cache_control: { type: 'ephemeral' } }
    ]
    await collect({
      tools: [tool],
      messages: [
        { role: 'system', content: marked('system') },
        { role: 'user', content: marked('task') },
        { role: 'assistant', content: marked('a') },
        { role: 'user', content: marked('b') }
      ]
    })
    expect(sentBody(3).cache_control).toBeUndefined()
    expect(sentBody(3).system).toEqual([
      { type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }
    ])
  })
})

describe('the transcript', () => {
  const callMsg = (id: string): ChatMessage =>
    assistantToolTurn(null, [{ id, name: 'get_weather', arguments: '{"city":"Paris"}' }], {
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      steps: [
        { type: 'thinking', thinking: 'plan', signature: 'SIG' },
        { type: 'tool_use', id, name: 'get_weather', input: { city: 'Paris' }, caller: { type: 'direct' } }
      ]
    })

  it('puts tool results first in the user turn after the call, the screenshot after them', () => {
    const { messages } = toMessages([
      { role: 'user', content: 'go' },
      callMsg('toolu_1'),
      { role: 'tool', tool_call_id: 'toolu_1', content: '' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
    ])
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '(no output)' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
    ])
  })

  it('sends a round of the current turn back verbatim, an earlier turn’s without its reasoning', () => {
    const { messages } = toMessages([
      { role: 'user', content: 'first task' },
      callMsg('toolu_old'),
      { role: 'tool', tool_call_id: 'toolu_old', content: '11 °C' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'second task' },
      callMsg('toolu_new'),
      { role: 'tool', tool_call_id: 'toolu_new', content: '12 °C' }
    ])
    // Earlier turn: the call survives, the thinking does not (dropping a leading run is allowed).
    expect(messages[1].content).toEqual([
      { type: 'tool_use', id: 'toolu_old', name: 'get_weather', input: { city: 'Paris' } }
    ])
    // Current turn: verbatim, signature and `caller` included.
    expect(messages[5].content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'SIG' },
      {
        type: 'tool_use',
        id: 'toolu_new',
        name: 'get_weather',
        input: { city: 'Paris' },
        caller: { type: 'direct' }
      }
    ])
  })

  it('keeps a breakpoint the agent put on an assistant turn, on a block that may carry one', () => {
    const m = callMsg('toolu_1')
    m.content = [{ type: 'text', text: '', cache_control: { type: 'ephemeral' } }]
    const { messages } = toMessages([{ role: 'user', content: 'go' }, m])
    const blocks = messages[1].content
    expect(blocks[0].cache_control).toBeUndefined()
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('rebuilds another provider’s round with ids the API accepts, the same on call and result', () => {
    const { messages } = toMessages([
      { role: 'user', content: 'go' },
      assistantToolTurn('Looking.', [{ id: 'call:1/x', name: 'list_models', arguments: '{}' }]),
      { role: 'tool', tool_call_id: 'call:1/x', content: 'ok' }
    ])
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'call_1_x', name: 'list_models', input: {} }
    ])
    expect(messages[2].content[0].tool_use_id).toBe('call_1_x')
  })

  it('keeps the user turn to bare results while a search of the turn before is still open', () => {
    // Claude called the search beside our tool: the API runs it once our result is in, and refuses
    // anything after the results (HTTP 400). The screenshot and the typed message go inside the result.
    const open = assistantToolTurn(null, [{ id: 'toolu_1', name: 'screenshot_canvas', arguments: '{}' }], {
      provider: 'anthropic',
      steps: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
        { type: 'tool_use', id: 'toolu_1', name: 'screenshot_canvas', input: {} }
      ]
    })
    const { messages } = toMessages([
      { role: 'user', content: 'go' },
      open,
      { role: 'tool', tool_call_id: 'toolu_1', content: 'Screenshot attached.' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'user', content: 'Use the European market.' }
    ])
    expect(messages[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: 'Screenshot attached.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'Use the European market.' }
        ]
      }
    ])
    // Without an open search the same turn stays as it was: results first, the rest after them.
    const closed = toMessages([
      { role: 'user', content: 'go' },
      callMsg('toolu_2'),
      { role: 'tool', tool_call_id: 'toolu_2', content: 'ok' },
      { role: 'user', content: 'Use the European market.' }
    ])
    expect(closed.messages[2].content.map((b) => b.type)).toEqual(['tool_result', 'text'])
  })

  it('drops a replayed call the loop no longer carries — a call without its result is a 400', () => {
    const m = callMsg('toolu_1')
    m.tool_calls = []
    const { messages } = toMessages([{ role: 'user', content: 'go' }, m])
    expect(messages[1].content.map((b) => b.type)).toEqual(['thinking'])
  })
})

describe('the stream', () => {
  it('hands the round on as calls plus its blocks, and counts the reasoning it is doing', async () => {
    fetchMock.mockResolvedValueOnce(sse(toolRound))
    const events = await collect()
    expect(events[0]).toEqual({ type: 'provider', name: 'Anthropic' })
    expect(events.filter((e) => e.type === 'reasoning').length).toBe(1)
    expect(events.find((e) => e.type === 'finish')).toEqual({ type: 'finish', reason: 'tool_calls' })
    const calls = events.find((e) => e.type === 'tool_calls')
    if (calls?.type !== 'tool_calls') throw new Error('no calls')
    expect(calls.calls).toEqual([{ id: 'toolu_01J2', name: 'get_weather', arguments: '{"city": "Paris"}' }])
    expect(calls.replay?.steps).toEqual([
      { type: 'thinking', thinking: 'I can compare the two packages.', signature: 'CAQS6RoKEAgTGAI4AU' },
      {
        type: 'tool_use',
        id: 'toolu_01J2',
        name: 'get_weather',
        input: { city: 'Paris' },
        caller: { type: 'direct' }
      }
    ])
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1)
  })

  it('streams text and books one usage', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        messageStart(),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'Short ' }),
        blockDelta(0, { type: 'text_delta', text: 'answer.' }),
        blockStop(0),
        messageDelta('end_turn', { ...usage0, output_tokens: 20 }),
        messageStop
      ])
    )
    const events = await collect()
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => (e as { text: string }).text)
        .join('')
    ).toBe('Short answer.')
    expect(events.find((e) => e.type === 'finish')).toEqual({ type: 'finish', reason: 'stop' })
    expect(events.some((e) => e.type === 'tool_calls')).toBe(false)
  })

  it('hands on every page the search returned, cited ones with the passage', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        messageStart(),
        blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
        blockDelta(0, { type: 'input_json_delta', partial_json: '{"query":"PET granulate GWP"}' }),
        blockStop(0),
        blockStart(1, {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [
            {
              type: 'web_search_result',
              url: 'https://a.org/eco',
              title: 'Eco profile',
              encrypted_content: 'E1'
            },
            { type: 'web_search_result', url: 'https://b.org/other', title: 'Other', encrypted_content: 'E2' }
          ]
        }),
        blockStop(1),
        blockStart(2, { type: 'text', text: '', citations: [] }),
        blockDelta(2, {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: 'https://a.org/eco',
            title: 'Eco profile',
            cited_text: '2.15 kg CO2e/kg'
          }
        }),
        blockDelta(2, { type: 'text_delta', text: 'About 2.2 kg.' }),
        blockStop(2),
        messageDelta('end_turn', { ...usage0, server_tool_use: { web_search_requests: 1 } }),
        messageStop
      ])
    )
    const events = await collect({ webSearch: true })
    const cites = events.find((e) => e.type === 'citations')
    expect(cites).toEqual({
      type: 'citations',
      citations: [
        { url: 'https://a.org/eco', title: 'Eco profile', excerpt: '2.15 kg CO2e/kg' },
        { url: 'https://b.org/other', title: 'Other' }
      ]
    })
    const usage = events.find((e) => e.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.server_tool_use).toEqual({ web_search_requests: 1 })
  })

  it('continues a paused server-tool turn by sending the paused content back', async () => {
    fetchMock
      .mockResolvedValueOnce(
        sse([
          messageStart(),
          blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
          blockDelta(0, { type: 'input_json_delta', partial_json: '{"query":"x"}' }),
          blockStop(0),
          messageDelta('pause_turn', usage0),
          messageStop
        ])
      )
      .mockResolvedValueOnce(
        sse([
          messageStart(),
          blockStart(0, { type: 'text', text: 'Found it.' }),
          blockStop(0),
          messageDelta('end_turn', usage0),
          messageStop
        ])
      )
    const events = await collect({ webSearch: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const last = sentBody(1).messages.at(-1)
    expect(last).toEqual({
      role: 'assistant',
      content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } }]
    })
    // The caller sees one reply: no pause, no empty call list, one usage per request.
    expect(events.filter((e) => e.type === 'finish')).toEqual([{ type: 'finish', reason: 'stop' }])
    expect(events.some((e) => e.type === 'tool_calls')).toBe(false)
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(2)
  })

  it('puts the paused passes in front of the round the caller stores', async () => {
    const pausedPass = sse([
      messageStart(),
      blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
      blockDelta(0, { type: 'input_json_delta', partial_json: '{"query":"x"}' }),
      blockStop(0),
      messageDelta('pause_turn', usage0),
      messageStop
    ])
    fetchMock
      .mockResolvedValueOnce(pausedPass)
      .mockResolvedValueOnce(
        sse([
          messageStart(),
          blockStart(0, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] }),
          blockStop(0),
          blockStart(1, { type: 'tool_use', id: 'toolu_9', name: 'list_models', input: {} }),
          blockDelta(1, { type: 'input_json_delta', partial_json: '{}' }),
          blockStop(1),
          messageDelta('tool_use', usage0),
          messageStop
        ])
      )
    const events = await collect({ webSearch: true })
    const round = events.find((e) => e.type === 'tool_calls')
    if (round?.type !== 'tool_calls') throw new Error('no round')
    expect(round.replay?.steps.map((b) => (b as { type: string }).type)).toEqual([
      'server_tool_use',
      'web_search_tool_result',
      'tool_use'
    ])
  })

  it('continues no paused reply once the spend ceiling has tripped', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        messageStart(),
        blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
        blockStop(0),
        messageDelta('pause_turn', usage0),
        messageStop
      ])
    )
    const budget = new AbortController()
    budget.abort()
    const events = await collect({ webSearch: true, budget: budget.signal })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e.type === 'finish')).toEqual([{ type: 'finish', reason: 'length' }])
  })

  it('books what an error mid-stream had used, then raises it', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([messageStart(), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
    )
    const seen: StreamEvent[] = []
    await expect(
      (async () => {
        for await (const ev of streamChat({
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'x' }],
          temperature: null
        }))
          seen.push(ev)
      })()
    ).rejects.toThrow(/overloaded/i)
    const usage = seen.find((e) => e.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.prompt_tokens).toBe(487)
  })

  it('calls a reply without message_stop cut off, and releases none of its calls', async () => {
    fetchMock.mockResolvedValueOnce(sse(toolRound.slice(0, -1)))
    const seen: StreamEvent[] = []
    await expect(
      (async () => {
        for await (const ev of streamChat({
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'x' }],
          temperature: null
        }))
          seen.push(ev)
      })()
    ).rejects.toThrow(/ended before the provider finished/)
    expect(seen.some((e) => e.type === 'tool_calls')).toBe(false)
  })

  it('maps the stop reasons the agent branches on', async () => {
    const reasonFor = async (stop: string): Promise<string | undefined> => {
      fetchMock.mockResolvedValueOnce(sse([messageStart(), messageDelta(stop, usage0), messageStop]))
      const ev = (await collect()).find((e) => e.type === 'finish')
      return ev?.type === 'finish' ? ev.reason : undefined
    }
    expect(await reasonFor('max_tokens')).toBe('length')
    expect(await reasonFor('model_context_window_exceeded')).toBe('length')
    expect(await reasonFor('refusal')).toBe('content_filter')
  })
})

describe('the cost', () => {
  const cost = (model: string, usage: Record<string, unknown>): number | undefined => {
    const ev = usageEvent(model, usage)
    return ev.type === 'usage' ? ev.usage.cost : undefined
  }

  it('prices uncached input, cache writes, cache reads and output apart', () => {
    // Sonnet 5.5: $2 in, $2.50 write (1.25×), $0.10 read, $10 out.
    const c = cost('claude-sonnet-5-5', {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000
    })
    expect(c).toBeCloseTo(2 + 2.5 + 0.1 + 10, 6)
    const ev = usageEvent('claude-sonnet-5-5', {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 5
    })
    expect(ev.type === 'usage' && ev.usage).toMatchObject({
      estimated: true,
      prompt_tokens: 60,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 30 }
    })
  })

  it('bills a one-hour cache write at twice the input price', () => {
    const c = cost('claude-opus-5-5', {
      input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
      cache_read_input_tokens: 0,
      output_tokens: 0
    })
    expect(c).toBeCloseTo(8, 6)
  })

  it('moves a whole Haiku request to the higher prices once its prompt passes 100,000 tokens', () => {
    const short = cost('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 1_000_000 })
    expect(short).toBeCloseTo(0.01 + 0.5, 6)
    // Cache reads count towards the length, and the read itself is billed at the higher read price.
    const long = cost('claude-haiku-5-5', {
      input_tokens: 1,
      cache_read_input_tokens: 100_000,
      output_tokens: 1_000_000
    })
    expect(long).toBeCloseTo(0.5 / 1e6 + 0.005 + 2.5, 6)
  })

  it('places a reply that searched by its first pass, not by the sum of its passes', () => {
    // 150,000 tokens summed over three passes of 50,000: each pass is a short prompt.
    const searched = { input_tokens: 150_000, output_tokens: 0, server_tool_use: { web_search_requests: 2 } }
    // Without the first pass known, the sum decides: too high rather than too low.
    expect(cost('claude-haiku-5-5', searched)).toBeCloseTo(0.075 + 0.02, 6)
    const ev = usageEvent('claude-haiku-5-5', searched, 50_000)
    expect(ev.type === 'usage' && ev.usage.cost).toBeCloseTo(0.015 + 0.02, 6)
    // A first pass that is long already: the higher prices, for all of it.
    const long = usageEvent('claude-haiku-5-5', searched, 120_000)
    expect(long.type === 'usage' && long.usage.cost).toBeCloseTo(0.075 + 0.02, 6)
  })

  it('adds a cent per web search', () => {
    expect(
      cost('claude-haiku-5-5', {
        input_tokens: 0,
        output_tokens: 0,
        server_tool_use: { web_search_requests: 3 }
      })
    ).toBeCloseTo(0.03, 6)
  })

  it('reports no cost for a usage without token counts, rather than a zero', () => {
    expect(cost('claude-sonnet-5-5', {})).toBeUndefined()
  })
})

describe('errors', () => {
  const err = (status: number, type: string, message: string) =>
    anthropicTransport.translateStatus(status, JSON.stringify({ type: 'error', error: { type, message } }))

  it('maps the statuses onto the shared codes', () => {
    expect(err(401, 'authentication_error', 'invalid x-api-key').code).toBe('auth')
    expect(err(429, 'rate_limit_error', 'slow down').code).toBe('rate_limit')
    expect(
      err(400, 'invalid_request_error', 'prompt is too long: 1200000 tokens > 1000000 maximum').code
    ).toBe('context')
    expect(err(413, 'request_too_large', 'too large').code).toBe('context')
    expect(err(529, 'overloaded_error', 'Overloaded').message).toMatch(/overloaded/i)
  })

  it('treats an empty balance as billing, never retried', () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API.'
      }
    })
    expect(anthropicTransport.translateStatus(400, body).code).toBe('credits')
    expect(anthropicTransport.retryable(400, body)).toBe(false)
    expect(anthropicTransport.retryable(529, '')).toBe(true)
    expect(anthropicTransport.retryable(429, '')).toBe(true)
  })

  it('retries an overloaded API before the first byte', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      fetchMock.mockResolvedValueOnce(
        fail(529, JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'x' } }))
      )
      fetchMock.mockResolvedValueOnce(sse(toolRound))
      const run = collect()
      await vi.advanceTimersByTimeAsync(5_000)
      const events = await run
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(events.some((e) => e.type === 'tool_calls')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('voice', () => {
  it('refuses rather than sending the recording to another provider', async () => {
    await expect(transcribeAudio({ data: 'AAAA', format: 'webm' })).rejects.toThrow(/no speech model/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
