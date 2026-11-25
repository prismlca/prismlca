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
const {
  anthropicTransport,
  API_VERSION,
  BETA_THINKING_BINDING,
  effortFor,
  FETCH_MAX_CONTENT_TOKENS,
  toMessages,
  usageEvent
} = await import('./anthropic')
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

  it('carries web search and page fetch as the basic server tools, each with the cap and the domain list', async () => {
    fetchMock.mockResolvedValueOnce(sse(toolRound))
    await collect({ webSearch: true, webLookupsCap: 3, webDomains: ['plasticseurope.org'] })
    expect(sentBody().tools).toEqual([
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
        allowed_domains: ['plasticseurope.org']
      },
      {
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        max_uses: 3,
        allowed_domains: ['plasticseurope.org'],
        max_content_tokens: FETCH_MAX_CONTENT_TOKENS
      }
    ])
    // No beta header for either: both tools are generally available.
    expect(fetchMock.mock.calls[0][1].headers['anthropic-beta']).toBe(BETA_THINKING_BINDING)
  })

  it('sends neither web tool without web search, and no limits it was not given', async () => {
    fetchMock.mockResolvedValueOnce(sse(toolRound)).mockResolvedValueOnce(sse(toolRound))
    await collect()
    expect(sentBody(0).tools).toBeUndefined()
    await collect({ webSearch: true })
    expect(sentBody(1).tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search' },
      { type: 'web_fetch_20250910', name: 'web_fetch', max_content_tokens: FETCH_MAX_CONTENT_TOKENS }
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

  it('sends every round Anthropic produced back verbatim, in its own turn and in every later one', () => {
    const verbatim = (id: string): Record<string, unknown>[] => [
      { type: 'thinking', thinking: 'plan', signature: 'SIG' },
      { type: 'tool_use', id, name: 'get_weather', input: { city: 'Paris' }, caller: { type: 'direct' } }
    ]
    const { messages } = toMessages([
      { role: 'user', content: 'first task' },
      callMsg('toolu_old'),
      { role: 'tool', tool_call_id: 'toolu_old', content: '11 °C' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'second task' },
      callMsg('toolu_new'),
      { role: 'tool', tool_call_id: 'toolu_new', content: '12 °C' }
    ])
    // Signature and `caller` included, whichever turn the round belongs to.
    expect(messages[1].content).toEqual(verbatim('toolu_old'))
    expect(messages[5].content).toEqual(verbatim('toolu_new'))
    // The answer that closed the earlier turn goes back as its text.
    expect(messages[3].content).toEqual([{ type: 'text', text: 'Done.' }])
  })

  it('names the searches of a closing answer ahead of its text, where its blocks are not sent', () => {
    // A turn's closing answer is stored as its text: the web search that ran in it would be gone, and
    // asked where a figure came from, the model found its own source notes with no search behind them.
    const web = {
      counts: { web_search_requests: 1 },
      searches: [
        {
          query: 'avasco Atlas 176x90x40 Gewicht',
          results: [{ url: 'https://www.galaxus.ch/p/64601145', title: 'Avasco Atlas 175' }]
        }
      ],
      cited: [{ url: 'https://www.galaxus.ch/p/64601145', title: 'Avasco Atlas 175', excerpt: '24000 g' }]
    }
    const { messages } = toMessages([
      { role: 'user', content: 'How heavy is the shelf?' },
      { role: 'assistant', content: 'About 24 kg.', web },
      { role: 'user', content: 'Where does the weight come from?' }
    ])
    const [note, text] = messages[1].content
    expect(text).toEqual({ type: 'text', text: 'About 24 kg.' })
    expect(note.type).toBe('text')
    expect(note.text).toContain(
      '"avasco Atlas 176x90x40 Gewicht" → Avasco Atlas 175 (https://www.galaxus.ch/p/64601145)'
    )
    expect(note.text).toMatch(
      /^\[Web search record kept by PrismLCA\. In this reply you searched the web once/
    )
  })

  it('adds no record to a round that goes back with its own search blocks, nor to one that searched nothing', () => {
    const replayed = { ...callMsg('toolu_1'), web: { searches: [{ query: 'x', results: [] }] } }
    const { messages } = toMessages([
      { role: 'user', content: 'go' },
      replayed,
      { role: 'tool', tool_call_id: 'toolu_1', content: '11 °C' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'and?' }
    ])
    // The replay holds the search itself; a line in front would change what its thinking was made on.
    expect(messages[1].content.map((b) => b.type)).toEqual(['thinking', 'tool_use'])
    expect(messages[3].content).toEqual([{ type: 'text', text: 'Done.' }])
  })

  it('starts a follow-up with exactly what the last round of the run sent — the cached prefix', () => {
    // A run with a search round and a tool round, then a question in the same chat. Rebuilding the
    // run's rounds as text and calls made the follow-up differ right after the task, so only the
    // system prompt and the tools came from the cache, and the thinking behind it failed its check.
    const searched = assistantToolTurn(
      'Looking it up.',
      [{ id: 'toolu_2', name: 'get_weather', arguments: '{"city":"Paris"}' }],
      {
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        steps: [
          { type: 'thinking', thinking: '', signature: 'SIG2' },
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Paris' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srvtoolu_1',
            content: [{ type: 'web_search_result', url: 'https://example.org', encrypted_content: 'ENC' }]
          },
          { type: 'thinking', thinking: 'found it', signature: 'SIG3' },
          { type: 'text', text: 'Looking it up.' },
          { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: { city: 'Paris' } }
        ]
      }
    )
    const run: ChatMessage[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'task' },
      callMsg('toolu_1'),
      { role: 'tool', tool_call_id: 'toolu_1', content: '11 °C' },
      searched,
      { role: 'tool', tool_call_id: 'toolu_2', content: '12 °C' }
    ]
    const lastRound = toMessages(run)
    const followUp = toMessages([
      ...run,
      { role: 'assistant', content: 'It is 12 °C.' },
      { role: 'user', content: 'Where does that come from?' }
    ])
    expect(followUp.system).toEqual(lastRound.system)
    expect(followUp.messages.slice(0, lastRound.messages.length)).toEqual(lastRound.messages)
    expect(followUp.messages.slice(lastRound.messages.length)).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'It is 12 °C.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Where does that come from?' }] }
    ])
    // The thinking of both rounds and the search went along, the empty thinking block included.
    expect(followUp.messages[3].content.map((b) => b.type)).toEqual([
      'thinking',
      'server_tool_use',
      'web_search_tool_result',
      'thinking',
      'text',
      'tool_use'
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

  describe('a search Claude ran beside one of our tools — its result opens the next reply', () => {
    const deferred = (): ChatMessage =>
      assistantToolTurn(null, [{ id: 'toolu_1', name: 'list_models', arguments: '{}' }], {
        provider: 'anthropic',
        steps: [
          { type: 'thinking', thinking: 'plan', signature: 'SIG' },
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
          { type: 'tool_use', id: 'toolu_1', name: 'list_models', input: {} }
        ]
      })
    const completing = (): ChatMessage =>
      assistantToolTurn(null, [{ id: 'toolu_2', name: 'list_models', arguments: '{}' }], {
        provider: 'anthropic',
        steps: [
          { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
          { type: 'thinking', thinking: 'more', signature: 'SIG2' },
          { type: 'tool_use', id: 'toolu_2', name: 'list_models', input: {} }
        ]
      })
    const types = (blocks: Record<string, unknown>[]): unknown[] => blocks.map((b) => b.type)

    it('keeps the pair when both rounds are there', () => {
      const { messages } = toMessages([
        { role: 'user', content: 'go' },
        deferred(),
        { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' },
        completing(),
        { role: 'tool', tool_call_id: 'toolu_2', content: 'ok' },
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: 'next' }
      ])
      expect(types(messages[1].content)).toEqual(['thinking', 'server_tool_use', 'tool_use'])
      expect(types(messages[3].content)).toEqual(['web_search_tool_result', 'thinking', 'tool_use'])
    })

    it('drops the call once a later reply follows that never stored its result', () => {
      // The result came with the closing answer, which is kept as its text alone.
      const run: ChatMessage[] = [
        { role: 'user', content: 'go' },
        deferred(),
        { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' }
      ]
      // Inside the run the call is the newest round's and still open: the API runs it on this request.
      expect(types(toMessages(run).messages[1].content)).toContain('server_tool_use')
      const { messages } = toMessages([
        ...run,
        { role: 'assistant', content: 'Done.' },
        { role: 'user', content: 'Use the European market.' }
      ])
      expect(types(messages[1].content)).toEqual(['thinking', 'tool_use'])
      // Nothing open any more, so the question is not folded into the tool's result.
      expect(types(messages[2].content)).toEqual(['tool_result'])
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    })

    it('drops the result when compaction took the replay of the round that called it', () => {
      const rebuilt = deferred()
      delete rebuilt.replay
      const { messages } = toMessages([
        { role: 'user', content: 'go' },
        rebuilt,
        { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' },
        completing(),
        { role: 'tool', tool_call_id: 'toolu_2', content: 'ok' }
      ])
      expect(types(messages[1].content)).toEqual(['tool_use'])
      expect(types(messages[3].content)).toEqual(['thinking', 'tool_use'])
    })
  })

  it('drops text blocks that hold nothing but whitespace — the API refuses them', () => {
    // Inside the turn: the replayed round keeps its reasoning and its call, the blank text goes, and a
    // tool that printed only whitespace answered all the same.
    const m = callMsg('toolu_1')
    m.replay!.steps.splice(0, 0, { type: 'text', text: '\n\n' })
    const { messages } = toMessages([
      { role: 'user', content: 'go' },
      m,
      { role: 'tool', tool_call_id: 'toolu_1', content: '  \n' }
    ])
    expect(messages[1].content.map((b) => b.type)).toEqual(['thinking', 'tool_use'])
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '(no output)' }
    ])
    // An earlier turn's round text that was only a line break disappears too, and so does an answer
    // that was nothing but whitespace.
    const earlier = toMessages([
      { role: 'user', content: 'go' },
      assistantToolTurn('\n', [{ id: 'toolu_9', name: 'list_models', arguments: '{}' }]),
      { role: 'tool', tool_call_id: 'toolu_9', content: 'ok' },
      { role: 'assistant', content: '\n' },
      { role: 'user', content: 'next' }
    ])
    expect(earlier.messages.map((x) => x.role)).toEqual(['user', 'assistant', 'user'])
    expect(earlier.messages[1].content.map((b) => b.type)).toEqual(['tool_use'])
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

  it('hands on every page the search returned, cited ones with the passage, the others marked uncited', async () => {
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
        { url: 'https://b.org/other', title: 'Other', uncited: true }
      ]
    })
    // And the search itself: what it looked for, and the pages that came back, in their order.
    expect(events.find((e) => e.type === 'web_searches')).toEqual({
      type: 'web_searches',
      searches: [
        {
          query: 'PET granulate GWP',
          results: [
            { url: 'https://a.org/eco', title: 'Eco profile' },
            { url: 'https://b.org/other', title: 'Other' }
          ]
        }
      ]
    })
    const usage = events.find((e) => e.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.server_tool_use).toEqual({ web_search_requests: 1 })
    // A closing reply that only searched goes back as its text and its record: no blocks are handed out.
    expect(events.some((e) => e.type === 'tool_calls')).toBe(false)
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
    // The result came on the continuation, its search text with the paused pass: named together, once.
    expect(events.filter((e) => e.type === 'web_searches')).toEqual([
      { type: 'web_searches', searches: [{ query: 'x', results: [] }] }
    ])
  })

  it('names a search whose call came in the reply before, and one that failed', async () => {
    // Claude searched beside one of our tools: the call is in the round the request replays, the result
    // opens this reply. A second search ran out of uses.
    const earlier = assistantToolTurn(null, [{ id: 'toolu_1', name: 'list_models', arguments: '{}' }], {
      provider: 'anthropic',
      steps: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_7',
          name: 'web_search',
          input: { query: 'avasco Atlas weight' }
        },
        { type: 'tool_use', id: 'toolu_1', name: 'list_models', input: {} }
      ]
    })
    fetchMock.mockResolvedValueOnce(
      sse([
        messageStart(),
        blockStart(0, {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_7',
          content: [{ type: 'web_search_result', url: 'https://g.ch/64601145', title: 'Atlas 175' }]
        }),
        blockStop(0),
        blockStart(1, { type: 'server_tool_use', id: 'srvtoolu_8', name: 'web_search', input: {} }),
        blockDelta(1, { type: 'input_json_delta', partial_json: '{"query":"avasco Diksmuide"}' }),
        blockStop(1),
        blockStart(2, {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_8',
          content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }
        }),
        blockStop(2),
        blockStart(3, { type: 'text', text: '24 kg.' }),
        blockStop(3),
        messageDelta('end_turn', usage0),
        messageStop
      ])
    )
    const events = await collect({
      webSearch: true,
      messages: [
        { role: 'user', content: 'How heavy?' },
        earlier,
        { role: 'tool', tool_call_id: 'toolu_1', content: '[]' }
      ]
    })
    expect(events.find((e) => e.type === 'web_searches')).toEqual({
      type: 'web_searches',
      searches: [
        { query: 'avasco Atlas weight', results: [{ url: 'https://g.ch/64601145', title: 'Atlas 175' }] },
        { query: 'avasco Diksmuide', results: [], error: 'max_uses_exceeded' }
      ]
    })
  })

  it('names the pages a reply opened, hands them on as delivered pages, and counts the fetches', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        messageStart(),
        blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_f1', name: 'web_fetch', input: {} }),
        blockDelta(0, { type: 'input_json_delta', partial_json: '{"url":"https://m.de/sds.pdf"}' }),
        blockStop(0),
        blockStart(1, {
          type: 'web_fetch_tool_result',
          tool_use_id: 'srvtoolu_f1',
          content: {
            type: 'web_fetch_result',
            url: 'https://m.de/sds.pdf',
            content: {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' },
              title: 'Safety data sheet'
            },
            retrieved_at: '2026-11-21T18:00:00Z'
          }
        }),
        blockStop(1),
        blockStart(2, { type: 'server_tool_use', id: 'srvtoolu_f2', name: 'web_fetch', input: {} }),
        blockDelta(2, { type: 'input_json_delta', partial_json: '{"url":"https://m.de/gone"}' }),
        blockStop(2),
        blockStart(3, {
          type: 'web_fetch_tool_result',
          tool_use_id: 'srvtoolu_f2',
          content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' }
        }),
        blockStop(3),
        blockStart(4, { type: 'text', text: 'The sheet gives 0.9 kg.' }),
        blockStop(4),
        messageDelta('end_turn', { ...usage0, server_tool_use: { web_fetch_requests: 2 } }),
        messageStop
      ])
    )
    const events = await collect({ webSearch: true })
    expect(events.find((e) => e.type === 'web_fetches')).toEqual({
      type: 'web_fetches',
      fetches: [
        { url: 'https://m.de/sds.pdf', title: 'Safety data sheet' },
        { url: 'https://m.de/gone', error: 'url_not_accessible' }
      ]
    })
    // Opened is delivered: a research leg may name the page as its source. A failed fetch delivered nothing.
    expect(events.find((e) => e.type === 'citations')).toEqual({
      type: 'citations',
      citations: [{ url: 'https://m.de/sds.pdf', title: 'Safety data sheet', uncited: true }]
    })
    expect(events.some((e) => e.type === 'web_searches')).toBe(false)
    const usage = events.find((e) => e.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.server_tool_use).toEqual({ web_fetch_requests: 2 })
    // A closing reply that opened a page hands its blocks out, without calls, to go back as they came.
    const round = events.find((e) => e.type === 'tool_calls')
    expect(round?.type === 'tool_calls' && round.calls).toEqual([])
    expect(
      round?.type === 'tool_calls' && round.replay?.steps.map((b) => (b as { type: string }).type)
    ).toEqual([
      'server_tool_use',
      'web_fetch_tool_result',
      'server_tool_use',
      'web_fetch_tool_result',
      'text'
    ])
  })

  it('sends a closing reply that opened a page back as it came, the page with it and no record', () => {
    const steps = [
      {
        type: 'server_tool_use',
        id: 'srvtoolu_f1',
        name: 'web_fetch',
        input: { url: 'https://m.de/sds.pdf' }
      },
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'srvtoolu_f1',
        content: { type: 'web_fetch_result', url: 'https://m.de/sds.pdf', content: { type: 'document' } }
      },
      { type: 'text', text: 'The sheet gives 0.9 kg.' }
    ]
    const { messages } = toMessages([
      { role: 'user', content: 'https://m.de/sds.pdf — how heavy?' },
      {
        role: 'assistant',
        content: 'The sheet gives 0.9 kg.',
        web: { counts: { web_fetch_requests: 1 }, fetched: [{ url: 'https://m.de/sds.pdf' }] },
        replay: { provider: 'anthropic', model: 'claude-haiku-5-5', steps }
      },
      { role: 'user', content: 'And the binder share?' }
    ])
    expect(messages[1].content).toEqual(steps)
    // The same reply rebuilt (its blocks dropped by compaction in a later turn) names the page instead.
    const { messages: rebuilt } = toMessages([
      { role: 'user', content: 'https://m.de/sds.pdf — how heavy?' },
      {
        role: 'assistant',
        content: 'The sheet gives 0.9 kg.',
        web: { counts: { web_fetch_requests: 1 }, fetched: [{ url: 'https://m.de/sds.pdf' }] }
      },
      { role: 'user', content: 'And the binder share?' }
    ])
    expect(JSON.stringify(rebuilt[1].content)).toContain('In this reply you opened a page')
    // The turn's record before the answer — a question answered on the way — goes after its blocks, as
    // the agent kept it: never cut out of the text, where a short answer ("No") could match a user's reply.
    const { messages: withRecord } = toMessages([
      { role: 'user', content: 'https://m.de/sds.pdf — how heavy?' },
      {
        role: 'assistant',
        content: '**Which unit?** — You answered: per kg\n\nThe sheet gives 0.9 kg.',
        replay: { provider: 'anthropic', model: 'claude-haiku-5-5', steps },
        record: '**Which unit?** — You answered: per kg'
      },
      { role: 'user', content: 'And the binder share?' }
    ])
    expect(withRecord[1].content).toEqual([
      ...steps,
      { type: 'text', text: '**Which unit?** — You answered: per kg' }
    ])
  })

  it('hands out the closing pass of a paused reply that opened a page, to go back with it', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        messageStart(),
        blockStart(0, { type: 'text', text: 'The sheet gives 0.9 kg.' }),
        blockStop(0),
        messageDelta('end_turn', usage0),
        messageStop
      ])
    )
    const paused: ChatMessage = {
      role: 'assistant',
      content: null,
      replay: {
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        steps: [
          { type: 'server_tool_use', id: 'srvtoolu_p', name: 'web_fetch', input: { url: 'https://m.de/a' } },
          { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_p', content: { type: 'web_fetch_result' } }
        ]
      }
    }
    const events = await collect({
      webSearch: true,
      messages: [{ role: 'user', content: 'https://m.de/a' }, paused]
    })
    const round = events.find((e) => e.type === 'tool_calls')
    expect(round?.type === 'tool_calls' && round.calls).toEqual([])
    expect(round?.type === 'tool_calls' && round.replay?.steps).toEqual([
      { type: 'text', text: 'The sheet gives 0.9 kg.' }
    ])
  })

  it('names a failed fetch whose call came in the reply before by the address it asked for', async () => {
    const earlier = assistantToolTurn(null, [{ id: 'toolu_1', name: 'list_models', arguments: '{}' }], {
      provider: 'anthropic',
      steps: [
        { type: 'server_tool_use', id: 'srvtoolu_f7', name: 'web_fetch', input: { url: 'https://x.org/a' } },
        { type: 'tool_use', id: 'toolu_1', name: 'list_models', input: {} }
      ]
    })
    fetchMock.mockResolvedValueOnce(
      sse([
        messageStart(),
        blockStart(0, {
          type: 'web_fetch_tool_result',
          tool_use_id: 'srvtoolu_f7',
          content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_in_prior_context' }
        }),
        blockStop(0),
        blockStart(1, { type: 'text', text: 'Could not open it.' }),
        blockStop(1),
        messageDelta('end_turn', usage0),
        messageStop
      ])
    )
    const events = await collect({
      webSearch: true,
      messages: [
        { role: 'user', content: 'Open it' },
        earlier,
        { role: 'tool', tool_call_id: 'toolu_1', content: '[]' }
      ]
    })
    expect(events.find((e) => e.type === 'web_fetches')).toEqual({
      type: 'web_fetches',
      fetches: [{ url: 'https://x.org/a', error: 'url_not_in_prior_context' }]
    })
    // The fetch's address is not a search text: no search is named.
    expect(events.some((e) => e.type === 'web_searches')).toBe(false)
  })

  it('names no search in a reply that ran none', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        messageStart(),
        blockStart(0, { type: 'text', text: 'Estimated at 14 kg.' }),
        blockStop(0),
        messageDelta('end_turn', usage0),
        messageStop
      ])
    )
    const events = await collect({ webSearch: true })
    expect(events.some((e) => e.type === 'web_searches' || e.type === 'citations')).toBe(false)
  })

  it('continues no paused reply once the spend ceiling has tripped', async () => {
    const budget = new AbortController()
    // The ceiling trips while the first request runs — no request at all would start past it.
    fetchMock.mockImplementationOnce(async () => {
      budget.abort()
      return sse([
        messageStart(),
        blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
        blockStop(0),
        messageDelta('pause_turn', usage0),
        messageStop
      ])
    })
    const events = await collect({ webSearch: true, budget: budget.signal })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e.type === 'finish')).toEqual([{ type: 'finish', reason: 'length' }])
  })

  it('books what an error mid-stream had used, then raises one that would fail again', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([messageStart(), { type: 'error', error: { type: 'invalid_request_error', message: 'Bad block' } }])
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
    ).rejects.toThrow(/Bad block/)
    const usage = seen.find((e) => e.type === 'usage')
    expect(usage?.type === 'usage' && usage.usage.prompt_tokens).toBe(487)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends again when the stream opens with an overload, before any of the reply', async () => {
    // Anthropic's documented overload after a 200: the request was accepted and not served.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      fetchMock
        .mockResolvedValueOnce(
          sse([messageStart(), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
        )
        .mockResolvedValueOnce(sse(toolRound))
      const run = collect()
      await vi.advanceTimersByTimeAsync(5_000)
      const events = await run
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(events.some((e) => e.type === 'tool_calls')).toBe(true)
      expect(events.filter((e) => e.type === 'usage')).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends no second request once the spend ceiling tripped on the failed one', async () => {
    fetchMock.mockImplementation(async () =>
      sse([messageStart(), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])
    )
    const budget = new AbortController()
    const seen: StreamEvent[] = []
    await expect(
      (async () => {
        for await (const ev of streamChat({
          model: 'claude-sonnet-5-5',
          messages: [{ role: 'user', content: 'x' }],
          temperature: null,
          budget: budget.signal
        })) {
          seen.push(ev)
          // The caller's ceiling trips on the failed attempt's own usage, as the agent's does.
          if (ev.type === 'usage') budget.abort()
        }
      })()
    ).rejects.toThrow(/overloaded/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed attempt’s stop reason away from the retry that succeeded', async () => {
    // A paused reply whose connection closed before message_stop, then a complete answer.
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      fetchMock
        .mockResolvedValueOnce(
          sse([
            messageStart(),
            blockStart(0, { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} }),
            blockStop(0),
            messageDelta('pause_turn', usage0)
          ])
        )
        .mockResolvedValueOnce(
          sse([
            messageStart(),
            blockStart(0, { type: 'text', text: 'Done.' }),
            blockStop(0),
            messageDelta('end_turn', usage0),
            messageStop
          ])
        )
      const run = collect({ webSearch: true })
      await vi.advanceTimersByTimeAsync(5_000)
      const events = await run
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(events.filter((e) => e.type === 'finish')).toEqual([{ type: 'finish', reason: 'stop' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('calls a reply without message_stop cut off, and releases none of its calls', async () => {
    // Text reached the caller before the cut, so the request is not sent again: the error stands.
    fetchMock.mockResolvedValueOnce(
      sse([
        messageStart(),
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'Checking.' }),
        blockStop(0),
        ...toolRound.slice(5, -1)
      ])
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
    ).rejects.toThrow(/ended before the provider finished/)
    expect(seen.some((e) => e.type === 'tool_calls')).toBe(false)
  })

  it('hands on the reason a refusal gives', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([
        messageStart(),
        {
          type: 'message_delta',
          delta: {
            stop_reason: 'refusal',
            stop_details: {
              type: 'refusal',
              category: 'bio',
              explanation: 'Synthesis routes for this agent.'
            }
          },
          usage: usage0
        },
        messageStop
      ])
    )
    const finish = (await collect()).find((e) => e.type === 'finish')
    expect(finish).toEqual({
      type: 'finish',
      reason: 'content_filter',
      detail: 'category: bio — Synthesis routes for this agent.'
    })
  })

  it('hands out no call from a reply that was refused after streaming it', async () => {
    fetchMock.mockResolvedValueOnce(
      sse([...toolRound.slice(0, -2), messageDelta('refusal', usage0), messageStop])
    )
    const events = await collect()
    expect(events.some((e) => e.type === 'tool_calls')).toBe(false)
    expect(events.find((e) => e.type === 'finish')).toMatchObject({ reason: 'content_filter' })
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

  it('places a reply that opened a page by its first pass too, and charges no fee for the fetch', () => {
    const fetched = { input_tokens: 150_000, output_tokens: 0, server_tool_use: { web_fetch_requests: 1 } }
    const ev = usageEvent('claude-haiku-5-5', fetched, 50_000)
    expect(ev.type === 'usage' && ev.usage.cost).toBeCloseTo(0.015, 6)
    expect(ev.type === 'usage' && ev.usage.server_tool_use).toEqual({ web_fetch_requests: 1 })
  })

  it('reports the size the conversation was sent at apart from the summed passes it is billed for', () => {
    const searched = { input_tokens: 150_000, output_tokens: 0, server_tool_use: { web_search_requests: 2 } }
    const ev = usageEvent('claude-sonnet-5-5', searched, 50_000)
    expect(ev.type === 'usage' && ev.usage).toMatchObject({ prompt_tokens: 150_000, context_tokens: 50_000 })
    // One pass: the two are the same figure, and only the one is reported.
    const plain = usageEvent('claude-sonnet-5-5', { input_tokens: 50_000, output_tokens: 10 }, 50_000)
    expect(plain.type === 'usage' && plain.usage.prompt_tokens).toBe(50_000)
    expect(plain.type === 'usage' && 'context_tokens' in plain.usage).toBe(false)
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

  it('says where an organization switched a web tool off, without retrying', () => {
    const off = err(400, 'invalid_request_error', 'Web fetch is not enabled for this organization.')
    expect(off.message).toMatch(/^Web fetch is turned off for your Anthropic organization/)
    expect(off.message).toContain('Settings → Capabilities')
    expect(err(400, 'invalid_request_error', 'web_search is not enabled').message).toMatch(/^Web search/)
    expect(anthropicTransport.retryable(400, 'Web fetch is not enabled')).toBe(false)
    // Another 400 keeps Anthropic's own words.
    expect(err(400, 'invalid_request_error', 'tools.1: unknown field').message).toContain('unknown field')
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
