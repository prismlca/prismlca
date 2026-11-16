import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat } from './test/fakeStream'
import { createRequestLog, requestLine, sentChars } from './requestLog'

/**
 * The line a research leg or a review attempt leaves in the app log: who served the request, what it
 * cost, how much of its prompt came from the cache. Offline against the shared scripted stream.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())

const { collectText } = await import('./stream')

/** The messages written through the app log, without stamp and tag. */
type Spy = { mock: { calls: unknown[][] } }
const lines = (spy: Spy): string[] => spy.mock.calls.map((c) => String(c[0]).replace(/^.*?\[prism-ai\] /, ''))

let log: Spy
beforeEach(() => {
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  chat.rounds = []
  chat.seen = []
})
afterEach(() => vi.restoreAllMocks())

describe('the request line', () => {
  it('starts with the role, gives the figures of a round in the same order and ends with the model', () => {
    const line = requestLine({
      role: 'research_web',
      model: 'test/model',
      provider: 'openrouter',
      servedBy: 'Widgets Inc',
      firstTokenMs: 1_200,
      durationMs: 8_400,
      sentChars: 3_400,
      web: '3 web searches, 2 pages fetched',
      usage: {
        cost: 0.38,
        prompt_tokens: 125_600,
        completion_tokens: 432,
        prompt_tokens_details: { cached_tokens: 62_800 }
      },
      notes: ['reasoning 12k chars']
    })
    expect(line).toBe(
      'research_web: cache: 62800/125600 prompt tokens (50%), $0.3800, first token 1.2 s, request 8.4 s, ' +
        '432 out tokens, 60 tok/s, via OpenRouter/Widgets Inc, sent ≈3k chars, ' +
        'web: 3 web searches, 2 pages fetched, reasoning 12k chars — test/model'
    )
  })

  it('does not start the way a round does, so a reader counting rounds does not count it', () => {
    const line = requestLine({ role: 'review_model', model: 'm', provider: 'anthropic', durationMs: 1 })
    expect(line).not.toMatch(/^cache:/)
    expect(line).toMatch(/^review_model: cache: no usage reported/)
    expect(line).toContain('via anthropic (direct)')
  })

  it('counts the characters of text and of other parts of the messages', () => {
    expect(
      sentChars([
        { role: 'system', content: 'abc' },
        { role: 'user', content: [{ type: 'text', text: 'de' }] },
        { role: 'assistant', content: null }
      ])
    ).toBe(3 + JSON.stringify([{ type: 'text', text: 'de' }]).length)
  })
})

