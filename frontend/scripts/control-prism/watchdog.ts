/**
 * The host's watchdog. Each command gets a deadline of its own — the command's own bound (a wait's
 * --timeout, an action's ten seconds) plus a margin — past which the host answers that the driver did not
 * finish it, and takes the next command. Without it one call into Playwright that never settles holds the
 * line for good: every later command, doctor's too, waits behind it and reads as a frozen window.
 *
 * A command given up on is not cancelled — nothing cancels a call into Playwright — so it may still act.
 * A click or a keypress that lands late would act unseen, so while one is outstanding nothing else is
 * driven; looking (snapshot, shot, read, wait) goes on. When it settles after all, the next answer says so.
 *
 * The command line's own deadline is derived from the same table, so the caller always waits long enough
 * to hear the host give up.
 */
import { DEFAULT_WAIT_MS, MAX_WAIT_MS } from './waits'

type Flags = Record<string, string | true>

/** The commands that act on the window as a person does; looking (snapshot, shot, read, wait) is not one. */
export const DRIVING = new Set(['click', 'hover', 'type', 'press', 'select', 'drag'])

/** An action's own bound when no --timeout is given: one bound for the whole command, shared by its steps
 *  (actions.ts, drag.ts). */
const ACTION_MS = 10_000
/** The bound of a command that takes no --timeout and has no tighter one: a whole-window shot (Playwright's own
 *  default), a read. */
const OTHER_MS = 30_000
/** Past its own bound, how long the host still waits for a command before it gives up on it. */
export const HOST_MARGIN_MS = 20_000
/** Past the host's deadline, how long the caller still waits for the answer to arrive. */
export const ANSWER_MARGIN_MS = 10_000

/**
 * Stop and restart change what the session holds: given up on halfway, the session would be half-ended or
 * half-started. Their parts are bounded on their own (a quit ends what outlives it after a minute, a start
 * gives up after a few), and a stop that gets no answer ends the session from outside, by identity.
 */
const UNWATCHED = new Map([
  ['restart', 6 * 60_000],
  ['stop', 3 * 60_000]
])

/** How long `cmd` takes at most by its own bound. */
export function ownBound(cmd: string, flags: Flags): number {
  const asked = typeof flags.timeout === 'string' ? Number(flags.timeout) : NaN
  const own = Number.isFinite(asked) && asked > 0 ? Math.min(asked, MAX_WAIT_MS) : undefined
  switch (cmd) {
    case 'wait':
      return own ?? DEFAULT_WAIT_MS
    case 'click':
    case 'hover':
    case 'type':
    case 'press':
    case 'select':
    case 'drag':
    case 'snapshot':
      return own ?? ACTION_MS
    case 'shot':
      // A shot of one target takes --timeout; one of the whole window has Playwright's default.
      return Math.max(own ?? 0, OTHER_MS)
    case 'facts':
    case 'console':
      // Questions to the main process and the host's own memory: quick, and doctor should not wait long.
      return ACTION_MS
    default:
      return OTHER_MS
  }
}

/** When the host gives up on `cmd`; null for the commands it never gives up on (stop, restart). */
export function hostDeadline(cmd: string, flags: Flags): number | null {
  return UNWATCHED.has(cmd) ? null : ownBound(cmd, flags) + HOST_MARGIN_MS
}

/** How long the caller waits for the answer to `cmd`. */
export function callerDeadline(cmd: string, flags: Flags): number {
  const host = hostDeadline(cmd, flags)
  return host === null ? UNWATCHED.get(cmd)! : host + ANSWER_MARGIN_MS
}

/** A command the host gave up on at its deadline. */
export class Overdue extends Error {}

interface Command {
  cmd: string
  args: string[]
  flags: Flags
}

