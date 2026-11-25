/**
 * The network half of a sealed instance, for the main process's two network stacks and for the programs it
 * starts. Loopback stays open throughout: the backend, the MCP endpoint and the driver all live there.
 *
 * - Node (`fetch`, `http`, `https`, `tls`: news, AI providers, routing, statistics): every TCP connection
 *   passes through `net.Socket.prototype.connect`, which refuses a remote host before its name is looked up.
 * - Chromium (windows, `net`, the update check in its own session): each session cancels requests to a
 *   remote host, and the host resolver answers every remote name with "not found" — so nothing Chromium does
 *   on its own (a prefetch, a preconnect) asks the system's DNS either.
 * - Child processes (the backend and its workers, `uv`): their proxy variables lead to a loopback trap that
 *   writes down and refuses what honours them. The backend refuses the rest of its own (prism_lca/seal.py).
 */
import { createServer, type Socket } from 'node:net'
import type { App, Session } from 'electron'
import { isLoopback, leavesComputer, type SealLog } from './log'

/** Where a `connect` call goes: a host and port, or a local path (a Unix socket or pipe). */
export function destination(args: unknown[]): { text: string; local: boolean } | null {
  // net.connect() hands its arguments on normalised, as [options, callback].
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0]
  if (first && typeof first === 'object') {
    const o = first as { path?: unknown; host?: unknown; port?: unknown }
    if (typeof o.path === 'string' && o.path !== '') return { text: o.path, local: true }
    const host = typeof o.host === 'string' && o.host !== '' ? o.host : 'localhost'
    return { text: `${host}:${String(o.port)}`, local: isLoopback(host) }
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    const host = typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost'
    return { text: `${host}:${String(first)}`, local: isLoopback(host) }
  }
  if (typeof first === 'string') return { text: first, local: true }
  return null
}

/** Refuses connections to remote hosts on sockets of `proto` (net.Socket.prototype in the app). Returns
 *  the undo, for tests. */
export function guardSockets(proto: Socket, log: SealLog): () => void {
  const original = proto.connect
  proto.connect = function (this: Socket, ...args: unknown[]) {
    const dest = destination(args)
    if (dest === null || dest.local) return (original as (...a: unknown[]) => Socket).apply(this, args)
    log.write('network', dest.text, 'node')
    const refusal = Object.assign(
      new Error(`connect ECONNREFUSED ${dest.text}: refused by the sealed instance`),
      { code: 'ECONNREFUSED', sealed: true }
    )
    // Later, as a refused connection would be: the caller attaches its error handler after connect returns.
    process.nextTick(() => this.destroy(refusal))
    return this
  } as Socket['connect']
  return () => {
    proto.connect = original
  }
}

/** Chromium's host resolver: every name and address "not found", except this computer's. */
export const HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1'

/** Cancels requests to remote hosts in every session, the default one and those made later. */
export function guardSessions(app: App, defaultSession: () => Session, log: SealLog): void {
  const guarded = new WeakSet<Session>()
  const guard = (ses: Session): void => {
    if (guarded.has(ses)) return
    guarded.add(ses)
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (!leavesComputer(details.url)) return callback({})
      log.write('network', details.url, 'chromium')
      callback({ cancel: true })
    })
  }
  app.on('session-created', guard)
  void app.whenReady().then(() => guard(defaultSession()))
}

/** The request line's destination: `host:port` of a CONNECT, the URL of a plain proxied request. */
export function proxyTarget(requestLine: string): string {
  const [method = '', target = ''] = requestLine.split(' ')
  return method.toUpperCase() === 'CONNECT' ? target : `${method} ${target}`.trim()
}

/** The proxy variables of the programs a sealed main process starts: everything through the trap, except
 *  this computer. */
export function trapEnv(trapUrl: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    env[name] = trapUrl
    env[name.toLowerCase()] = trapUrl
  }
  env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1'
  return env
}

/**
 * A loopback proxy that answers every request with 403 and writes its destination down. Programs that
 * honour the proxy variables (Python's HTTP libraries, Rust download clients, uv) are refused there without
 * a name lookup of their own. Resolves to its URL once it listens.
 */
export function startProxyTrap(log: SealLog): Promise<string> {
  const server = createServer((sock) => {
    let head = ''
    sock.setTimeout(5000, () => sock.destroy())
    sock.on('error', () => undefined)
    sock.on('data', (chunk: Buffer) => {
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n')
      if (end < 0 && head.length < 8192) return
      sock.removeAllListeners('data')
      log.write('network', proxyTarget(head.slice(0, end < 0 ? 200 : end)), 'proxy')
      sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    })
  })
  server.unref()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) resolve(`http://127.0.0.1:${address.port}`)
      else reject(new Error('the proxy trap has no address'))
    })
  })
}
