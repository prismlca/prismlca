import { describe, expect, it } from 'vitest'
import {
  classifyFetchFailure,
  errorCodes,
  RetryClock,
  RETRY_AFTER_MAX_MS,
  statusDetail,
  streamFailureDetail
} from './retryPolicy'

const withCode = (code: string, message = code): Error => Object.assign(new Error(message), { code })
const fetchFailed = (cause: unknown): TypeError => new TypeError('fetch failed', { cause })

describe('what a failed fetch is', () => {
  it('reads the code under undici’s "fetch failed"', () => {
    expect(classifyFetchFailure(fetchFailed(withCode('ENOTFOUND')))).toEqual({
      cause: 'offline',
      detail: 'no connection'
    })
  })

  it('reads every address of a host that failed as an AggregateError', () => {
    const aggregate = Object.assign(new AggregateError([withCode('ENETUNREACH'), withCode('EHOSTUNREACH')]), {
      code: 'ENETUNREACH'
    })
    expect(errorCodes(fetchFailed(aggregate))).toEqual(['ENETUNREACH', 'ENETUNREACH', 'EHOSTUNREACH'])
    expect(classifyFetchFailure(fetchFailed(aggregate))?.cause).toBe('offline')
  })

  it('counts a mix of unreachable and timed-out addresses as busy: one dead route proves no outage', () => {
    const aggregate = new AggregateError([withCode('ENETUNREACH'), withCode('ETIMEDOUT')])
    expect(classifyFetchFailure(fetchFailed(aggregate))?.cause).toBe('busy')
  })

  it('counts a connect timeout as busy — a slow host and a dead uplink look the same from here', () => {
    expect(classifyFetchFailure(fetchFailed(withCode('UND_ERR_CONNECT_TIMEOUT')))).toEqual({
      cause: 'busy',
      detail: 'connection failed'
    })
  })

  it('counts a failure without any code, or a reset, as busy', () => {
    expect(classifyFetchFailure(new Error('ECONNRESET'))?.cause).toBe('busy')
    expect(classifyFetchFailure(fetchFailed(withCode('ECONNRESET')))?.cause).toBe('busy')
  })

  it('does not retry what would fail the same way: certificates, and a request that never left', () => {
    expect(classifyFetchFailure(fetchFailed(withCode('CERT_HAS_EXPIRED')))).toBeNull()
    expect(classifyFetchFailure(fetchFailed(withCode('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')))).toBeNull()
    expect(classifyFetchFailure(fetchFailed(withCode('ERR_TLS_CERT_ALTNAME_INVALID')))).toBeNull()
    expect(classifyFetchFailure(new TypeError('Failed to parse URL from nonsense'))).toBeNull()
  })

  it('survives a cause that points back at itself', () => {
    const loop: { code: string; cause?: unknown } = { code: 'ENOTFOUND' }
    loop.cause = loop
    expect(errorCodes(loop)).toEqual(['ENOTFOUND'])
  })
})

describe('the words for the run bar', () => {
  it('names the common refusals', () => {
    expect(statusDetail(429)).toBe('rate limit (429)')
    expect(statusDetail(529)).toBe('overloaded (529)')
    expect(statusDetail(502)).toBe('server error (502)')
    expect(streamFailureDetail('http', 'Overloaded')).toBe('overloaded')
    expect(streamFailureDetail('network', 'cut')).toBe('connection dropped')
  })
})

describe('how long to wait, and until when', () => {
  /** A clock the test moves by hand, and no random share. */
  const clockAt = (windows = {}): { retry: RetryClock; advance: (ms: number) => void } => {
    let t = 0
    return {
      retry: new RetryClock(
        windows,
        () => t,
        () => 0
      ),
      advance: (ms) => (t += ms)
    }
  }

  it('doubles the pause from 2 s up to the cap of its kind', () => {
    const { retry, advance } = clockAt({ busyMs: 1e9 })
    const pauses: number[] = []
    for (let i = 0; i < 6; i++) {
      const p = retry.next('busy')!
      pauses.push(p)
      advance(p)
    }
    expect(pauses).toEqual([2_000, 4_000, 8_000, 16_000, 20_000, 20_000])
  })

  it('counts the window on the wall clock, the time the requests took included', () => {
    const { retry, advance } = clockAt({ busyMs: 30_000 })
    expect(retry.next('busy')).toBe(2_000)
    // A failed request that took 25 s before it failed: 2 s + 25 s spent, a 4 s pause would end at 31 s.
    advance(2_000 + 25_000)
    expect(retry.next('busy')).toBeNull()
  })

  it('keeps the two kinds apart, so a flaky network does not spend the overload allowance', () => {
    const { retry, advance } = clockAt({ busyMs: 10_000, offlineMs: 100_000 })
    expect(retry.next('busy')).toBe(2_000)
    advance(60_000)
    // A minute later the network goes: its own window starts now, its own curve from 2 s.
    expect(retry.next('offline')).toBe(2_000)
  })

  it('stops after ten busy attempts, however long the window', () => {
    const { retry, advance } = clockAt({ busyMs: 1e9 })
    let pauses = 0
    for (let p = retry.next('busy'); p !== null; p = retry.next('busy')) {
      pauses++
      advance(p)
    }
    expect(pauses).toBe(9)
  })

  it("takes the provider's Retry-After instead of the curve, up to a minute", () => {
    const { retry } = clockAt()
    expect(retry.next('busy', 7_000)).toBe(7_000)
    expect(retry.next('busy', RETRY_AFTER_MAX_MS + 1)).toBeNull()
  })

  it('closes when the pause ended far past its time', () => {
    const { retry, advance } = clockAt({ busyMs: 10_000 })
    expect(retry.stillOpen('busy')).toBe(true)
    expect(retry.next('busy')).toBe(2_000)
    advance(2_050) // a timer a little late
    expect(retry.stillOpen('busy')).toBe(true)
    advance(60_000) // a sleeping laptop
    expect(retry.stillOpen('busy')).toBe(false)
  })

  it('leaves its state alone when it says no', () => {
    const { retry } = clockAt({ busyMs: 5_000 })
    expect(retry.next('busy', 10_000)).toBeNull()
    expect(retry.next('busy')).toBe(2_000)
  })
})
