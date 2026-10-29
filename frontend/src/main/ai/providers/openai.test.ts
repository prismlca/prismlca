/**
 * The direct-OpenAI transport, checked where its differences bite: the Responses-API request body
 * (nothing OpenRouter-shaped may leave the app), the event-stream translation, the locally
 * synthesized cost (the ONLY thing the cost breaker sees on this provider), and the two error
 * semantics that differ — the quota-429 that must not be retried, and the context-400 that must
 * keep the compact-and-retry path alive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-openai-test', getAppPath: () => '/tmp/prism-openai-test' }
}))

process.env.OPENAI_API_KEY = 'test-openai-key'
process.env.OPENROUTER_API_KEY = 'test-openrouter-key'

const { streamChat, transcribeAudio } = await import('../client')
const { AiProviderError: OpenRouterError } = await import('./types')
const { setActiveProvider } = await import('./state')
const { toResponsesInput } = await import('./openai')
const { DEFAULT_OPENAI_MODEL_ID } = await import('../../../shared/aiDefaults')
import type { ChatMessage, StreamEvent } from './types'

/** One SSE response made of Responses-API events. */
function sse(events: Array<Record<string, unknown>>): Response {
  const chunk = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
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

function fail(status: number, body: Record<string, unknown>): Response {
  return {
    ok: false,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
    body: null
  } as unknown as Response
}

const completed = (usage?: Record<string, unknown>): Record<string, unknown> => ({
  type: 'response.completed',
  response: { usage }
})

async function run(
  opts: Partial<Parameters<typeof streamChat>[0]> & { model?: string }
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const ev of streamChat({
    model: 'gpt-6-luna',
    messages: [],
    temperature: null,
    ...opts
  })) {
    events.push(ev)
  }
  return events
}

beforeEach(() => setActiveProvider('openai'))
afterEach(() => {
  setActiveProvider('openrouter')
  vi.unstubAllGlobals()
})

describe('the request body', () => {
  it('speaks the Responses API and nothing OpenRouter-shaped', async () => {
    const fetchMock = vi.fn(async () => sse([completed()]))
    vi.stubGlobal('fetch', fetchMock)
    await run({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' }
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'do_it', description: 'does it', parameters: { type: 'object' } }
        }
      ],
      webSearch: true,
      reasoningEffort: 'low',
      maxTokens: 30_000
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/responses')
    const body = JSON.parse(init.body as string)
    // The OpenRouter request features must not travel here — this is the privacy mirror test.
    expect(body.provider).toBeUndefined()
    expect(body.usage).toBeUndefined()
    expect(body.max_tokens).toBeUndefined()
    expect((init.headers as Record<string, string>)['HTTP-Referer']).toBeUndefined()
    // …and the Responses shape does.
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body.max_output_tokens).toBe(30_000)
    expect(body.instructions).toBe('be terse')
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.reasoning).toEqual({ effort: 'low' })
    // Tool specs are FLAT here, and web search is the native server tool, not openrouter:*.
    expect(body.tools).toEqual([
      { type: 'function', name: 'do_it', description: 'does it', parameters: { type: 'object' } },
      { type: 'web_search' }
    ])
  })

  it('sends a model of the other provider nowhere — the id degrades to the OpenAI default', async () => {
    const fetchMock = vi.fn(async () => sse([completed()]))
    vi.stubGlobal('fetch', fetchMock)
    await run({ model: 'z-ai/glm-5.3' })
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.model).toBe(DEFAULT_OPENAI_MODEL_ID)
  })

  it('replays tool calls and results as function_call / function_call_output items', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'build it' },
      {
        role: 'assistant',
        content: 'On it.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'do_it', arguments: '{"a":1}' } }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' }
    ]
    const { instructions, input } = toResponsesInput(messages)
    expect(instructions).toBe('sys')
    expect(input).toEqual([
      { role: 'user', content: 'build it' },
      { role: 'assistant', content: 'On it.' },
      { type: 'function_call', call_id: 'call_1', name: 'do_it', arguments: '{"a":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' }
    ])
  })

  it('converts vision parts to the Responses input shapes', () => {
    const { input } = toResponsesInput([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is on the canvas?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }
        ]
      }
    ])
    expect(input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is on the canvas?' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA' }
        ]
      }
    ])
  })
})

