/**
 * The endpoint file: how a local process finds the running MCP server. Written when the server
 * starts, removed when it stops, owner-only (0600 where the platform has file modes).
 *
 * The backend's port and token never touch the disk (they ride the stdout handshake) — this file is
 * the one deliberate exception, because an external client cannot inherit a pipe. It holds the MCP
 * token, not the backend's; the MCP server authenticates its own callers and talks to the backend
 * on their behalf. Windows has no owner/group/other modes; there the file sits in the user's
 * %APPDATA%, and restrictToOwnerOnWindows below narrows the file's ACL to the user.
 *
 * The bridge uses the file only after the server behind it proves it holds the file's token.
 */
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { join, win32 } from 'node:path'

export const ENDPOINT_FILE = 'mcp-endpoint.json'

export interface EndpointInfo {
  url: string
  token: string
  pid: number
  version: string
  startedAt: string
}

export const endpointPath = (userData: string): string => join(userData, ENDPOINT_FILE)

export function writeEndpoint(userData: string, info: EndpointInfo): void {
  const f = endpointPath(userData)
  const tmp = `${f}.tmp`
  // tmp + rename like settings.json: a reader must never catch half a file — and the mode is set
  // on the temp file BEFORE it holds the token, so there is no instant where it is world-readable.
  writeFileSync(tmp, '', { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* Windows: chmod is a no-op there; the directory is the user's own */
  }
  writeFileSync(tmp, JSON.stringify(info, null, 1), { mode: 0o600 })
  renameSync(tmp, f)
  restrictToOwnerOnWindows(f)
}

/**
 * Windows has no owner/group/other modes: `chmod` is a no-op there, and %APPDATA% is readable by
 * every process of the same user anyway — the same trust boundary as on Linux. Best effort on top:
 * drop inherited ACEs and grant the current user alone, so an administrator-wide share of the
 * profile folder does not carry the token. Untested here (no Windows at hand); failures are ignored
 * because the file is already written and the app must not fail its start over an ACL.
 */
function restrictToOwnerOnWindows(path: string): void {
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME
  if (!user) return
  try {
    spawnSync(icaclsPath(process.env), [path, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'ignore',
      timeout: 5000
    })
  } catch {
    /* see above */
  }
}

/** The system's icacls by its full path, never looked up through the working directory or PATH. */
export function icaclsPath(env: Record<string, string | undefined>): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR
  const dir = root && /^[A-Za-z]:[\\/]/.test(root) ? root : 'C:\\Windows'
  return win32.join(dir, 'System32', 'icacls.exe')
}

export function readEndpoint(userData: string): EndpointInfo | null {
  try {
    const p = JSON.parse(readFileSync(endpointPath(userData), 'utf-8')) as Partial<EndpointInfo> | null
    if (!p || typeof p.token !== 'string' || typeof p.version !== 'string') return null
    // The server only ever listens on loopback; a file naming anything else is not its.
    if (typeof p.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/.test(p.url)) return null
    if (typeof p.pid !== 'number' || !Number.isInteger(p.pid) || p.pid <= 0) return null
    return p as EndpointInfo
  } catch {
    return null
  }
}

export function removeEndpoint(userData: string): void {
  const f = endpointPath(userData)
  if (existsSync(f)) rmSync(f, { force: true })
}

// --- Is the server behind the file the one that wrote it? ----------------------------------------

/** The route that answers the proof; it needs no token, because its answer reveals none. */
export const PROOF_PATH = '/health/proof'
/** What a nonce may look like: base64url, long enough to never repeat. */
export const PROOF_NONCE = /^[A-Za-z0-9_-]{22,128}$/

/** The server's answer to a nonce: an HMAC under the token, bound to this one purpose. */
export function endpointProof(token: string, nonce: string): string {
  return createHmac('sha256', token).update(`prism-mcp-endpoint-proof\n${nonce}`).digest('base64url')
}

/**
 * Is the process that wrote the file still there? On Windows EPERM still means alive (an elevated
 * instance refuses the probe); elsewhere it is another account's process, and a PrismLCA that wrote
 * this user's endpoint file runs as this user.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return process.platform === 'win32' && (e as { code?: string }).code === 'EPERM'
  }
}

/** The longest proof answer worth reading; a real one is under a hundred bytes. */
const MAX_PROOF_BYTES = 4096

/** Does the listener behind the file prove it holds the file's token? Asked with a fresh nonce, never the token. */
export async function proveEndpoint(info: EndpointInfo, timeoutMs = 2000): Promise<boolean> {
  const base = info.url.replace(/\/mcp$/, '')
  const nonce = randomBytes(24).toString('base64url')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(`${base}${PROOF_PATH}?nonce=${nonce}`, { signal: ctrl.signal, redirect: 'error' })
    if (!r.ok) return false
    const text = await readCapped(r, MAX_PROOF_BYTES)
    if (text === null) return false
    const body = JSON.parse(text) as { proof?: unknown } | null
    const got = Buffer.from(typeof body?.proof === 'string' ? body.proof : '')
    const want = Buffer.from(endpointProof(info.token, nonce))
    return got.length === want.length && timingSafeEqual(got, want)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(r: Response, max: number): Promise<string | null> {
  const reader = r.body?.getReader()
  if (!reader) return ''
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => undefined)
      return null
    }
    parts.push(value)
  }
  return Buffer.concat(parts).toString('utf8')
}
