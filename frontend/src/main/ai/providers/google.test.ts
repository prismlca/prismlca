/**
 * The direct-Google transport, checked where its differences bite: the Interactions request (stateless,
 * pinned revision, nothing OpenAI- or OpenRouter-shaped), the thought steps that must travel back with
 * every tool round, the locally synthesized cost (thinking billed as output, search billed per query),
 * the citation links that are redirects, and the three error shapes. The event fixtures are trimmed
 * copies of streams the live API sent on 2026-11-07.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-google-test', getAppPath: () => '/tmp/prism-google-test' }
}))

process.env.GEMINI_API_KEY = 'test-google-key'

const { streamChat, transcribeAudio } = await import('../client')
const { setActiveProvider } = await import('./state')
const { googleTransport, SKIP_SIGNATURE, thinkingLevel, toInteractionsInput } = await import('./google')
const { DEFAULT_GOOGLE_MODEL_ID } = await import('../../../shared/aiDefaults')
import type { ChatMessage, StreamEvent } from './types'

const API = 'https://generativelanguage.googleapis.com/v1beta/interactions'

/** One SSE response made of Interactions events, in the API's own framing (`event:` + `data:`). */
function sse(events: Array<Record<string, unknown>>): Response {
  const chunk =
    events.map((e) => `event: ${String(e.event_type)}\ndata: ${JSON.stringify(e)}\n\n`).join('') +
    'event: done\ndata: [DONE]\n\n'
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

const created = {
  event_type: 'interaction.created',
  interaction: { object: 'interaction', model: 'gemini-3.8-flash' }
}
const start = (index: number, step: Record<string, unknown>) => ({ event_type: 'step.start', index, step })
const delta = (index: number, d: Record<string, unknown>) => ({ event_type: 'step.delta', index, delta: d })
const stop = (index: number) => ({ event_type: 'step.stop', index })
const completed = (status: string, usage?: Record<string, unknown>) => ({
  event_type: 'interaction.completed',
  interaction: { status, usage }
})

/** The measured parallel-call round: a signed thought, then two calls whose arguments stream. */
const TWO_CALLS = [
  created,
  { event_type: 'interaction.status_update', status: 'in_progress' },
  start(0, { type: 'thought' }),
  delta(0, { type: 'thought_signature', signature: 'Eo0CCooC-signed' }),
  stop(0),
  start(1, { id: 'call_1', type: 'function_call', name: 'get_weather', arguments: {} }),
  delta(1, { type: 'arguments_delta', arguments: '{"city":' }),
  delta(1, { type: 'arguments_delta', arguments: '"Paris"}' }),
  stop(1),
  start(2, { id: 'call_2', type: 'function_call', name: 'get_weather', arguments: {} }),
  delta(2, { type: 'arguments_delta', arguments: '{"city":"Rome"}' }),
  stop(2),
  completed('requires_action', {
    total_input_tokens: 73,
    total_cached_tokens: 0,
    total_output_tokens: 32,
    total_thought_tokens: 29,
    total_tool_use_tokens: 0
  })
]

async function run(opts: Partial<Parameters<typeof streamChat>[0]> = {}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const ev of streamChat({ model: 'gemini-3.8-flash', messages: [], temperature: null, ...opts }))
    events.push(ev)
  return events
}

function capture(response: () => Response): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return response()
    })
  )
  return { calls }
}

beforeEach(() => setActiveProvider('google'))
afterEach(() => {
  setActiveProvider('openrouter')
  vi.unstubAllGlobals()
})

