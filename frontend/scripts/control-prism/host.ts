/**
 * The host: a background process that holds one driven app for as long as the session lasts. Each command
 * of the command line is a short process; the host is what keeps Playwright's hold on the app between
 * them, collects the window's console from the first second, and ends the app the way a person does.
 *
 * It listens on 127.0.0.1 only and answers only requests carrying the session's token. It ends itself
 * when the app goes away, and quits the app after a stretch without commands, so a forgotten session does
 * not run on.
 */
import { createWriteStream } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { launch, quit, removeInstall, type RunningApp } from '../../e2e/app'
import { processTree, sameProcess, type ProcessInfo } from '../../e2e/processes'
import {
  click,
  explainFailure,
  hover,
  plainError,
  press,
  read,
  select,
  shot,
  snapshot,
  type,
  type Flags
} from './actions'
import { realDirs } from './doctor'
import { gatherAppFacts } from './facts'
import { forgetKeys } from './keys'
import { seed } from './seed'
import { NO_PATH_RULE, readSession, updateSession, type SessionRecord } from './session'
import { runWait, withDeadline } from './waits'

export interface Request {
  cmd: string
  args: string[]
  flags: Flags
  /** When the caller stops waiting (ms since 1970); a request still queued then is dropped, not run. */
  expires?: number
}
export type Reply = { ok: true; text: string } | { ok: false; error: string }

interface ConsoleEntry {
  n: number
  type: string
  text: string
  at: string
}

