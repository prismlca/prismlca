/**
 * The command line's side of a session: finding this checkout's record and asking its host, within a
 * deadline. The host gives up on a command past its own bound plus a margin (watchdog.ts); the caller waits
 * a little longer still, so it hears that answer — and gets one anyway when the host itself does not
 * answer: a stuck driver must not freeze the shell that drives it.
 */
import { FRONTEND } from '../../e2e/app'
import type { Parsed } from './args'
import type { Reply } from './host'
import { readSession, type SessionRecord } from './session'
import { callerDeadline } from './watchdog'

/** An error with the exit code the command line ends with: 1 failed, 2 wrong usage, 3 no session. */
export class Exit extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}

/** The host gave no answer within the caller's deadline. */
export class HostTimeout extends Exit {
  constructor(
    readonly seconds: number,
    message: string
  ) {
    super(1, message)
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
  const ms = callerDeadline(cmd, flags)
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
      // The host gives up on every command before this, so the command waited in line behind another one
      // (a long wait from another shell), or the host itself is stuck. Which one, doctor says.
      throw new HostTimeout(
        ms / 1000,
        `no answer from the session's host within ${ms / 1000} s: the command waited in line behind ` +
          'another one, or the host itself is stuck. doctor says which, and whether the window answers. ' +
          'A command still waiting its turn is dropped; one that had begun may still complete, so look ' +
          '(snapshot, shot) before repeating it. stop ends the session (and everything it started) also ' +
          'when its host does not answer.'
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