describe('the request', () => {
  it('speaks the Interactions API: stateless, pinned revision, no sampling parameters', async () => {
    const { calls } = capture(() => sse([created, completed('completed', { total_input_tokens: 5 })]))
    await run({
      messages: [
        { role: 'system', content: 'You model life cycles.' },
        { role: 'user', content: 'Hello' }
      ],
      temperature: 0.7,
      reasoningEffort: 'high',
      maxTokens: 250_000,
      tools: [
        {
          type: 'function',
          function: { name: 'get_x', description: 'Get x', parameters: { type: 'object', properties: {} } }
        }
      ]
    })
    expect(calls[0].url).toBe(API)
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('test-google-key')
    expect(headers['Api-Revision']).toBe('2026-05-20')
    expect(headers.Authorization).toBeUndefined()
    const body = JSON.parse(String(calls[0].init.body))
    // Without `store: false` Google keeps every interaction (55 days on a paid key).
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.system_instruction).toBe('You model life cycles.')
    expect(body.input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'Hello' }] }])
    expect(body.generation_config).toEqual({
      max_output_tokens: 65_536,
      thinking_summaries: 'auto',
      thinking_level: 'high'
    })
    expect(body.temperature).toBeUndefined()
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'get_x',
        description: 'Get x',
        parameters: { type: 'object', properties: {} }
      }
    ])
  })

  it('sends a model of another provider nowhere — the id degrades to the Google default', async () => {
    const { calls } = capture(() => sse([created, completed('completed')]))
    await run({ model: 'google/gemini-3.8-flash' })
    expect(JSON.parse(String(calls[0].init.body)).model).toBe(DEFAULT_GOOGLE_MODEL_ID)
  })

  it('attaches Google Search to a search-only request and turns the allow list into words', async () => {
    const { calls } = capture(() => sse([created, completed('completed')]))
    await run({
      messages: [{ role: 'user', content: 'PET density?' }],
      webSearch: true,
      webDomains: ['plasticseurope.org', 'iso.org']
    })
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.tools).toEqual([{ type: 'google_search' }])
    expect(body.system_instruction).toContain('plasticseurope.org, iso.org')
  })

  it('never combines Google Search with function tools (a preview on this API)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { calls } = capture(() => sse([created, completed('completed')]))
    await run({
      webSearch: true,
      tools: [{ type: 'function', function: { name: 'f', description: 'f', parameters: { type: 'object' } } }]
    })
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.tools.map((t: { type: string }) => t.type)).toEqual(['function'])
  })

  it('maps every effort onto the three thinking levels the Google rows accept', () => {
    expect(thinkingLevel(undefined)).toBeUndefined()
    expect(thinkingLevel('none')).toBe('low')
    expect(thinkingLevel('minimal')).toBe('low')
    expect(thinkingLevel('medium')).toBe('medium')
    expect(thinkingLevel('xhigh')).toBe('high')
  })
})

describe('the transcript as Interactions steps', () => {
  const calls = [
    {
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
    },
    {
      id: 'call_2',
      type: 'function' as const,
      function: { name: 'get_weather', arguments: '{"city":"Rome"}' }
    }
  ]
  const results: ChatMessage[] = [
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
    { role: 'tool', tool_call_id: 'call_2', content: '' }
  ]

  it('resends Google’s own steps verbatim — the signed thought included', () => {
    const replay = {
      provider: 'google' as const,
      steps: [
        { type: 'thought', signature: 'Eo0C-signed' },
        { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: { city: 'Paris' } },
        { type: 'function_call', id: 'call_2', name: 'get_weather', arguments: { city: 'Rome' } }
      ]
    }
    const { input } = toInteractionsInput([
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: null, tool_calls: calls, replay },
      ...results
    ])
    expect(input.slice(1, 4)).toEqual(replay.steps)
    // Results follow all calls, named, and an empty output still answers.
    expect(input.slice(4)).toEqual([
      {
        type: 'function_result',
        call_id: 'call_1',
        name: 'get_weather',
        result: [{ type: 'text', text: 'sunny' }]
      },
      {
        type: 'function_result',
        call_id: 'call_2',
        name: 'get_weather',
        result: [{ type: 'text', text: '(no output)' }]
      }
    ])
  })

  it('gives a tool round from another provider the skip signature, so it still validates', () => {
    const { input } = toInteractionsInput([
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: 'Checking.', tool_calls: calls },
      ...results
    ])
    expect(input[1]).toEqual({ type: 'thought', signature: SKIP_SIGNATURE })
    expect(input[2]).toEqual({ type: 'model_output', content: [{ type: 'text', text: 'Checking.' }] })
    expect(input[3]).toEqual({
      type: 'function_call',
      id: 'call_1',
      name: 'get_weather',
      arguments: { city: 'Paris' }
    })
  })

  it('drops a replayed call the loop no longer carries, and adds one the replay lacks', () => {
    const { input } = toInteractionsInput([
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [calls[1]],
        replay: {
          provider: 'google',
          steps: [
            { type: 'thought', signature: 's' },
            { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: {} }
          ]
        }
      }
    ])
    expect(input.slice(1)).toEqual([
      { type: 'thought', signature: 's' },
      { type: 'function_call', id: 'call_2', name: 'get_weather', arguments: { city: 'Rome' } }
    ])
  })

  it('ignores a replay that belongs to another provider', () => {
    const { input } = toInteractionsInput([
      {
        role: 'assistant',
        content: null,
        tool_calls: [calls[0]],
        replay: { provider: 'openai', steps: [{ x: 1 }] }
      }
    ])
    expect(input[0]).toEqual({ type: 'thought', signature: SKIP_SIGNATURE })
  })

  it('carries screenshots and attached PDFs as base64 blocks with their type', () => {
    const { input } = toInteractionsInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'file', file: { filename: 'epd.pdf', file_data: 'data:application/pdf;base64,BBBB' } }
        ]
      }
    ])
    expect(input[0]).toEqual({
      type: 'user_input',
      content: [
        { type: 'text', text: 'Look' },
        { type: 'image', data: 'AAAA', mime_type: 'image/png' },
        { type: 'document', data: 'BBBB', mime_type: 'application/pdf' }
      ]
    })
  })
})

