/**
 * The command line's side of a session: finding this checkout's record and asking its host, within a
 * deadline. The host gives up on a command past its own bound plus a margin (watchdog.ts); the caller waits
 * a little longer still, so it hears that answer — and gets one anyway when the host itself does not
 * answer: a stuck driver must not freeze the shell that drives it.
 */
import { request } from 'node:http'
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
  const body = JSON.stringify({ cmd, args, flags, expires: Date.now() + ms })
  let answer: string
  try {
    answer = await post(record.port, record.token, body, ms)
  } catch (e) {
    if (e instanceof DeadlinePassed) {
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
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ECONNREFUSED') {
      throw new Exit(
        3,
        `the host of session "${record.name}" does not answer — nothing listens on its port any more; ` +
          'run stop (it cleans up), then launch'
      )
    }
    // The host was there and the connection broke off under the command: it may have died with it, or may
    // still run. stop would end a session that still works, so doctor comes first.
    throw new Exit(
      3,
      `the connection to the host of session "${record.name}" broke off (${code ?? (e as Error).message}) — ` +
        'doctor says whether the host and the window still answer; if not, stop cleans up, then launch'
    )
  }
  const reply = JSON.parse(answer) as Reply
  if (reply.note) process.stderr.write(`note: ${reply.note}\n`)
  if (!reply.ok) throw new Exit(1, reply.error)
  return reply.text
}

/** The caller's own deadline passed before the host answered. */
class DeadlinePassed extends Error {}

/**
 * One request to the host, bounded by `ms` and by nothing else. Not `fetch`: Node's fetch gives up on any
 * answer whose headers take longer than five minutes, whatever signal it is handed, and the host answers a
 * command only when it has finished — so every wait or read past five minutes failed as if the host had
 * gone, while the host still ran the command and the window was fine.
 */
function post(port: number, token: string, body: string, ms: number): Promise<string> {
  return new Promise<string>((resolveOnce, rejectOnce) => {
    const resolve = (text: string): void => {
      clearTimeout(timer)
      resolveOnce(text)
    }
    const reject = (e: Error): void => {
      clearTimeout(timer)
      rejectOnce(e)
    }
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
        // A connection of its own: a command line sends one request and ends, so a pooled socket buys
        // nothing, and one the host closed while idle could take a request it never sees.
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-control-prism-token': token
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', reject)
        // Closed before it was whole: the host went away in the middle of its answer. A settled promise
        // ignores this when the answer was complete.
        res.on('close', () => {
          if (!res.complete)
            reject(Object.assign(new Error('the answer was cut off'), { code: 'ECONNRESET' }))
        })
      }
    )
    const timer = setTimeout(() => req.destroy(new DeadlinePassed()), ms)
    req.on('error', reject)
    req.end(body)
  })
}
