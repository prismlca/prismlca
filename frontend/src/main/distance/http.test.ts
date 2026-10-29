import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DistanceHttpError, fetchJson, RateGate } from './http'

describe('RateGate', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('never admits more than perMinute starts in any 60 s window', async () => {
    const gate = new RateGate(40, 4)
    const started: number[] = []
    const jobs = Array.from({ length: 90 }, () =>
      gate.run(async () => {
        started.push(Date.now())
      })
    )
    await vi.advanceTimersByTimeAsync(200_000)
    await Promise.all(jobs)
    expect(started).toHaveLength(90)
    for (let i = 0; i < started.length; i++) {
      const window = started.filter((t) => t >= started[i] && t < started[i] + 60_000)
      expect(window.length).toBeLessThanOrEqual(40)
    }
  })

  it('caps concurrency', async () => {
    const gate = new RateGate(1000, 3)
    let inFlight = 0
    let peak = 0
    const jobs = Array.from({ length: 12 }, () =>
      gate.run(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 100))
        inFlight -= 1
      })
    )
    await vi.advanceTimersByTimeAsync(5_000)
    await Promise.all(jobs)
    expect(peak).toBe(3)
  })

  it('releases the slot when the job throws', async () => {
    const gate = new RateGate(1000, 1)
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    let ran = false
    const p = gate.run(async () => {
      ran = true
    })
    await vi.advanceTimersByTimeAsync(10)
    await p
    expect(ran).toBe(true)
  })
})

const res = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })

describe('fetchJson', () => {
  it('returns parsed JSON and the headers on 2xx', async () => {
    const fetchImpl = vi.fn(async () => res(200, { ok: 1 }, { 'x-ratelimit-remaining': '39' }))
    const out = await fetchJson<{ ok: number }>('https://x', { method: 'GET' }, { fetchImpl })
    expect(out.data.ok).toBe(1)
    expect(out.headers.get('x-ratelimit-remaining')).toBe('39')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries once on 429 and then gives the described error', async () => {
    vi.useFakeTimers()
    const fetchImpl = vi.fn(async () => res(429, { error: 'slow down' }, { 'retry-after': '1' }))
    const p = fetchJson(
      'https://x',
      { method: 'GET' },
      {
        fetchImpl,
        describeError: (s) => (s === 429 ? 'rate limited' : undefined)
      }
    ).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    const err = (await p) as DistanceHttpError
    vi.useRealTimers()
    expect(err).toBeInstanceOf(DistanceHttpError)
    expect(err.status).toBe(429)
    expect(err.message).toBe('rate limited')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 4xx that is not a rate limit', async () => {
    const fetchImpl = vi.fn(async () => res(401, { error: 'Authorization field missing' }))
    await expect(fetchJson('https://x', { method: 'GET' }, { fetchImpl })).rejects.toMatchObject({
      status: 401,
      message: 'HTTP 401'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('fetchJson hardening', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const ok = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('blanks header values out of a network error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Headers.append: "secret-key-1234" is an invalid header value.')
    })
    const p = fetchJson(
      'https://x',
      { headers: { Authorization: 'secret-key-1234' } },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 1_000
      }
    )
    const settled = p.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(5_000)
    const err = (await settled) as Error
    expect(err).toBeInstanceOf(DistanceHttpError)
    expect(err.message).toContain('[redacted]')
    expect(err.message).not.toContain('secret-key-1234')
  })

  it('counts every attempt, the retry included', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => ok(n++ === 0 ? { error: 'x' } : { fine: 1 }, n === 1 ? 500 : 200))
    const onAttempt = vi.fn()
    const p = fetchJson('https://x', {}, { fetchImpl: fetchImpl as unknown as typeof fetch, onAttempt })
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await p).data).toEqual({ fine: 1 })
    expect(onAttempt).toHaveBeenCalledTimes(2)
  })

  it('the timeout covers the body, not only the headers', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: () =>
          new Promise<string>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          )
      } as unknown as Response
    })
    const p = fetchJson(
      'https://x',
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1_000 }
    )
    const settled = p.catch((e: Error) => e)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(((await settled) as Error).message).toMatch(/No answer within 1 s/)
  })

  it('a stopped caller stops the request', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const fetchImpl = vi.fn(async () => ok({}))
    await expect(
      fetchJson('https://x', {}, { fetchImpl: fetchImpl as unknown as typeof fetch, signal: ctrl.signal })
    ).rejects.toThrow('Stopped.')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
