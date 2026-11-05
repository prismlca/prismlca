import http from 'http'
import { isIP } from 'net'

/**
 * Starting the backend: the JSON events it prints on stdout until it serves, and the readiness probe
 * that follows them. The child process itself is spawned in index.ts.
 */

export interface BackendInfo {
  host: string
  port: number
  token: string
  version: string
}

export interface StartupEvents {
  ready(info: BackendInfo): void
  refused(reason: string): void
  /** Long work before the handshake; `detail` may be empty. */
  progress(detail: string): void
}

/** Whether `host` names this computer only: `localhost` or a loopback address. */
export function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true
  return isIP(host) === 4 && host.startsWith('127.')
}

/** The handshake's connection details, or the sentence saying why they cannot be used. */
export function readHandshake(msg: Record<string, unknown>): BackendInfo | string {
  const { host, port, token, version } = msg
  if (typeof host !== 'string' || !isLoopbackHost(host))
    return `The backend announced the address ${String(host)}, which is not on this computer.`
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    return `The backend announced an invalid port (${String(port)}).`
  if (typeof token !== 'string' || !token) return 'The backend announced no access token.'
  return { host, port, token, version: String(version ?? '') }
}

/**
 * A reader for the backend's stdout, fed chunk by chunk. The first handshake or refusal ends the start-up
 * channel: every line after it is output, not a message to this process.
 */
export function startupReader(on: StartupEvents): (chunk: string) => void {
  let buffer = ''
  let closed = false
  const close = (): void => {
    closed = true
    buffer = ''
  }
  return (chunk) => {
    if (closed) return
    buffer += chunk
    let nl: number
    while (!closed && (nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg: unknown
      try {
        msg = JSON.parse(line)
      } catch {
        continue // ordinary (non-JSON) log line
      }
      if (!msg || typeof msg !== 'object') continue
      const fields = msg as Record<string, unknown>
      if (fields.event === 'prism-backend-ready') {
        close()
        const info = readHandshake(fields)
        if (typeof info === 'string') on.refused(info)
        else on.ready(info)
      } else if (fields.event === 'prism-backend-refused') {
        // A refusal is an answer, and a fast one. Without it the shell sat out the full 60 s and
        // reported "did not report readiness" — true, and no help at all to somebody whose only
        // problem is a second copy of PrismLCA they forgot they had open.
        close()
        on.refused(String(fields.reason || 'The backend refused to start.'))
      } else if (fields.event === 'prism-backend-progress') {
        // Long work before the handshake (copying workspaces out of a shared Brightway directory)
        // reports as it goes; each report buys another silence window instead of a fixed limit that
        // a large workspace on a slow disk would exceed.
        on.progress(fields.detail ? String(fields.detail) : '')
      }
    }
  }
}

const HEALTH_PATH = '/api/v1/system/health'

/** One readiness probe: the status of GET /system/health, 0 when there was no answer. The route is
 *  public, so the probe carries no token, and it uses a connection of its own that is not pooled. */
export function probeHealth(at: { host: string; port: number }, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: at.host, port: at.port, path: HEALTH_PATH, method: 'GET', agent: false },
      (res) => {
        res.on('error', () => resolve(0))
        res.on('end', () => resolve(res.statusCode ?? 0))
        res.resume()
      }
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Health probe timed out.')))
    req.on('error', () => resolve(0))
    req.end()
  })
}

/** Poll until the backend answers its health route with 200. */
export async function waitForHealth(
  backend: () => BackendInfo | null,
  { attempts = 60, intervalMs = 500, timeoutMs = 5_000 } = {}
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const info = backend()
    if (info && (await probeHealth(info, timeoutMs)) === 200) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('Backend health check did not turn green.')
}
