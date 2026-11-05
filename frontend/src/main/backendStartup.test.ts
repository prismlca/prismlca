/**
 * The backend's start-up channel is read once, its connection details are checked, and the readiness
 * probe carries no credentials.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLoopbackHost, probeHealth, startupReader, waitForHealth, type BackendInfo } from './backendStartup'

const READY = {
  event: 'prism-backend-ready',
  host: '127.0.0.1',
  port: 50123,
  token: 'tok-1',
  version: '1.0.0'
}

function reader(): {
  feed: (chunk: string) => void
  ready: BackendInfo[]
  refused: string[]
  progress: string[]
} {
  const ready: BackendInfo[] = []
  const refused: string[] = []
  const progress: string[] = []
  const feed = startupReader({
    ready: (info) => ready.push(info),
    refused: (reason) => refused.push(reason),
    progress: (detail) => progress.push(detail)
  })
  return { feed, ready, refused, progress }
}

const line = (msg: object): string => JSON.stringify(msg) + '\n'

describe('start-up channel', () => {
  it('reads the handshake, also when it arrives in pieces between log lines', () => {
    const r = reader()
    const text = 'INFO: something\n' + line(READY)
    r.feed(text.slice(0, 30))
    r.feed(text.slice(30))
    expect(r.ready).toEqual([{ host: '127.0.0.1', port: 50123, token: 'tok-1', version: '1.0.0' }])
    expect(r.refused).toEqual([])
  })

  it('believes the first handshake only', () => {
    const r = reader()
    r.feed(line(READY))
    const later = line({ ...READY, port: 50999, token: 'tok-2' })
    r.feed(later.slice(0, 20))
    r.feed(later.slice(20))
    r.feed(line({ event: 'prism-backend-refused', reason: 'late' }))
    r.feed(line({ event: 'prism-backend-progress', detail: 'late' }))
    expect(r.ready).toHaveLength(1)
    expect(r.ready[0].token).toBe('tok-1')
    expect(r.refused).toEqual([])
    expect(r.progress).toEqual([])
  })

  it('ignores a second handshake that arrives in the same chunk as the first', () => {
    const r = reader()
    r.feed(line(READY) + line({ ...READY, token: 'tok-2' }))
    expect(r.ready.map((i) => i.token)).toEqual(['tok-1'])
  })

  it.each(['0.0.0.0', '10.0.0.5', '192.168.1.20', '::', 'example.com', '', undefined])(
    'refuses a handshake whose host %s is not on this computer',
    (host) => {
      const r = reader()
      r.feed(line({ ...READY, host }))
      expect(r.ready).toEqual([])
      expect(r.refused).toHaveLength(1)
      expect(r.refused[0]).toMatch(/not on this computer/)
    }
  )

  it.each([
    [{ port: 0 }, /invalid port/],
    [{ port: 70000 }, /invalid port/],
    [{ port: '50123' }, /invalid port/],
    [{ token: '' }, /no access token/],
    [{ token: 42 }, /no access token/]
  ])('refuses a handshake with %o', (patch, why) => {
    const r = reader()
    r.feed(line({ ...READY, ...patch }))
    expect(r.ready).toEqual([])
    expect(r.refused[0]).toMatch(why)
  })

  it('accepts the loopback names the backend may bind', () => {
    for (const host of ['127.0.0.1', '127.0.1.1', '::1', 'localhost']) expect(isLoopbackHost(host)).toBe(true)
    for (const host of ['0.0.0.0', '128.0.0.1', '::ffff:10.0.0.1', '127.0.0.1.example.com'])
      expect(isLoopbackHost(host)).toBe(false)
  })

  it('passes progress on until the backend refuses, then reads nothing more', () => {
    const r = reader()
    r.feed(line({ event: 'prism-backend-progress', detail: 'Copying workspace 1 of 2' }))
    r.feed(line({ event: 'prism-backend-progress' }))
    r.feed(line({ event: 'prism-backend-refused', reason: 'Another copy is running.' }))
    r.feed(line(READY))
    expect(r.progress).toEqual(['Copying workspace 1 of 2', ''])
    expect(r.refused).toEqual(['Another copy is running.'])
    expect(r.ready).toEqual([])
  })
})

describe('readiness probe', () => {
  let server: http.Server | null = null
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = null
  })

  async function serve(
    answer: (n: number) => number
  ): Promise<{ port: number; seen: http.IncomingHttpHeaders[] }> {
    const seen: http.IncomingHttpHeaders[] = []
    server = http.createServer((req, res) => {
      seen.push(req.headers)
      res.statusCode = answer(seen.length)
      res.end('{"status":"ok"}')
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    return { port: (server.address() as AddressInfo).port, seen }
  }

  it('asks without the token, on a connection that is not kept for later requests', async () => {
    const { port, seen } = await serve(() => 200)
    expect(await probeHealth({ host: '127.0.0.1', port }, 2000)).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]['x-prism-token']).toBeUndefined()
    expect(seen[0].connection).toBe('close')
  })

  it('reports no answer as 0', async () => {
    const { port } = await serve(() => 200)
    await new Promise<void>((r) => server!.close(() => r()))
    server = null
    expect(await probeHealth({ host: '127.0.0.1', port }, 2000)).toBe(0)
  })

  it('waits until the health route answers 200, and gives up after its attempts', async () => {
    const { port, seen } = await serve((n) => (n < 3 ? 503 : 200))
    const info = { host: '127.0.0.1', port, token: 'tok-1', version: '1.0.0' }
    await waitForHealth(() => info, { attempts: 5, intervalMs: 1 })
    expect(seen).toHaveLength(3)
    expect(seen.every((h) => h['x-prism-token'] === undefined)).toBe(true)
    const backend = vi.fn(() => null)
    await expect(waitForHealth(backend, { attempts: 2, intervalMs: 1 })).rejects.toThrow(/did not turn green/)
    expect(backend).toHaveBeenCalledTimes(2)
  })
})
