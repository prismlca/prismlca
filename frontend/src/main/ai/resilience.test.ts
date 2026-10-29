/**
 * What the client does when OpenRouter does not answer properly: retry with backoff, and give up on a
 * stream that has gone silent.
 *
 * Worth its own file because both failure modes used to be unhandled, and the way they showed up was as
 * *time* rather than as an error — a live run lost 34 minutes inside one research call that no
 * timeout anywhere could end. Fake timers throughout: the waits are minutes long by design, and a test
 * that actually slept them would be the slowest in the suite by three orders of magnitude.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/prism-resilience-test', getAppPath: () => '/tmp/prism-resilience-test' }
}))

process.env.OPENROUTER_API_KEY = 'test-key'

const { streamChat } = await import('./client')
const { AiProviderError: OpenRouterError } = await import('./providers/types')

/** A completed SSE response with one delta. */
function ok(text = 'hi'): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`)
        )
        c.close()
      }
    })
  } as unknown as Response
}

/** A failure response, optionally asking for a wait. */
function fail(status: number, retryAfter?: string): Response {
  return {
    ok: false,
    status,
    headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}),
    text: async () => '{"error":{"message":"nope"}}',
    body: null
  } as unknown as Response
}

/** A response whose body never produces a chunk and never closes — a hung provider. */
function silent(): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({ start() {} })
  } as unknown as Response
}

/** Drain a stream to completion, returning the text it yielded. */
async function drain(): Promise<string> {
  let out = ''
  for await (const ev of streamChat({ model: 'm', messages: [], temperature: null })) {
    if (ev.type === 'delta') out += ev.text
  }
  return out
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('retrying a request that produced nothing', () => {
  it('retries a rate limit and returns the answer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok('after the wait'))
    vi.stubGlobal('fetch', fetchMock)
    const run = drain()
    await vi.runAllTimersAsync()
    expect(await run).toBe('after the wait')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waits as long as Retry-After asks, not as long as the curve says', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(fail(429, '7')).mockResolvedValueOnce(ok())
    vi.stubGlobal('fetch', fetchMock)
    const run = drain()
    // Past our own first backoff (1.5 s) but short of the provider's 7 s: still exactly one attempt.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.runAllTimersAsync()
    await run
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('gives up after three attempts and reports the status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fail(503))
    vi.stubGlobal('fetch', fetchMock)
    // The assertion is attached BEFORE the timers run: the rejection lands the moment the last
    // backoff elapses, and an unawaited promise at that point is an unhandled rejection, not a failure.
    const rejects = expect(drain()).rejects.toBeInstanceOf(OpenRouterError)
    await vi.runAllTimersAsync()
    await rejects
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry a bad key — sending it again cannot help', async () => {
    const fetchMock = vi.fn().mockResolvedValue(fail(401))
    vi.stubGlobal('fetch', fetchMock)
    const rejects = expect(drain()).rejects.toMatchObject({ code: 'auth' })
    await vi.runAllTimersAsync()
    await rejects
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a dropped connection', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok('second try'))
    vi.stubGlobal('fetch', fetchMock)
    const run = drain()
    await vi.runAllTimersAsync()
    expect(await run).toBe('second try')
  })
})

describe('abandoning a stalled stream', () => {
  it('fails instead of waiting forever when no chunk ever arrives', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(silent()))
    const run = drain()
    const settled = vi.fn()
    const rejects = expect(run).rejects.toMatchObject({ code: 'stalled' })
    void run.then(settled, settled)
    // Well past the first backoff, nowhere near the stall deadline: still waiting, not failed.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(180_000)
    await rejects
  })

  it('leaves a stream that keeps producing alone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('all good')))
    const run = drain()
    await vi.runAllTimersAsync()
    expect(await run).toBe('all good')
  })
})

describe('a request that never reports its usage', () => {
  it('still says so once, so the ledger can count the call', async () => {
    // V166: `onCost` is wired to the usage event, so a stream that ends without one was never
    // booked at all. Four correction calls appeared in the dialog and three in ai-usage.json — and
    // it is the empty answers that go unreported, which are exactly the calls worth counting.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok('no usage block here')))
    const events: string[] = []
    const run = (async () => {
      for await (const ev of streamChat({ model: 'm', messages: [], temperature: null })) {
        events.push(ev.type)
      }
    })()
    await vi.runAllTimersAsync()
    await run
    expect(events.filter((e) => e === 'usage')).toHaveLength(1)
  })

  it('does not add a second one when the provider reported it', async () => {
    const withUsage = (): Response =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"cost":0.01,' +
                  '"prompt_tokens":10,"completion_tokens":4}}\n\ndata: [DONE]\n\n'
              )
            )
            c.close()
          }
        })
      }) as unknown as Response
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(withUsage()))
    const seen: Array<{ completion_tokens?: number }> = []
    const run = (async () => {
      for await (const ev of streamChat({ model: 'm', messages: [], temperature: null })) {
        if (ev.type === 'usage') seen.push(ev.usage)
      }
    })()
    await vi.runAllTimersAsync()
    await run
    expect(seen).toHaveLength(1)
    // …and it carries the output tokens the ledger now records (improvement 4).
    expect(seen[0].completion_tokens).toBe(4)
  })
})