describe('the request log', () => {
  /** A clock the test moves by hand. */
  const clock = (): { now: () => number; at: (t: number) => void } => {
    let t = 0
    return { now: () => t, at: (v) => void (t = v) }
  }

  it('takes OpenRouter’s first chunk as the first token and adds up what the stream reports', () => {
    const c = clock()
    const r = createRequestLog({
      role: 'research_bom',
      model: 'test/model',
      provider: 'openrouter',
      now: c.now
    })
    c.at(2_000)
    r.event({ type: 'provider', name: 'Widgets Inc' })
    r.event({ type: 'reasoning', chars: 4_600 })
    r.event({ type: 'delta', text: 'Steel tub: 11 kg' })
    r.event({
      type: 'usage',
      usage: {
        cost: 0.4,
        prompt_tokens: 50_000,
        completion_tokens: 900,
        prompt_tokens_details: { cached_tokens: 10_000 },
        server_tool_use: { web_search_requests: 4, web_fetch_requests: 1 }
      }
    })
    r.event({ type: 'finish', reason: 'stop' })
    c.at(11_000)
    r.end()
    expect(lines(log)).toEqual([
      'research_bom: cache: 10000/50000 prompt tokens (20%), $0.4000, first token 2.0 s, request 11.0 s, ' +
        '900 out tokens, 100 tok/s, via OpenRouter/Widgets Inc, web: 4 web searches, 1 page fetched, ' +
        'reasoning 5k chars — test/model'
    ])
  })

  it('does not take a direct provider naming itself for the first token', () => {
    const c = clock()
    const r = createRequestLog({
      role: 'review_model',
      model: 'test/model',
      provider: 'anthropic',
      now: c.now
    })
    r.event({ type: 'provider', name: 'Anthropic' })
    c.at(3_000)
    r.event({ type: 'delta', text: 'Blocking: none.' })
    c.at(4_000)
    r.end()
    expect(lines(log)[0]).toContain('first token 3.0 s, request 4.0 s')
    expect(lines(log)[0]).toContain('via Anthropic (direct)')
  })

  it('counts time from a re-send, keeps what the failed attempt cost and says how many were billed', () => {
    const c = clock()
    const r = createRequestLog({
      role: 'research_web',
      model: 'test/model',
      provider: 'openrouter',
      now: c.now
    })
    r.event({ type: 'usage', usage: { cost: 0.1, prompt_tokens: 1_000, completion_tokens: 0 } })
    c.at(30_000)
    r.event({ type: 'retry', phase: 'send', attempt: 2 })
    c.at(31_000)
    r.event({ type: 'provider', name: 'Widgets Inc' })
    r.event({ type: 'usage', usage: { cost: 0.2, prompt_tokens: 1_000, completion_tokens: 50 } })
    c.at(36_000)
    r.end()
    expect(lines(log)[0]).toContain('$0.3000 for 2 requests, first token 1.0 s, request 6.0 s')
  })

  it('names an end that was not the natural one, a failure, and what the caller adds', () => {
    const r = createRequestLog({ role: 'review_model', model: 'test/model', provider: 'openrouter' })
    r.event({ type: 'finish', reason: 'length' })
    r.end({ failed: true, notes: ['attempt 2'] })
    expect(lines(log)[0]).toMatch(/, failed, .*attempt 2, finish length — test\/model$/)
  })

  it('writes one line, whatever arrives or is called after the end', () => {
    const r = createRequestLog({ role: 'research_web', model: 'test/model', provider: 'openrouter' })
    r.end()
    r.event({ type: 'usage', usage: { cost: 9 } })
    r.end()
    expect(lines(log)).toHaveLength(1)
    expect(lines(log)[0]).not.toContain('$9')
  })
})

describe('collectText', () => {
  const usage = { cost: 0.05, prompt_tokens: 2_000, completion_tokens: 40 }

  it('leaves one line under the name it was given, with the endpoint that served the request', async () => {
    chat.rounds = [
      { before: [{ type: 'provider', name: 'Widgets Inc' }], text: 'An answer.', usage, finish: 'stop' }
    ]
    const text = await collectText({
      model: 'test/model',
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'x'.repeat(4_200) }],
      logAs: 'research_web'
    })
    expect(text).toBe('An answer.')
    const written = lines(log)
    expect(written).toHaveLength(1)
    expect(written[0]).toMatch(/^research_web: cache: 0\/2000 prompt tokens \(0%\), \$0\.0500, /)
    expect(written[0]).toMatch(/via OpenRouter\/Widgets Inc, sent ≈4k chars — test\/model$/)
  })

  it('writes nothing for a request that was given no name', async () => {
    chat.rounds = [{ before: [{ type: 'provider', name: 'Widgets Inc' }], text: 'An answer.', usage }]
    await collectText({
      model: 'test/model',
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'q' }]
    })
    expect(lines(log)).toEqual([])
  })

  it('writes the line of a request that failed, and lets the failure through', async () => {
    chat.rounds = [
      { before: [{ type: 'provider', name: 'Widgets Inc' }], throws: new Error('upstream gone') }
    ]
    await expect(
      collectText({
        model: 'test/model',
        provider: 'openrouter',
        messages: [{ role: 'user', content: 'q' }],
        logAs: 'research_bom'
      })
    ).rejects.toThrow('upstream gone')
    expect(lines(log)).toHaveLength(1)
    expect(lines(log)[0]).toMatch(
      /^research_bom: cache: no usage reported, .*failed, via OpenRouter\/Widgets Inc/
    )
  })
})
