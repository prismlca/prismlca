/**
 * The network half of the seal: which addresses count as this computer, Node's sockets refusing the rest
 * before a name is looked up (through `fetch` as the app uses it), Chromium's sessions cancelling the same,
 * and the proxy trap the child processes are sent to.
 *
 * The socket guard is put on Node's own Socket.prototype for the tests that go through `fetch`, and taken off
 * again in the same test: the test files of a worker share it. The remote addresses are documentation
 * addresses and .invalid names, so a guard that failed reaches nobody.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { connect, Socket, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { App, Session } from 'electron'
import { isLoopback, leavesComputer, openSealLog, type SealEntry } from './log'
import { destination, guardSessions, guardSockets, proxyTarget, startProxyTrap, trapEnv } from './network'

function freshLog(): { log: ReturnType<typeof openSealLog>; entries: () => SealEntry[] } {
  const path = join(mkdtempSync(join(tmpdir(), 'prism-seal-')), 'sealed.jsonl')
  const entries = (): SealEntry[] => {
    try {
      return readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as SealEntry)
    } catch {
      return []
    }
  }
  return { log: openSealLog(path), entries }
}

let undo: (() => void) | null = null
let server: Server | null = null
afterEach(async () => {
  undo?.()
  undo = null
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()))
  server = null
  vi.restoreAllMocks()
})

describe('what counts as this computer', () => {
  it.each([
    ['localhost', true],
    ['LocalHost.', true],
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['::1', true],
    ['[::1]', true],
    ['0:0:0:0:0:0:0:1', true],
    ['::ffff:127.0.0.1', true],
    ['0.0.0.0', true],
    ['', true],
    ['prismlca.com', false],
    ['localhost.prismlca.com', false],
    ['192.0.2.1', false],
    ['::ffff:192.0.2.1', false],
    ['2001:db8::1', false]
  ])('%s → %s', (host, local) => {
    expect(isLoopback(host)).toBe(local)
  })

  it.each([
    ['https://www.prismlca.com/feed.xml', true],
    ['wss://example.invalid/socket', true],
    ['http://192.0.2.1/', true],
    ['http://localhost:5173/', false],
    ['http://127.0.0.1:8765/api/v1/health', false],
    ['http://[::1]:8765/', false],
    ['file:///home/x/out/renderer/index.html', false],
    ['devtools://devtools/bundled/inspector.html', false],
    ['data:text/html,hi', false],
    ['not a url', false]
  ])('a request to %s leaves the computer: %s', (url, out) => {
    expect(leavesComputer(url)).toBe(out)
  })
})

describe('destination', () => {
  it('reads every form net and its callers pass to connect', () => {
    expect(destination([{ host: 'prismlca.com', port: 443 }])).toEqual({
      text: 'prismlca.com:443',
      local: false
    })
    expect(destination([[{ host: '192.0.2.1', port: 80 }, () => undefined]])).toEqual({
      text: '192.0.2.1:80',
      local: false
    })
    expect(destination([{ port: 8765 }])).toEqual({ text: 'localhost:8765', local: true })
    expect(destination([443, 'example.invalid'])).toEqual({ text: 'example.invalid:443', local: false })
    expect(destination(['8765'])).toEqual({ text: 'localhost:8765', local: true })
    expect(destination([{ path: '/run/user/1000/prism.sock' }])).toEqual({
      text: '/run/user/1000/prism.sock',
      local: true
    })
    expect(destination(['/tmp/x.sock'])).toEqual({ text: '/tmp/x.sock', local: true })
    expect(destination([])).toBeNull()
  })
})

describe('guardSockets', () => {
  it('refuses a remote host before looking its name up, and writes it down', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { log, entries } = freshLog()
    class Guarded extends Socket {}
    guardSockets(Guarded.prototype, log)
    const sock = new Guarded()
    const lookup = vi.fn()
    const error = await new Promise<NodeJS.ErrnoException & { sealed?: boolean }>((done) => {
      sock.on('error', done)
      sock.connect({ host: 'news.example.invalid', port: 443, lookup })
    })
    expect(error.code).toBe('ECONNREFUSED')
    expect(error.sealed).toBe(true)
    expect(lookup).not.toHaveBeenCalled()
    expect(entries()).toEqual([
      expect.objectContaining({ kind: 'network', target: 'news.example.invalid:443', via: 'node' })
    ])
  })

  it('refuses fetch to the web and leaves a local server reachable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { log, entries } = freshLog()
    server = createHttpServer((_req, res) => res.end('local'))
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done))
    const port = (server.address() as AddressInfo).port
    undo = guardSockets(Socket.prototype, log)

    await expect(fetch(`http://127.0.0.1:${port}/`).then((r) => r.text())).resolves.toBe('local')
    await expect(fetch(`http://localhost:${port}/`).then((r) => r.text())).resolves.toBe('local')
    const failure = await fetch('https://feed.example.invalid/feed.xml').catch((e: Error) => e)
    expect((failure as Error & { cause?: { sealed?: boolean } }).cause?.sealed).toBe(true)
    expect(entries().map((e) => e.target)).toEqual(['feed.example.invalid:443'])
  })
})

describe('guardSessions', () => {
  function fakeSession(): { ses: Session; send: (url: string) => { cancel?: boolean } } {
    let handler: ((d: { url: string }, cb: (r: { cancel?: boolean }) => void) => void) | null = null
    const ses = {
      webRequest: { onBeforeRequest: (fn: typeof handler) => (handler = fn) }
    } as unknown as Session
    return {
      ses,
      send: (url) => {
        let answer: { cancel?: boolean } = {}
        handler!({ url }, (r) => (answer = r))
        return answer
      }
    }
  }

  it('cancels remote requests in the default session and in every session made later', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { log, entries } = freshLog()
    const app = Object.assign(new EventEmitter(), { whenReady: () => Promise.resolve() })
    const main = fakeSession()
    guardSessions(app as unknown as App, () => main.ses, log)
    await Promise.resolve()
    const updater = fakeSession()
    app.emit('session-created', updater.ses)

    expect(main.send('https://www.prismlca.com/feed.xml')).toEqual({ cancel: true })
    expect(main.send('file:///app/out/renderer/index.html')).toEqual({})
    expect(updater.send('https://github.com/prismlca/prismlca/releases/latest/download/latest.yml')).toEqual({
      cancel: true
    })
    expect(updater.send('http://127.0.0.1:9/')).toEqual({})
    expect(entries().map((e) => [e.target, e.via])).toEqual([
      ['https://www.prismlca.com/feed.xml', 'chromium'],
      ['https://github.com/prismlca/prismlca/releases/latest/download/latest.yml', 'chromium']
    ])
  })
})

describe('the proxy trap', () => {
  it('answers 403 to what honours the proxy variables and writes its destination down', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { log, entries } = freshLog()
    const url = await startProxyTrap(log)
    const port = Number(new URL(url).port)
    const ask = (line: string): Promise<string> =>
      new Promise((done, fail) => {
        let answer = ''
        const sock = connect(port, '127.0.0.1', () => sock.write(`${line}\r\nHost: x\r\n\r\n`))
        sock.on('data', (b) => (answer += b.toString()))
        sock.on('end', () => done(answer))
        sock.on('error', fail)
      })
    expect(await ask('CONNECT huggingface.co:443 HTTP/1.1')).toMatch(/^HTTP\/1\.1 403/)
    expect(await ask('GET http://pypi.example.invalid/simple/ HTTP/1.1')).toMatch(/^HTTP\/1\.1 403/)
    expect(entries().map((e) => [e.target, e.via])).toEqual([
      ['huggingface.co:443', 'proxy'],
      ['GET http://pypi.example.invalid/simple/', 'proxy']
    ])
  })

  it('reads the destination of a request line', () => {
    expect(proxyTarget('CONNECT github.com:443 HTTP/1.1')).toBe('github.com:443')
    expect(proxyTarget('get http://x.invalid/ HTTP/1.0')).toBe('get http://x.invalid/')
    expect(proxyTarget('')).toBe('')
  })

  it('sends every scheme through the trap, both spellings, and this computer past it', () => {
    const env = trapEnv('http://127.0.0.1:4100')
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'])
      expect(env[name]).toBe('http://127.0.0.1:4100')
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })
})
