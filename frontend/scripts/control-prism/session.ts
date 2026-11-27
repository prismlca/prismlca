/**
 * A session: one driven app instance, owned by the checkout that launched it. Its record lives in that
 * checkout's `.cache/control-prism/sessions/<name>.json`, so an agent in another worktree never finds — and
 * never drives — someone else's instance. The record holds what the commands need to reach the host
 * process (port and token) and what `stop` needs to end the app when the host is gone (the process
 * snapshot and the install folder).
 */
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { listProcesses, type ProcessInfo } from '../../e2e/processes'
import type { Install } from '../../e2e/app'
import type { CopyReport } from './copy'

export interface SessionRecord {
  name: string
  /** The `frontend/` of the checkout that launched it. */
  frontend: string
  token: string
  /** 'starting' until the host has the window; 'ready' while it serves; 'failed'/'exited' once it is over. */
  status: 'starting' | 'ready' | 'failed' | 'exited'
  detail?: string
  port?: number
  host: ProcessInfo | null
  /** Set by the launching command once it has recorded `host`; the host writes nothing before. */
  hostRecorded: boolean
  install: Install
  /** 'fresh': empty folders of its own; 'copy': a copy of the person's data and profile (copy.ts). */
  mode: 'fresh' | 'copy'
  /** What the copy was taken from, when, and how big it is (mode 'copy'). */
  copy?: CopyReport
  seeded: boolean
  /** The providers whose stored keys launch copied in (`--keys`); null when it was not asked to. */
  keys: string[] | null
  /** The log of a sealed instance (`--sealed`, sealed.ts); null or absent (older records) when not sealed. */
  seal?: string | null
  /** The build the app was started from (fingerprints from build.json at launch or the last restart). */
  build: { src: string; out: string }
  /** The backend sources the app was started from; the backend runs them as they were at that moment. */
  backendSrc: string
  /** Where the host and the app write their logs — outside `install`, so nothing that reads them names
   *  the session's folder (stop ends what does). */
  logs: string
  /** How the backend runs: the checkout's own environment, or the main checkout's with this source first. */
  backend: { via: 'own' | 'shim'; detail: string }
  launchedAt: string
  /** The app's processes, refreshed by the host; `stop` ends these when the host cannot. */
  processes: ProcessInfo[]
  idleMinutes: number
  /** Set when the idle stop ended the session and kept its folders (a copy; host.ts); a restart that
   *  starts the app on them again clears it. */
  idleKept?: boolean
}

/**
 * Passed where the end-to-end harness takes an install folder to recognise its processes by: matches no
 * command line, so only identity and ancestry count. Someone's `tail` on a session file is not the session's.
 */
export const NO_PATH_RULE = '\u0000'

export function controlDir(frontend: string): string {
  return join(frontend, '.cache', 'control-prism')
}

export function sessionPath(frontend: string, name: string): string {
  return join(controlDir(frontend), 'sessions', `${name}.json`)
}

export function sessionName(flag: string | undefined): string {
  const name = flag ?? process.env.CONTROL_PRISM_SESSION ?? 'default'
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) {
    throw new Error(`session names are letters, digits, "-" and "_" (at most 40), not "${name}"`)
  }
  return name
}

export function newToken(): string {
  return randomBytes(24).toString('hex')
}

export function readSession(frontend: string, name: string): SessionRecord | null {
  const path = sessionPath(frontend, name)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionRecord
  } catch {
    return null
  }
}

/** Written whole and renamed into place, so a reader never sees half a record. Readable by its owner only:
 *  the token in it is the key to the instance. */
export function writeSession(record: SessionRecord): void {
  const path = sessionPath(record.frontend, record.name)
  mkdirSync(join(controlDir(record.frontend), 'sessions'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 })
  try {
    chmodSync(tmp, 0o600)
  } catch {
    /* Windows has no such mode; the file sits in the user's own checkout */
  }
  renameSync(tmp, path)
}