/** How a command is named in what the host says: enough to recognise it, never a typed text or a script. */
export function described(req: Command): string {
  const q = (s: string | true | undefined): string => (typeof s === 'string' ? ` ${JSON.stringify(s)}` : '')
  switch (req.cmd) {
    case 'wait':
      return `wait ${req.args[0] ?? ''}${q(req.args[1])}`.trimEnd()
    case 'drag':
      return `drag${q(req.args[0])} onto${q(req.args[1])}`
    case 'press':
      return `press ${req.args.join(' ')}${q(req.flags.target)}`.trimEnd()
    case 'snapshot':
    case 'shot':
    case 'read':
    case 'facts':
    case 'console':
      return `${req.cmd}${q(req.flags.target)}`
    default:
      return `${req.cmd}${q(req.args[0])}`
  }
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)} s`

/** What the driver is doing, for doctor: whether a command holds the line, and which commands it gave up on
 *  have not settled — a driving one may still act, a look shows a call into Playwright that never answered.
 *  Questions about the session in flight (facts, console) are left out of `busy`: doctor is asking one. */
export interface DriverState {
  busy: { what: string; ms: number; leftMs: number | null }[]
  /** The driving command given up on that has not settled (at most one: driving waits for it). */
  outstanding: { what: string; ms: number } | null
  /** Other commands given up on that have not settled. */
  overdue: { what: string; ms: number }[]
}

/** Commands that ask about the session rather than the window. */
export const QUESTIONS = new Set(['facts', 'console'])

interface InFlight {
  cmd: string
  what: string
  since: number
  until: number | null
}

interface GivenUp {
  what: string
  since: number
  driving: boolean
}

export class Watchdog {
  /** Commands given up on that have not settled; a driving one among them may still act on the window. */
  private givenUp = new Set<GivenUp>()
  /** Commands running now and not given up on. */
  private inFlight = new Set<InFlight>()
  /** What became of driving commands given up on, for the next answer that reaches its caller. */
  private news: string[] = []
  /** Counts the windows: what a command given up on does after a restart no longer concerns the session. */
  private generation = 0

  constructor(
    private readonly say: (line: string) => void,
    private readonly now: () => number = Date.now
  ) {}

  private pendingDrive(): GivenUp | undefined {
    return [...this.givenUp].find((g) => g.driving)
  }

  /**
   * Runs `work` for `req` under its deadline. Past it, the answer is an Overdue error and the host moves on;
   * `work` keeps running, and a driving command blocks further driving until it settles.
   */
  run(req: Command, work: () => Promise<string>): Promise<string> {
    const driving = DRIVING.has(req.cmd)
    const pending = driving ? this.pendingDrive() : undefined
    if (pending) {
      return Promise.reject(
        new Error(
          `the earlier ${pending.what}, given up on ${seconds(this.now() - pending.since)} ago, has not finished ` +
            'and may still land: this session drives nothing until it has (snapshot and shot look meanwhile) ' +
            'or until restart'
        )
      )
    }
    const ms = hostDeadline(req.cmd, req.flags)
    const what = described(req)
    const since = this.now()
    const entry: InFlight = { cmd: req.cmd, what, since, until: ms === null ? null : since + ms }
    this.inFlight.add(entry)
    const task = work()
    const generation = this.generation
    return new Promise<string>((resolve, reject) => {
      let mark: GivenUp | null = null
      const timer =
        ms === null
          ? undefined
          : setTimeout(() => {
              mark = { what, since: this.now(), driving }
              this.inFlight.delete(entry)
              this.givenUp.add(mark)
              this.say(`gave up on ${what} after ${seconds(ms)}`)
              const own = `its own bound is ${seconds(ownBound(req.cmd, req.flags))}`
              reject(
                new Overdue(
                  `${what} did not finish within ${seconds(ms)} (${own}): the driver is stuck, not necessarily ` +
                    'the window. ' +
                    (driving
                      ? 'It may still land, so this session drives nothing until it has finished or the ' +
                        'session restarts; looking goes on. '
                      : 'The session takes the next command. ') +
                    'doctor says whether the window itself answers.'
                )
              )
            }, ms)
      const settled = (how: () => string): void => {
        clearTimeout(timer)
        this.inFlight.delete(entry)
        if (mark === null) return
        const late = how()
        this.say(`${what}, given up on earlier, ${late}`)
        this.givenUp.delete(mark)
        if (generation === this.generation && driving)
          this.news.push(`the earlier ${what}, given up on at its deadline, ${late}`)
      }
      task.then(
        (text) => {
          settled(() => `finished after all, ${seconds(this.now() - mark!.since)} later`)
          if (mark === null) resolve(text)
        },
        (e: Error) => {
          settled(() => `failed after all (${e.message.split('\n')[0]})`)
          if (mark === null) reject(e)
        }
      )
    })
  }

  /** A new window (restart): what the old one still had given up on cannot act on this one. */
  reset(): void {
    this.generation++
    this.givenUp.clear()
    this.news = []
  }

  /** What became of driving commands given up on since the last answer that reached its caller — once.
   *  Only for an answer that will be read: news handed to a caller who left would be lost. */
  takeNews(): string | undefined {
    if (this.news.length === 0) return undefined
    const text = this.news.join('\n')
    this.news = []
    return text
  }

  state(): DriverState {
    const now = this.now()
    const given = [...this.givenUp]
    const drive = given.find((g) => g.driving)
    return {
      busy: [...this.inFlight]
        .filter((e) => !QUESTIONS.has(e.cmd))
        .map((e) => ({ what: e.what, ms: now - e.since, leftMs: e.until === null ? null : e.until - now })),
      outstanding: drive ? { what: drive.what, ms: now - drive.since } : null,
      overdue: given.filter((g) => !g.driving).map((g) => ({ what: g.what, ms: now - g.since }))
    }
  }
}