export async function runHost(frontend: string, name: string): Promise<void> {
  // The launching command records this process's identity right after starting it; until then the record
  // is its to write, so the host waits — a write of its own could be overwritten by that update.
  let record = readSession(frontend, name)
  if (!record) throw new Error(`no session record "${name}" in ${frontend}`)
  const token = record.token
  for (const until = Date.now() + 30_000; !record.hostRecorded && Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 100))
    const now = readSession(frontend, name)
    if (!now || now.token !== token) return // replaced by another launch: not ours to run
    record = now
  }
  // Every write goes to this session's record only: a later launch under the same name has another token.
  const update = (patch: Partial<SessionRecord>): void => {
    updateSession(frontend, name, record.token, patch)
  }
  const log = createWriteStream(join(record.logs, 'host.log'), { flags: 'a' })
  const say = (line: string): void => {
    log.write(`${new Date().toISOString()} ${line}\n`)
  }
  const fail = (detail: string): never => {
    say(`failed: ${detail}`)
    update({ status: 'failed', detail })
    process.exit(1)
  }

  const appLog = createWriteStream(join(record.logs, 'app.log'), { flags: 'a' })
  const consoleLog: ConsoleEntry[] = []
  const note = (type: string, text: string): void => {
    consoleLog.push({ n: consoleLog.length + 1, type, text, at: new Date().toISOString() })
  }
  /** Set while the host itself ends the app (stop, restart, idle): that close is not the app going away. */
  let ending = false

  /** Starts the app on the session's folders and wires its output, console and end into the host. */
  const start = async (): Promise<RunningApp> => {
    // A copy was indexed with the app's own search model; an empty install embeds offline. Keys copied in
    // on request were encrypted with the system's key store, so only then does the app use it.
    const app = await launch(record.install, {
      searchModel: record.mode === 'copy' ? 'app' : 'hashing',
      keyStore: record.keys ? 'system' : 'test'
    })
    const proc = app.app.process()
    proc.stdout?.on('data', (b: Buffer) => appLog.write(b))
    proc.stderr?.on('data', (b: Buffer) => appLog.write(b))
    app.page.on('console', (m) => note(m.type(), m.text()))
    app.page.on('pageerror', (e) => note('pageerror', e.message))
    app.app.on('close', () => {
      if (ending) return
      say('the app closed on its own')
      update({ status: 'exited', detail: 'the app closed (window closed, crash, or quit from the app)' })
      process.exit(0)
    })
    return app
  }

  let running: RunningApp
  try {
    running = await start()
  } catch (e) {
    return fail(`the app did not start: ${(e as Error).message}`)
  }

  const snapshotProcesses = (): ProcessInfo[] => {
    try {
      return processTree(running.app.process(), NO_PATH_RULE)
    } catch {
      return readSession(frontend, name)?.processes ?? []
    }
  }

  if (record.seeded) {
    try {
      await seed(running, say)
    } catch (e) {
      try {
        await quit(running, record.install, { byPath: false })
      } catch {
        /* reported below */
      }
      return fail(`the seed did not finish: ${(e as Error).message.split('\n')[0]}`)
    }
  }

  // The host inherits the caller's environment unchanged (only PATH may lead with the backend shim), so
  // these are the caller's real folders.
  const real = realDirs()
  let lastCommand = Date.now()
  let queue: Promise<unknown> = Promise.resolve()

  // Every quit here goes by identity (byPath: false): a program someone runs on the session's files is not
  // the session's to end.
  const stop = async (keep: boolean): Promise<string> => {
    ending = true
    const lines: string[] = []
    try {
      await quit(running, record.install, { byPath: false })
      lines.push('the app quit and left no process behind')
    } catch (e) {
      lines.push(`the app needed help to end: ${(e as Error).message}`)
    }
    // The person's stored keys go first and on their own (removing the folders is best effort); when they
    // cannot, the stop fails, and the command line's cleanup tries again with the record still in place.
    const hadKeys = forgetKeys(record.install.userData)
    if (keep) lines.push(`kept ${record.install.root}${hadKeys ? ', without the stored keys' : ''}`)
    else {
      removeInstall(record.install)
      lines.push(`removed ${record.install.root}`)
    }
    update({ status: 'exited', detail: 'stopped' })
    return lines.join('\n')
  }

  const handle = async (req: Request): Promise<string> => {
    const page = running.page
    switch (req.cmd) {
      case 'click':
        return click(page, req.args, req.flags)
      case 'hover':
        return hover(page, req.args, req.flags)
      case 'type':
        return type(page, req.args, req.flags)
      case 'press':
        return press(page, req.args, req.flags)
      case 'select':
        return select(page, req.args, req.flags)
      case 'wait':
        return runWait(page, record.install.downloads, req.args, req.flags)
      case 'snapshot':
        return snapshot(page, req.flags)
      case 'shot':
        return shot(page, req.args[0], req.flags)
      case 'read':
        return read(page, req.args)
      case 'console': {
        const since = req.flags.since === undefined ? 0 : Number(req.flags.since)
        if (!Number.isInteger(since) || since < 0)
          throw new Error('--since takes a message number, e.g. --since 12')
        const all = !!req.flags.all
        const entries = consoleLog.filter(
          (e) => e.n > since && (all || e.type === 'error' || e.type === 'pageerror')
        )
        return JSON.stringify({ last: consoleLog.length, entries })
      }
      case 'facts': {
        const processes = snapshotProcesses()
        update({ processes })
        return JSON.stringify(await gatherAppFacts(running, processes, real))
      }
      case 'stop':
        return stop(!!req.flags.keep)
      case 'restart': {
        // Quit as a person does and start again on the same folders: what was stored must come back.
        // The command line has checked (and if need be rebuilt) out/ and passes the build it starts from.
        ending = true
        let quitNote = ''
        try {
          await quit(running, record.install, { byPath: false })
        } catch (e) {
          // quit() ended whatever outlived the app before it threw; the folders are free to start again.
          quitNote = ` (the quit needed help: ${(e as Error).message.split('\n')[0]})`
        }
        ending = false
        try {
          running = await start()
        } catch (e) {
          const detail = `the app did not start again: ${(e as Error).message.split('\n')[0]}`
          say(detail)
          update({ status: 'failed', detail })
          setTimeout(() => process.exit(1), 200)
          throw new Error(`${detail}. The session is over; stop cleans up, logs are in ${record.logs}.`)
        }
        const started = JSON.parse(req.args[0] ?? 'null') as Pick<
          SessionRecord,
          'build' | 'backendSrc'
        > | null
        update({ processes: snapshotProcesses(), ...(started ?? {}) })
        return `the app quit and started again on the same data${quitNote}`
      }
      default:
        throw new Error(`unknown command "${req.cmd}"`)
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: Reply): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST' || req.headers['x-control-prism-token'] !== record.token) {
      reply(403, { ok: false, error: 'not this session' })
      return
    }
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      let parsed: Request
      try {
        parsed = JSON.parse(body) as Request
      } catch {
        reply(400, { ok: false, error: 'malformed request' })
        return
      }
      lastCommand = Date.now()
      let gone = false
      res.on('close', () => {
        if (!res.writableEnded) gone = true
      })
      // One command at a time, in the order they came: a click must not land in the middle of a wait. A
      // command whose caller gave up while it waited in line is dropped: run late, it would act unseen.
      const run = queue.then(() => {
        if (gone || (parsed.expires !== undefined && Date.now() > parsed.expires)) {
          throw new Error(`dropped: its caller stopped waiting before its turn came, so it did not run`)
        }
        return handle(parsed)
      })
      queue = run.catch(() => undefined)
      run.then(
        (text) => {
          reply(200, { ok: true, text })
          if (parsed.cmd === 'stop') setTimeout(() => process.exit(0), 100)
        },
        async (e: Error) => {
          const raw = ['click', 'hover', 'type', 'select'].includes(parsed.cmd)
            ? parsed.args[0]
            : parsed.cmd === 'wait'
              ? parsed.args[1]
              : typeof parsed.flags.target === 'string'
                ? parsed.flags.target
                : undefined
          // The explanation asks the window again; a frozen window must not hold back the answer.
          const error = await withDeadline(
            explainFailure(running.page, raw, e, parsed.cmd === 'wait'),
            3000
          ).catch(() => plainError(e.message))
          reply(200, { ok: false, error })
        }
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  update({ status: 'ready', port, processes: snapshotProcesses() })
  say(`ready on 127.0.0.1:${port}`)

  const idleMs = record.idleMinutes * 60_000
  setInterval(() => {
    if (ending || Date.now() - lastCommand < idleMs) return
    say(`no command for ${record.idleMinutes} min; quitting the app`)
    void stop(false).then(
      () => process.exit(0),
      (e: Error) => {
        // The record stays as it is: the next command finds the host gone and cleans up again.
        say(`the idle stop did not finish: ${e.message}`)
        process.exit(1)
      }
    )
  }, 30_000).unref()
}

/** Whether the host of `record` is still the process that was started for it. */
export function hostAlive(record: SessionRecord, running: ProcessInfo[]): boolean {
  return record.host !== null && running.some((p) => sameProcess(p, record.host!))
}
