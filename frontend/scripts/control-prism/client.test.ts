import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Exit, HostTimeout, send } from './client'
import type { SessionRecord } from './session'

/** A stand-in host on a real socket: it keeps each request's answer until the test gives it. */
async function fakeHost(onRequest?: (res: ServerResponse) => void): Promise<{
  server: Server
  port: number
  arrived: Promise<ServerResponse>
}> {
  let arrive!: (res: ServerResponse) => void
  const arrived = new Promise<ServerResponse>((r) => (arrive = r))
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      onRequest?.(res)
      arrive(res)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { server, port: (server.address() as AddressInfo).port, arrived }
}

const session = (port: number): SessionRecord =>
  ({ name: 'test', status: 'ready', port, token: 't' }) as unknown as SessionRecord

const answer = (res: ServerResponse, text: string): void => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, text }))
}

let servers: Server[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const s of servers) {
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }
  servers = []
})

describe('send', () => {
  it('waits for a long wait as long as its own deadline, also past five minutes', async () => {
    // The host answers a wait only when it is over. A fetch gave up on that answer after five minutes
    // whatever deadline it was handed, and the command line said the host had gone — while the host still
    // waited and the window was fine.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const host = await fakeHost()
    servers.push(host.server)
    const waiting = send(session(host.port), 'wait', ['chat-idle'], { timeout: '900000' })
    const res = await host.arrived
    await vi.advanceTimersByTimeAsync(12 * 60_000)
    answer(res, 'no run in the shown chat')
    await expect(waiting).resolves.toBe('no run in the shown chat')
  })

  it('stops waiting at its own deadline and says how to tell a busy line from a stuck host', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const host = await fakeHost()
    servers.push(host.server)
    const looking = send(session(host.port), 'snapshot', [], {})
    const seen = expect(looking).rejects.toThrow(HostTimeout)
    await host.arrived
    await vi.advanceTimersByTimeAsync(40_000)
    await seen
    await expect(looking).rejects.toThrow(
      /^no answer from the session's host within 40 s: .* doctor says which/
    )
  })

  it('tells a host that is gone from one whose connection broke off', async () => {
    const closed = await fakeHost()
    await new Promise((r) => closed.server.close(r))
    const refused = send(session(closed.port), 'snapshot', [], {})
    await expect(refused).rejects.toThrow(Exit)
    await expect(refused).rejects.toThrow(/does not answer — nothing listens on its port any more; run stop/)

    // A host that drops the connection under a command may still run: doctor first, not stop.
    const dropping = await fakeHost((res) => res.socket?.destroy())
    servers.push(dropping.server)
    const broken = send(session(dropping.port), 'wait', ['chat-idle'], {})
    await expect(broken).rejects.toThrow(/broke off \(ECONNRESET\) — doctor says whether the host/)
  })

  it('sends a session on a copy that is over to restart or stop, not to stop-then-launch', async () => {
    // "run stop, then launch" would remove the copy, and with it what was built there.
    const root = mkdtempSync(join(tmpdir(), 'cp-client-'))
    try {
      const copy = {
        name: 'run',
        mode: 'copy',
        status: 'exited',
        detail: 'stopped after 60 min without a command',
        idleKept: true,
        idleMinutes: 60,
        install: { root }
      } as unknown as SessionRecord
      const over = send(copy, 'snapshot', [], {})
      await expect(over).rejects.toThrow(Exit)
      await expect(over).rejects.toThrow(
        /is over \(the idle stop ended it .*restart starts the app on it again/
      )

      // Its host gone without a word (status still ready): the same advice.
      const closed = await fakeHost()
      await new Promise((r) => closed.server.close(r))
      const gone = { ...copy, status: 'ready', idleKept: undefined, port: closed.port, token: 't' }
      await expect(send(gone as SessionRecord, 'snapshot', [], {})).rejects.toThrow(
        /nothing listens on its port any more; session "run" is over \(it ended without stop\)/
      )

      // A fresh session holds nothing to keep: stop, then launch, as before.
      const fresh = { ...copy, mode: 'fresh' } as SessionRecord
      await expect(send(fresh, 'snapshot', [], {})).rejects.toThrow(
        /is exited \(stopped after 60 min without a command\) — run stop, then launch/
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('passes the host’s refusal through as a failed command', async () => {
    const host = await fakeHost((res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'nothing matches Run now' }))
    })
    servers.push(host.server)
    await expect(send(session(host.port), 'click', ['Run'], {})).rejects.toThrow('nothing matches Run now')
  })
})
