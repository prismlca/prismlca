/**
 * What a sealed instance refused, written down: one JSON object per line in the file PRISM_SEALED names.
 * The main process and the backend (backend `prism_lca/seal.py`) write to the same file in the same form, so
 * one file says everything the instance tried. Also here: which addresses count as this computer.
 */
import { appendFileSync } from 'node:fs'
import { isIP } from 'node:net'

/** `sealed`: a process has its seal in place. The rest name what was refused. */
export type SealKind = 'sealed' | 'link' | 'open' | 'reveal' | 'dialog' | 'network'
export type SealOutcome = 'in place' | 'refused' | 'cancelled' | 'failed'

export interface SealEntry {
  at: string
  proc: string
  pid: number
  kind: SealKind
  /** The URL, path, host:port or dialog — cut to TARGET_CHARS. */
  target: string
  /** The call it was refused at, e.g. `shell.openExternal`, `node`, `chromium`, `proxy`. */
  via: string
  outcome: SealOutcome
}

export interface SealLog {
  readonly path: string
  write(kind: SealKind, target: string, via: string, outcome?: SealOutcome): void
}

const TARGET_CHARS = 500

export function openSealLog(path: string, proc = 'main', pid = process.pid): SealLog {
  return {
    path,
    write(kind, target, via, outcome = 'refused') {
      const entry: SealEntry = {
        at: new Date().toISOString(),
        proc,
        pid,
        kind,
        target: target.length > TARGET_CHARS ? `${target.slice(0, TARGET_CHARS)}…` : target,
        via,
        outcome
      }
      // One write per line, appended: the backend appends to the same file.
      try {
        appendFileSync(path, `${JSON.stringify(entry)}\n`)
      } catch (e) {
        console.error(`[sealed] could not write ${path}:`, e)
      }
      console.warn(`[sealed] ${outcome}: ${kind} ${entry.target} (${via})`)
    }
  }
}

/** Whether `host` is this computer: `localhost`, 127.0.0.0/8, ::1 (also IPv4-mapped), or unspecified. */
export function isLoopback(host: string): boolean {
  const name = host
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
  if (name === '' || name === 'localhost') return true
  const version = isIP(name)
  if (version === 4) return name.startsWith('127.') || name === '0.0.0.0'
  if (version === 6) {
    // The URL parser writes an address in its shortest form: ::1, ::, ::ffff:7f00:1 for 127.0.0.1.
    const short = new URL(`http://[${name}]`).hostname.slice(1, -1)
    return short === '::1' || short === '::' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(short)
  }
  return false
}

/** Whether a request to `url` leaves the computer: a web or socket URL whose host is not this computer. */
export function leavesComputer(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return false
  return !isLoopback(parsed.hostname)
}