/**
 * Changes the record of the session whose token is `token`, and only that one: a host left over from an
 * earlier launch, or a command that read an older record, must not write over the session that replaced it.
 */
export function updateSession(
  frontend: string,
  name: string,
  token: string,
  patch: Partial<SessionRecord>
): SessionRecord | null {
  const current = readSession(frontend, name)
  if (!current || current.token !== token) return null
  const next = { ...current, ...patch }
  writeSession(next)
  return next
}

/**
 * What to say about a session on a copy that is over without a stop — the idle stop ended it, the app
 * closed, the host died — while its folders are still there: they hold what was built in them, models
 * nobody has decided about yet among it, so only an explicit stop removes them. Null for a fresh session,
 * and for a copy whose folder is gone. Whether the session is over is the caller's to know.
 */
export function keptCopyNotice(record: SessionRecord): string | null {
  if (record.mode !== 'copy' || !existsSync(record.install.root)) return null
  const how = record.idleKept
    ? `the idle stop ended it after ${record.idleMinutes} min without a command`
    : 'it ended without stop'
  return (
    `session "${record.name}" is over (${how}), and its copy of your data is still in ` +
    `${record.install.root}, with what was built in it. restart starts the app on it again (without ` +
    'stored keys); stop removes the copy; stop --keep forgets the session and leaves the folder'
  )
}

/** Removes the record, if it is still the one with `token`. */
export function removeSession(frontend: string, name: string, token: string): void {
  if (readSession(frontend, name)?.token === token) rmSync(sessionPath(frontend, name), { force: true })
}

/**
 * Holds the session for one command that starts, restarts or stops it, so two such commands cannot both
 * act on it. The lock file names its holder's pid and appears whole: it is written beside and linked into
 * place, and a link fails when the name exists. It counts as held while a control-prism process with that
 * pid runs that started no later than the lock was written — a pid handed on since cannot keep it.
 *
 * A lock without such a holder is taken over by moving it aside first: of two commands that judged it
 * stale, only one moves it, and one that moved a fresh lock instead (written between its look and its
 * move) puts it back and gives way.
 */
export function lockSession(frontend: string, name: string): () => void {
  const dir = join(controlDir(frontend), 'sessions')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.lock`)
  const mine = String(process.pid)
  const draft = join(dir, `${name}.lock.${process.pid}`)
  writeFileSync(draft, mine)
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(draft, path)
        return () => {
          // Only our own: a lock that is someone else's by now stays.
          if (readText(path) === mine) rmSync(path, { force: true })
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      const seen = readText(path)
      const holder = seen === null ? null : lockHolder(path, seen)
      if (holder) {
        throw new Error(
          `another control-prism command (pid ${holder.pid}) is starting, restarting or stopping session ` +
            `"${name}" — wait for it to finish`
        )
      }
      const aside = join(dir, `${name}.lock.stale.${process.pid}`)
      try {
        renameSync(path, aside)
      } catch {
        continue // someone else moved it first
      }
      if (readText(aside) !== seen) {
        // A fresh lock was written between the look and the move: it goes back, and we give way.
        try {
          linkSync(aside, path)
        } finally {
          rmSync(aside, { force: true })
        }
        throw new Error(
          `another control-prism command took session "${name}" just now — wait for it to finish`
        )
      }
      rmSync(aside, { force: true })
    }
    throw new Error(`could not take the lock of session "${name}" (${path})`)
  } finally {
    rmSync(draft, { force: true })
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function lockHolder(path: string, content: string): ProcessInfo | null {
  const pid = Number(content)
  let written: number
  try {
    written = statSync(path).mtimeMs
  } catch {
    return null
  }
  // Start times are whole seconds on Linux and macOS: one second of slack.
  const p = listProcesses().find((x) => x.pid === pid)
  const started = p?.started == null ? null : p.started / 1000
  return p && started !== null && started <= written + 1000 && /control-prism/.test(p.command) ? p : null
}