describe('the event stream', () => {
  it('assembles parallel calls and hands their steps on for the next round', async () => {
    capture(() => sse(TWO_CALLS))
    const events = await run()
    expect(events.find((e) => e.type === 'provider')).toEqual({ type: 'provider', name: 'Google' })
    expect(events.find((e) => e.type === 'finish')).toEqual({ type: 'finish', reason: 'tool_calls' })
    const tc = events.find((e) => e.type === 'tool_calls')
    expect(tc).toEqual({
      type: 'tool_calls',
      calls: [
        { id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { id: 'call_2', name: 'get_weather', arguments: '{"city":"Rome"}' }
      ],
      replay: {
        provider: 'google',
        steps: [
          { type: 'thought', signature: 'Eo0CCooC-signed' },
          { id: 'call_1', type: 'function_call', name: 'get_weather', arguments: { city: 'Paris' } },
          { id: 'call_2', type: 'function_call', name: 'get_weather', arguments: { city: 'Rome' } }
        ]
      }
    })
  })

  it('streams the answer text, and counts thought summaries without showing them', async () => {
    capture(() =>
      sse([
        created,
        start(0, { type: 'thought' }),
        delta(0, { type: 'thought_summary', content: { type: 'text', text: 'Weighing the options' } }),
        stop(0),
        start(1, { type: 'model_output' }),
        delta(1, { type: 'text', text: 'Paris: ' }),
        delta(1, { type: 'text', text: 'sunny.' }),
        stop(1),
        completed('completed', { total_input_tokens: 10, total_output_tokens: 4 })
      ])
    )
    const events = await run()
    const text = events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')
    expect(text).toBe('Paris: sunny.')
    expect(events).toContainEqual({ type: 'reasoning', chars: 'Weighing the options'.length })
    expect(events.find((e) => e.type === 'finish')).toEqual({ type: 'finish', reason: 'stop' })
    expect(events.some((e) => e.type === 'tool_calls')).toBe(false)
  })

  it('prices thinking as output, search-tool tokens as input, and every search query', async () => {
    capture(() =>
      sse([
        created,
        start(0, { id: 's1', type: 'google_search_call', signature: '' }),
        delta(0, { type: 'google_search_call', signature: 'sig', arguments: { queries: ['a', 'b'] } }),
        stop(0),
        completed('completed', {
          total_input_tokens: 1_000_000,
          total_cached_tokens: 400_000,
          total_tool_use_tokens: 100_000,
          total_output_tokens: 100_000,
          total_thought_tokens: 100_000
        })
      ])
    )
    const usage = (await run()).find((e) => e.type === 'usage')
    // Flash list price: $0.75 in, $0.075 cached, $3.75 out (Jan 2027: double — the test pins nothing
    // about the date, so it reads the price that applies today through the same helper the transport uses).
    const { priceOn } = await import('../directModels')
    const { getModels } = await import('../models')
    const p = priceOn(getModels().find((m) => m.id === 'gemini-3.8-flash' && m.provider === 'google')!)!
    const expected = (700_000 * p.input + 400_000 * p.cachedInput + 200_000 * p.output) / 1e6 + 2 * 0.014
    expect(usage).toEqual({
      type: 'usage',
      usage: {
        cost: expect.closeTo(expected, 10),
        estimated: true,
        prompt_tokens: 1_100_000,
        completion_tokens: 200_000,
        prompt_tokens_details: { cached_tokens: 400_000 },
        server_tool_use: { web_search_requests: 2 }
      }
    })
  })

  it('resolves Google’s citation redirects to the real pages before passing them on', async () => {
    const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ'
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === redirect) {
        expect(init?.redirect).toBe('manual')
        return {
          status: 302,
          headers: new Headers({ location: 'https://example.org/pet.pdf' }),
          body: null
        } as unknown as Response
      }
      return sse([
        created,
        start(0, { type: 'model_output' }),
        delta(0, { type: 'text', text: 'PET: 1.38 g/cm³.' }),
        delta(0, {
          type: 'text_annotation_delta',
          annotations: [
            { type: 'url_citation', url: redirect, title: 'example.org', start_index: 0, end_index: 10 },
            { type: 'url_citation', url: redirect, title: 'example.org', start_index: 11, end_index: 16 }
          ]
        }),
        stop(0),
        completed('completed')
      ])
    })
    vi.stubGlobal('fetch', fetchMock)
    const events = await run({ webSearch: true })
    expect(events.find((e) => e.type === 'citations')).toEqual({
      type: 'citations',
      // The link stays on the page as `via`: the model quotes it as its source.
      citations: [{ url: 'https://example.org/pet.pdf', title: 'example.org', via: [redirect] }]
    })
  })

  it('keeps the words a step opens with — an answer that starts in step.start, or lives there whole', async () => {
    capture(() =>
      sse([
        created,
        start(0, { type: 'thought', summary: [{ type: 'text', text: 'Evaluating the clues' }] }),
        stop(0),
        start(1, { type: 'model_output', content: [{ type: 'text', text: 'The impact is ' }] }),
        delta(1, { type: 'text', text: '12 kg CO2e.' }),
        stop(1),
        start(2, { type: 'model_output', content: [{ type: 'text', text: ' Done.' }] }),
        stop(2),
        completed('completed')
      ])
    )
    const events = await run()
    expect(events.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')).toBe(
      'The impact is 12 kg CO2e. Done.'
    )
    expect(events).toContainEqual({ type: 'reasoning', chars: 'Evaluating the clues'.length })
  })

  it('releases no call from a reply that ended before Google completed it', async () => {
    // A clean end of stream after one finished call and one unfinished: running the first would be half
    // a round's mutations, so the reply is an error instead.
    capture(() =>
      sse([
        created,
        start(0, { type: 'thought' }),
        delta(0, { type: 'thought_signature', signature: 's' }),
        stop(0),
        start(1, { id: 'call_1', type: 'function_call', name: 'delete_process', arguments: {} }),
        delta(1, { type: 'arguments_delta', arguments: '{"code":"p1"}' }),
        stop(1),
        start(2, { id: 'call_2', type: 'function_call', name: 'delete_process', arguments: {} })
      ])
    )
    const seen: StreamEvent[] = []
    await expect(
      (async () => {
        for await (const ev of streamChat({ model: 'gemini-3.8-flash', messages: [], temperature: null }))
          seen.push(ev)
      })()
    ).rejects.toMatchObject({ code: 'network' })
    expect(seen.some((e) => e.type === 'tool_calls')).toBe(false)
  })

  it('stays quiet when the user stopped the reply', async () => {
    capture(() =>
      sse([created, start(0, { type: 'model_output' }), delta(0, { type: 'text', text: 'Half' })])
    )
    const stopNow = new AbortController()
    stopNow.abort()
    const events = await run({ signal: stopNow.signal })
    expect(events.some((e) => e.type === 'tool_calls')).toBe(false)
  })

  it('resolves a Google link the model wrote without an annotation, and drops one that leads nowhere', async () => {
    const good = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/GOOD_1'
    const dead = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/DEAD_2'
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === good)
          return {
            status: 302,
            headers: new Headers({ location: 'https://pubs.acs.org/x' }),
            body: null
          } as unknown as Response
        if (url === dead) return { status: 404, headers: new Headers(), body: null } as unknown as Response
        return sse([
          created,
          start(0, { type: 'model_output' }),
          delta(0, { type: 'text', text: `[{"source_url": "${good}"}, {"source_url": "${dead}"}]` }),
          stop(0),
          completed('completed')
        ])
      })
    )
    const events = await run({ webSearch: true })
    expect(events.find((e) => e.type === 'citations')).toEqual({
      type: 'citations',
      citations: [{ url: 'https://pubs.acs.org/x', via: [good] }]
    })
  })

  it('maps an output-limit stop to finish "length"', async () => {
    capture(() => sse([created, completed('incomplete', { total_input_tokens: 1 })]))
    expect((await run()).find((e) => e.type === 'finish')).toEqual({ type: 'finish', reason: 'length' })
  })

  it('turns an error event mid-stream into the shared error class', async () => {
    capture(() =>
      sse([
        created,
        { event_type: 'error', error: { message: 'Deadline expired.', code: 'gateway_timeout' } }
      ])
    )
    await expect(run()).rejects.toMatchObject({ code: 'http', message: 'Google: Deadline expired.' })
  })
})

