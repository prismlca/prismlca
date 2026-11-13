import { afterEach, describe, expect, it, vi } from 'vitest'
import { localDate, localTimestamp } from './localTime'
import { aiLine } from './aiLog'
import { createRunTelemetry, roundLine, tokensPerSecond } from './roundLog'

afterEach(() => vi.restoreAllMocks())

describe('the log stamp', () => {
  it('writes the local date and time in front of the tag', () => {
    // A Saturday evening, local time.
    const at = new Date(2026, 10, 14, 18, 5, 9, 7)
    expect(localDate(at)).toBe('2026-11-14')
    expect(localTimestamp(at)).toBe('2026-11-14 18:05:09.007')
    expect(aiLine('cache: 1/2 prompt tokens', at)).toBe(
      '2026-11-14 18:05:09.007 [prism-ai] cache: 1/2 prompt tokens'
    )
  })

  it('looks up the console on every call, so a redirect made later still applies', async () => {
    const { aiLog } = await import('./aiLog')
    const seen: string[] = []
    const original = console.log
    console.log = (...a: unknown[]) => void seen.push(String(a[0]))
    try {
      aiLog('served by Widgets Inc — test/model')
    } finally {
      console.log = original
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[prism-ai\] served by Widgets Inc/)
  })
})

describe('the round line', () => {
  const base = { round: 3, model: 'test/model', provider: 'openrouter' as const, durationMs: 8_400 }

  it('is written also when the cache served nothing, with route, cost and speed', () => {
    const line = roundLine({
      ...base,
      servedBy: 'Sail',
      firstTokenMs: 1_200,
      sentChars: 412_000,
      usage: {
        cost: 0.38,
        prompt_tokens: 125_600,
        completion_tokens: 432,
        prompt_tokens_details: { cached_tokens: 0 },
        generation_id: 'gen-1'
      }
    })
    expect(line).toBe(
      'cache: 0/125600 prompt tokens (0%), $0.3800, first token 1.2 s, round 8.4 s, 432 out tokens, 60 tok/s, ' +
        'via OpenRouter/Sail, sent ≈412k chars, gen gen-1 — test/model (round 3)'
    )
    // The old line's opening, which log readers match on.
    expect(line).toMatch(/^cache: (\d+)\/(\d+) prompt tokens/)
  })

  it('names a direct provider, marks an estimated cost and a missing first token', () => {
    const line = roundLine({
      ...base,
      provider: 'anthropic',
      servedBy: 'Anthropic',
      usage: {
        cost: 0.012,
        estimated: true,
        prompt_tokens: 40_000,
        completion_tokens: 84,
        prompt_tokens_details: { cached_tokens: 39_000 }
      }
    })
    expect(line).toContain('cache: 39000/40000 prompt tokens (98%), ≈$0.0120, first token —, round 8.4 s')
    expect(line).toContain('84 out tokens, 10 tok/s, via Anthropic (direct)')
  })

  it('says so when the provider reported no usage', () => {
    expect(roundLine({ ...base, usage: {} })).toMatch(
      /^cache: no usage reported, first token —, round 8\.4 s/
    )
  })

  it('counts speed from the first token on, and over the round when there was none', () => {
    const usage = { completion_tokens: 600 }
    expect(tokensPerSecond({ usage, firstTokenMs: 2_000, durationMs: 8_000 })).toBe(100)
    expect(tokensPerSecond({ usage, durationMs: 6_000 })).toBe(100)
    expect(tokensPerSecond({ usage: {}, durationMs: 6_000 })).toBeNull()
  })
})

describe('the run telemetry', () => {
  /** A clock the test moves by hand. */
  const clock = (): { now: () => number; at: (t: number) => void } => {
    let t = 0
    return { now: () => t, at: (v) => void (t = v) }
  }
  const usage = (prompt: number, cached: number) => ({
    prompt_tokens: prompt,
    completion_tokens: 100,
    prompt_tokens_details: { cached_tokens: cached }
  })

  it('times the first token from the last re-send, and takes OpenRouter’s first chunk as it', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = clock()
    const t = createRunTelemetry({ model: 'test/model', provider: 'openrouter', now: c.now })
    t.begin(0, 10_000)
    c.at(5_000)
    t.resend()
    c.at(6_500)
    t.servedBy('Widgets Inc')
    c.at(7_000)
    t.output()
    t.usage(usage(30_000, 0))
    c.at(9_000)
    t.end()
    const line = String(log.mock.calls[0][0])
    expect(line).toContain('first token 1.5 s, round 4.0 s')
    expect(line).toContain('via OpenRouter/Widgets Inc')
    expect(line).toContain('(round 1)')
  })

  it('does not take a direct API’s opening event for the first token', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = clock()
    const t = createRunTelemetry({ model: 'test/model', provider: 'google', now: c.now })
    t.begin(0, 10_000)
    c.at(100)
    t.servedBy('Google')
    c.at(3_000)
    t.end()
    expect(String(log.mock.calls[0][0])).toContain('first token —, round 3.0 s')
  })

  it('warns in the log on every alarm and tells the run bar each change, the recovery too', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const alarms: string[] = []
    const t = createRunTelemetry({
      model: 'test/model',
      provider: 'openrouter',
      onCacheSignal: (a) => alarms.push(a)
    })
    const round = (prompt: number, cached: number): void => {
      t.begin(0, 1)
      t.servedBy('Sail')
      t.usage(usage(prompt, cached))
      t.end()
    }
    round(50_000, 40_000)
    round(70_000, 0)
    round(90_000, 89_000)
    round(110_000, 0)
    expect(alarms).toEqual(['dropped', 'recovered', 'dropped'])
    const lines = warn.mock.calls.map((c) => String(c[0]))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("[prism-ai] cache warning: none of this round's 70000 prompt tokens")
    expect(lines[0]).toContain('via OpenRouter/Sail')
  })

  it('adds up every request a round billed, and counts a failed attempt’s cost but not its figures', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const c = clock()
    const t = createRunTelemetry({ model: 'test/model', provider: 'anthropic', now: c.now })
    t.begin(4, 1_000)
    // An attempt that streamed, was billed and failed; then the re-send, whose reply was paused once.
    t.usage({ cost: 0.5, prompt_tokens: 90_000, completion_tokens: 900 })
    c.at(1_000)
    t.resend()
    t.usage({
      cost: 0.1,
      prompt_tokens: 100_000,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 90_000 }
    })
    t.usage({
      cost: 0.05,
      prompt_tokens: 101_000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 100_000 }
    })
    c.at(5_000)
    t.end()
    const line = String(log.mock.calls[0][0])
    expect(line).toContain('cache: 190000/201000 prompt tokens (95%), $0.6500 for 3 requests')
    expect(line).toContain('round 4.0 s, 400 out tokens, 100 tok/s')
    expect(line).toContain('(round 5)')
  })

  it('closes a failed round with what it got to, and keeps it from the cache watch', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const t = createRunTelemetry({ model: 'test/model', provider: 'openrouter' })
    t.begin(0, 1)
    t.usage(usage(50_000, 40_000))
    t.end()
    t.begin(1, 1)
    t.servedBy('Sail')
    t.usage(usage(60_000, 0))
    t.end({ failed: true })
    expect(String(log.mock.calls[1][0])).toMatch(
      /cache: 0\/60000 prompt tokens \(0%\), .*, failed, .*via OpenRouter\/Sail/
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('writes nothing for a round that never began', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    createRunTelemetry({ model: 'test/model', provider: 'openrouter' }).end()
    expect(log).not.toHaveBeenCalled()
  })
})