describe('the event stream', () => {
  it('translates text deltas, assembles tool calls, and reports who served it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          { type: 'response.created' },
          { type: 'response.output_text.delta', delta: 'Hello' },
          {
            type: 'response.output_item.added',
            output_index: 1,
            item: { type: 'function_call', call_id: 'call_9', name: 'do_it', arguments: '' }
          },
          { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"a"' },
          { type: 'response.function_call_arguments.delta', output_index: 1, delta: ':1}' },
          {
            type: 'response.output_item.done',
            output_index: 1,
            item: { type: 'function_call', call_id: 'call_9', name: 'do_it', arguments: '{"a":1}' }
          },
          completed({ input_tokens: 10, output_tokens: 4 })
        ])
      )
    )
    const events = await run({})
    expect(events.find((e) => e.type === 'provider')).toEqual({ type: 'provider', name: 'OpenAI' })
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e: any) => e.text)
        .join('')
    ).toBe('Hello')
    expect(events.find((e) => e.type === 'finish')).toEqual({ type: 'finish', reason: 'tool_calls' })
    const calls = events.find((e) => e.type === 'tool_calls') as any
    expect(calls.calls).toEqual([{ id: 'call_9', name: 'do_it', arguments: '{"a":1}' }])
  })

  it('passes a url_citation annotation on as a citations event (URL and title, no excerpt)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          { type: 'response.created' },
          { type: 'response.output_text.delta', delta: 'Berlin has 3.7 M' },
          {
            type: 'response.output_text.annotation.added',
            annotation: {
              type: 'url_citation',
              url: 'https://destatis.de/x',
              title: 'Destatis',
              start_index: 0,
              end_index: 5
            }
          },
          {
            type: 'response.output_text.annotation.added',
            annotation: { type: 'file_citation', file_id: 'f' }
          },
          completed({ input_tokens: 10, output_tokens: 4 })
        ])
      )
    )
    const events = await run({ webSearch: true })
    expect(events.filter((e) => e.type === 'citations')).toEqual([
      { type: 'citations', citations: [{ url: 'https://destatis.de/x', title: 'Destatis' }] }
    ])
  })

  it('synthesizes the cost from the catalogue list prices and marks it as an estimate', async () => {
    // gpt-6-luna: $0.10 input / $0.01 cached / $0.50 output per 1M (models.ts).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          completed({
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 500 },
            output_tokens: 2000
          })
        ])
      )
    )
    const events = await run({})
    const usages = events.filter((e) => e.type === 'usage') as any[]
    expect(usages).toHaveLength(1) // the engine adds no second, empty one
    const u = usages[0].usage
    // (500·0.10 + 500·0.01 + 2000·0.50) / 1e6
    expect(u.cost).toBeCloseTo(0.001055, 8)
    expect(u.estimated).toBe(true)
    expect(u.prompt_tokens).toBe(1000)
    expect(u.prompt_tokens_details.cached_tokens).toBe(500)
    expect(u.completion_tokens).toBe(2000)
  })

  it('adds the per-call web_search fee to the synthesized cost', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call' } },
          { type: 'response.output_item.added', output_index: 1, item: { type: 'web_search_call' } },
          completed({ input_tokens: 0, output_tokens: 0 })
        ])
      )
    )
    const events = await run({ webSearch: true })
    const u = (events.find((e) => e.type === 'usage') as any).usage
    expect(u.cost).toBeCloseTo(0.02, 8) // 2 searches × $10/1k
  })

  it('maps an exhausted-output run to finish "length"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sse([
          { type: 'response.output_text.delta', delta: 'partial' },
          {
            type: 'response.incomplete',
            response: {
              incomplete_details: { reason: 'max_output_tokens' },
              usage: { input_tokens: 1, output_tokens: 1 }
            }
          }
        ])
      )
    )
    const events = await run({})
    expect(events.find((e) => e.type === 'finish')).toEqual({ type: 'finish', reason: 'length' })
  })
})

describe('error translation', () => {
  it('treats the quota-429 as credits and does NOT retry it', async () => {
    // OpenAI sends "out of credits" as HTTP 429 (insufficient_quota). Retrying that is a
    // ten-second hang ending in the same error — one attempt, translated honestly.
    const fetchMock = vi.fn(async () =>
      fail(429, { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota' } })
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(run({})).rejects.toMatchObject({ code: 'credits' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the compact-and-retry contract: a too-long request reads as code "context"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fail(400, {
          error: {
            message: 'This model’s maximum context length is exceeded.',
            code: 'context_length_exceeded'
          }
        })
      )
    )
    await expect(run({})).rejects.toMatchObject({ code: 'context' })
  })

  it('speaks about OpenAI, never about OpenRouter, and stays the shared error class', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fail(401, { error: { message: 'bad key' } }))
    )
    const err = await run({}).catch((e) => e)
    expect(err).toBeInstanceOf(OpenRouterError) // the shared AiProviderError under its alias
    expect(err.code).toBe('auth')
    expect(String(err.message)).toContain('OpenAI')
    expect(String(err.message)).not.toContain('OpenRouter')
  })
})

describe('transcription', () => {
  it('uploads multipart with a named file and books under the OpenAI STT model', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: ' hello ', usage: { type: 'duration', seconds: 120 } })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await transcribeAudio({
      data: Buffer.from('x').toString('base64'),
      format: 'webm',
      language: 'de'
    })
    expect(r.text).toBe('hello')
    expect(r.model).toBe('gpt-transcribe')
    expect(r.cost).toBeCloseTo(0.009, 6) // 2 min × $0.0045
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    const fd = init.body as FormData
    expect(fd).toBeInstanceOf(FormData)
    expect(fd.get('model')).toBe('gpt-transcribe')
    expect(fd.get('language')).toBe('de')
    expect((fd.get('file') as File).name).toBe('audio.webm')
    // No JSON content type — fetch writes the multipart boundary itself.
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })
})
