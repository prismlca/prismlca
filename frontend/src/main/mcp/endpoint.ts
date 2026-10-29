/**
 * The endpoint file: how a local process finds the running MCP server. Written when the server
 * starts, removed when it stops, owner-only (0600 where the platform has file modes).
 *
 * The backend's port and token never touch the disk (they ride the stdout handshake) — this file is
 * the one deliberate exception, because an external client cannot inherit a pipe. It holds the MCP
 * token, not the backend's; the MCP server authenticates its own callers and talks to the backend
 * on their behalf. Windows has no owner/group/other modes; there the file sits in the user's
 * %APPDATA%, and restrictToOwnerOnWindows below narrows the file's ACL to the user.
 */
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

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
    spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', timeout: 5000 })
  } catch {
    /* see above */
  }
}

export function readEndpoint(userData: string): EndpointInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(endpointPath(userData), 'utf-8')) as EndpointInfo
    return parsed && typeof parsed.url === 'string' && typeof parsed.token === 'string' ? parsed : null
  } catch {
    return null
  }
}

export function removeEndpoint(userData: string): void {
  const f = endpointPath(userData)
  if (existsSync(f)) rmSync(f, { force: true })
}