describe('a failed interaction', () => {
  it('books what Google billed before it raises the failure', async () => {
    capture(() =>
      sse([
        created,
        {
          event_type: 'interaction.completed',
          interaction: {
            status: 'failed',
            error: { message: 'Internal error.' },
            usage: { total_input_tokens: 1000, total_output_tokens: 50 }
          }
        }
      ])
    )
    const seen: StreamEvent[] = []
    await expect(
      (async () => {
        for await (const ev of streamChat({ model: 'gemini-3.8-flash', messages: [], temperature: null }))
          seen.push(ev)
      })()
    ).rejects.toMatchObject({ code: 'http', message: 'Internal error.' })
    const usage = seen.filter((e) => e.type === 'usage')
    expect(usage).toHaveLength(1)
    expect(usage[0].type === 'usage' && usage[0].usage.prompt_tokens).toBe(1000)
  })
})

describe('error translation', () => {
  it('reads a bad key from the array-shaped 400, says so, and does not retry', async () => {
    const body = JSON.stringify([
      {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }]
        }
      }
    ])
    const fetchMock = vi.fn(async () => fail(400, body))
    vi.stubGlobal('fetch', fetchMock)
    await expect(run()).rejects.toMatchObject({ code: 'auth' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats "limit: 0" as a tier without the model — billing, never retried', async () => {
    const body = JSON.stringify({
      error: {
        message:
          'Rate limit exceeded for model gemini-4-argon (limit: 0 input tokens per minute on Free Tier).',
        code: 'too_many_requests'
      }
    })
    const fetchMock = vi.fn(async () => fail(429, body))
    vi.stubGlobal('fetch', fetchMock)
    await expect(run({ model: 'gemini-4-argon' })).rejects.toMatchObject({ code: 'credits' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a used-up daily quota, and says when it comes back', async () => {
    const body = JSON.stringify({
      error: {
        message:
          'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-2.5-flash, description: Generate content requests per day limit exceeded on Free Tier.',
        code: 'too_many_requests'
      }
    })
    const fetchMock = vi.fn(async () => fail(429, body))
    vi.stubGlobal('fetch', fetchMock)
    await expect(run()).rejects.toMatchObject({
      code: 'rate_limit',
      message: expect.stringContaining('midnight')
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries an ordinary 429 and a 503, not a 400', () => {
    expect(googleTransport.retryable(429, '{"error":{"message":"Resource exhausted"}}')).toBe(true)
    expect(googleTransport.retryable(503, '')).toBe(true)
    expect(googleTransport.retryable(400, '')).toBe(false)
  })

  it('reads the SSE-shaped error body and keeps the context contract', () => {
    const e = googleTransport.translateStatus(
      400,
      'event: error\ndata: {"error":{"message":"The input token count exceeds the maximum","code":"invalid_request"}}\n'
    )
    expect(e.code).toBe('context')
  })

  it('names the model a 404 is about, and speaks of Google', () => {
    const e = googleTransport.translateStatus(
      404,
      '{"error":{"message":"Model \'gemini-9\' not found.","code":"not_found"}}'
    )
    expect(e.message).toContain("Model 'gemini-9' not found.")
    expect(e.message).not.toMatch(/OpenRouter|OpenAI/)
  })
})

describe('transcription', () => {
  it('gives up on a transcription that does not answer, and says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
      })
    )
    await expect(transcribeAudio({ data: 'AA==', format: 'webm' })).rejects.toMatchObject({ code: 'stalled' })
  })

  it('sends the audio inline to the speech model, unstored, and books what it costs', async () => {
    const { calls } = capture(
      () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            status: 'completed',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Lege einen Prozess an. ' }] }],
            usage: { total_input_tokens: 166, total_output_tokens: 24 }
          })
        }) as unknown as Response
    )
    const out = await transcribeAudio({ data: 'UklGRg==', format: 'webm', language: 'de' })
    expect(out.text).toBe('Lege einen Prozess an.')
    expect(out.model).toBe('gemini-3.5-transcribe')
    expect(out.cost).toBeCloseTo((166 * 2 + 24 * 12) / 1e6, 10)
    const body = JSON.parse(String(calls[0].init.body))
    expect(body).toEqual({
      model: 'gemini-3.5-transcribe',
      store: false,
      input: [
        { type: 'user_input', content: [{ type: 'audio', data: 'UklGRg==', mime_type: 'audio/webm' }] }
      ],
      generation_config: { transcription_config: { language_codes: ['de'] } }
    })
  })
})
