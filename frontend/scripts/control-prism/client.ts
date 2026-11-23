/**
 * The command line's side of a session: finding this checkout's record and asking its host, within a
 * deadline. A command that would wait longer than its own bound plus a margin gets an answer anyway — a
 * window that froze must not freeze the shell that drives it.
 */
import { FRONTEND } from '../../e2e/app'
import type { Parsed } from './args'
import type { Reply } from './host'
import { readSession, type SessionRecord } from './session'
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from './waits'

/** An error with the exit code the command line ends with: 1 failed, 2 wrong usage, 3 no session. */
export class Exit extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

export function out(line: string): void {
  process.stdout.write(line.endsWith('\n') ? line : line + '\n')
}

export function requireSession(name: string): SessionRecord {
  const record = readSession(FRONTEND, name)
  if (!record) throw new Exit(3, `no session "${name}" in this checkout — launch one first`)
  return record
}

const MARGIN_MS = 30_000

/** How long the host may take to answer `cmd`: its own bound where it has one, plus a margin. */
export function deadline(cmd: string, flags: Parsed['flags']): number {
  const asked = typeof flags.timeout === 'string' ? Number(flags.timeout) : NaN
  const own = Number.isFinite(asked) ? Math.min(asked, MAX_WAIT_MS) : undefined
  switch (cmd) {
    case 'wait':
      return (own ?? DEFAULT_WAIT_MS) + MARGIN_MS
    case 'click':
    case 'hover':
    case 'type':
    case 'press':
    case 'select':
    case 'drag':
    case 'snapshot':
      return (own ?? 10_000) + MARGIN_MS
    case 'restart':
      return 6 * 60_000
    case 'stop':
      return 3 * 60_000
    default:
      return 60_000
  }
}

export async function send(
  record: SessionRecord,
  cmd: string,
  args: string[],
  flags: Parsed['flags']
): Promise<string> {
  if (record.status !== 'ready' || !record.port) {
    throw new Exit(
      3,
      `session "${record.name}" is ${record.status}${record.detail ? ` (${record.detail})` : ''} — run stop, then launch`
    )
  }
  const ms = deadline(cmd, flags)
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${record.port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-control-prism-token': record.token },
      body: JSON.stringify({ cmd, args, flags, expires: Date.now() + ms }),
      signal: AbortSignal.timeout(ms)
    })
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') {
      throw new Exit(
        1,
        `no answer from the app within ${ms / 1000} s — the window may be frozen. If the command had begun, ` +
          'it may still complete: look (snapshot, shot) before repeating it. A command still waiting its ' +
          'turn is dropped. stop ends the session (and everything it started) also when it does not answer.'
      )
    }
    throw new Exit(
      3,
      `the host of session "${record.name}" does not answer — run stop (it cleans up), then launch`
    )
  }
  const reply = (await res.json()) as Reply
  if (reply.note) process.stderr.write(`note: ${reply.note}\n`)
  if (!reply.ok) throw new Exit(1, reply.error)
  return reply.text
}
