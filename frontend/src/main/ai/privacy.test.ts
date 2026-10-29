/**
 * The zero-data-retention switch, checked where it actually takes effect: the request body sent to
 * OpenRouter. Worth a test of its own — this is the one setting whose failure mode is silent
 * (prompts reach a logging provider and nothing in the UI looks different), and it is enforced in
 * openrouter.ts alone rather than at each of the seven streamChat call sites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-privacy-test', getAppPath: () => '/tmp/prism-privacy-test' }
}))

process.env.OPENROUTER_API_KEY = 'test-key'

const { streamChat, transcribeAudio } = await import('./client')
const { setZeroDataRetention, getZeroDataRetention, setMinThroughput } = await import(
  './providers/openrouter'
)
const { DEFAULT_ZERO_DATA_RETENTION, DEFAULT_MIN_THROUGHPUT } = await import('../../shared/aiDefaults')

/** An SSE response with a single delta, enough for streamChat to run to completion. */
function sseResponse(): Response {
  const chunk = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(chunk))
        c.close()
      }
    })
  } as unknown as Response
}

/** Run one chat turn against a stubbed fetch and return the parsed request body. */
async function chatBody(model = 'm'): Promise<Record<string, any>> {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse())
  vi.stubGlobal('fetch', fetchMock)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ev of streamChat({ model, messages: [], temperature: null })) {
    /* drain the stream so the request completes */
  }
  return JSON.parse(fetchMock.mock.calls[0][1].body as string)
}

describe('zero-data-retention routing', () => {
  beforeEach(() => {
    setZeroDataRetention(DEFAULT_ZERO_DATA_RETENTION)
    // The throughput preference shares the `provider` object; switch it off so these assertions are
    // about data retention alone.
    setMinThroughput(0)
  })

  it('defaults to on, so an unsynced main process is the safe one', () => {
    expect(DEFAULT_ZERO_DATA_RETENTION).toBe(true)
    expect(getZeroDataRetention()).toBe(true)
  })

  it('restricts provider routing while it is on — both rules, not one', async () => {
    // Two separate promises: `data_collection: deny` picks providers that do not collect (and so
    // cannot train), `zdr: true` narrows further to endpoints that retain nothing.
    expect((await chatBody()).provider).toEqual({ data_collection: 'deny', zdr: true })
  })

  it('drops the retention half for an exempted vendor, and keeps the training half', async () => {
    // Claude Fable 5.1 has no zero-retention endpoint anywhere (measured), so a blanket
    // rule would 404 it. The exception gives up retention for that vendor — never collection.
    setZeroDataRetention(true, { anthropic: true, openai: true, google: true })
    expect((await chatBody('anthropic/claude-fable-5.1')).provider).toEqual({ data_collection: 'deny' })
    expect((await chatBody('openai/gpt-6-astra')).provider).toEqual({ data_collection: 'deny' })
    // Google likewise: its endpoints log prompts for abuse monitoring.
    expect((await chatBody('google/gemini-4-argon')).provider).toEqual({ data_collection: 'deny' })
    // Everyone else stays strict.
    expect((await chatBody('z-ai/glm-5.3')).provider).toEqual({ data_collection: 'deny', zdr: true })
  })

  it('enforces retention for a vendor whose exception is unticked', async () => {
    setZeroDataRetention(true, { anthropic: false, openai: true, google: true })
    expect((await chatBody('anthropic/claude-opus-5.5')).provider).toEqual({
      data_collection: 'deny',
      zdr: true
    })
  })

  it('omits the provider constraint entirely once switched off', async () => {
    setZeroDataRetention(false)
    const body = await chatBody()
    // Absent, not `{data_collection: 'allow'}`: the point is to stop narrowing the provider pool.
    expect(body.provider).toBeUndefined()
    expect(body.usage).toEqual({ include: true }) // the rest of the body is untouched
  })
})

describe('reasoning effort pass-through', () => {
  it('sends reasoning.effort when a caller sets it, and nothing otherwise', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => sseResponse())
    vi.stubGlobal('fetch', fetchMock)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ev of streamChat({
      model: 'm',
      messages: [],
      temperature: null,
      reasoningEffort: 'low'
    })) {
      /* drain the stream so the request completes */
    }
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).reasoning).toEqual({ effort: 'low' })
    // Unset means unset — the model keeps its own default rather than getting ours.
    expect((await chatBody()).reasoning).toBeUndefined()
  })
})

describe('preferred provider throughput', () => {
  beforeEach(() => {
    setZeroDataRetention(DEFAULT_ZERO_DATA_RETENTION)
    setMinThroughput(DEFAULT_MIN_THROUGHPUT)
  })

  it('rides alongside the data-retention rule rather than replacing it', async () => {
    // All three live in one `provider` object; a change to any must not quietly drop the others.
    expect((await chatBody()).provider).toEqual({
      data_collection: 'deny',
      zdr: true,
      preferred_min_throughput: DEFAULT_MIN_THROUGHPUT
    })
  })

  it('is expressed on its own when data retention is allowed', async () => {
    setZeroDataRetention(false)
    expect((await chatBody()).provider).toEqual({ preferred_min_throughput: DEFAULT_MIN_THROUGHPUT })
  })

  it('says nothing at all at zero, so routing behaves exactly as before', async () => {
    setZeroDataRetention(false)
    setMinThroughput(0)
    expect((await chatBody()).provider).toBeUndefined()
  })

  it('keeps transcription on zero-retention providers even when chat is switched off', async () => {
    setZeroDataRetention(false)
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ text: 'hello' })
    }))
    vi.stubGlobal('fetch', fetchMock)
    await transcribeAudio({ data: 'AAA', format: 'webm' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.provider).toEqual({ data_collection: 'deny' })
  })
})
