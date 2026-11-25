/**
 * A sealed session (`launch --sealed`): the app refuses everything that would leave the computer — links,
 * files and folders handed to the desktop, native dialogs, requests of the main process, the backend and the
 * programs they start — and writes each attempt to the session's seal log (src/main/seal/, backend
 * prism_lca/seal.py). Here: what the host asks the app about its seal, how doctor judges the answer, and
 * the list `refused` prints.
 */
import { readFileSync } from 'node:fs'
import type { RunningApp } from '../../e2e/app'
import type { SealEntry } from '../../src/main/seal/log'
import type { Check } from './doctor'
import type { AppFacts } from './facts'
import type { SessionRecord } from './session'

export type { SealEntry }

/** The seal log's name in the session's logs folder. */
export const SEAL_LOG = 'sealed.jsonl'
/** The host doctor's probes ask for: reserved, so even a stack that is not sealed reaches no server. */
export const PROBE_HOST = 'doctor-probe.invalid'

export interface SealFacts {
  /** The main process's pid and its PRISM_SEALED. */
  pid: number
  log: string
  /** The trap the main process hands the programs it starts (its HTTPS_PROXY). */
  trap: string | null
  /** How a request to PROBE_HOST fared through Node's sockets and through Chromium: 'refused' or what
   *  happened instead. */
  node: string
  chromium: string
  /** Each of the app's web contents, and whether the seal's debugger is attached to it; whether Chromium
   *  took the interception is in the log (src/main/seal/choosers.ts). */
  windows: { id: number; url: string; attached: boolean }[]
}

/** Asked in the main process. An app that is not sealed is not probed: its probe would really go out. */
export function gatherSealFacts(running: RunningApp): Promise<SealFacts | null> {
  return running.app.evaluate(async ({ session, webContents }, host) => {
    const log = process.env.PRISM_SEALED
    if (!log) return null
    const url = `https://${host}/`
    const node = await fetch(url).then(
      () => 'answered',
      (e: Error & { cause?: { sealed?: boolean; code?: string; message?: string } }) =>
        e.cause?.sealed ? 'refused' : (e.cause?.code ?? e.cause?.message ?? e.message)
    )
    const chromium = await session.defaultSession.fetch(url).then(
      () => 'answered',
      (e: Error) => (/ERR_BLOCKED_BY_CLIENT/.test(e.message) ? 'refused' : e.message)
    )
    const windows = webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed())
      .map((wc) => ({ id: wc.id, url: wc.getURL().slice(0, 80), attached: wc.debugger.isAttached() }))
    return { pid: process.pid, log, trap: process.env.HTTPS_PROXY ?? null, node, chromium, windows }
  }, PROBE_HOST)
}

/** The log's entries, in the order written; null when there is no log to read. */
export function readSealLog(path: string): SealEntry[] | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const entries: SealEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line) as SealEntry)
    } catch {
      /* a line cut off by a process that ended mid-write */
    }
  }
  return entries
}

const isProbe = (e: SealEntry): boolean => e.target.includes(PROBE_HOST)
/** Whether `proc` (`pid`) wrote that its seal is in place — the part `via` names, when given. */
const inPlace = (entries: SealEntry[], proc: string, pid: number, via?: string, target?: string): boolean =>
  entries.some(
    (e) =>
      e.kind === 'sealed' &&
      e.proc === proc &&
      e.pid === pid &&
      e.outcome === 'in place' &&
      (via === undefined || e.via === via) &&
      (target === undefined || e.target === target)
  )

/** Doctor's verdict on the seal: asked for and in place in every process, or plainly not asked for. */
export function judgeSeal(record: SessionRecord, app: AppFacts, entries: SealEntry[] | null): Check[] {
  const seal = app.seal ?? null
  if (!record.seal) {
    return [
      seal
        ? {
            status: 'FAIL',
            text: `the app is sealed (${seal.log}) though launch was not asked to — the session cannot show its log`
          }
        : {
            status: 'note',
            text:
              'not sealed: links, files, dialogs and requests reach out of this computer as they would for a ' +
              'person — launch --sealed before exploring'
          }
    ]
  }
  if (!seal || seal.log !== record.seal) {
    return [
      {
        status: 'FAIL',
        text: seal
          ? `the app writes its seal log to ${seal.log}, not to the session's ${record.seal}`
          : 'launch asked for a sealed instance, but the app is not sealed: links, dialogs and requests reach out'
      }
    ]
  }
  const log = entries ?? []
  const checks: Check[] = []
  const add = (ok: boolean, good: string, bad: string): void => {
    checks.push(ok ? { status: 'ok', text: good } : { status: 'FAIL', text: bad })
  }
  add(
    inPlace(log, 'main', seal.pid, 'main'),
    `the app is sealed: what it refuses is written to ${record.seal}`,
    `the main process wrote no "sealed in place" line to ${record.seal}: the programs it starts may go out unheld`
  )
  // The running app's failures only: a restart appends to the same log, and an earlier instance's failure
  // stays in it (refused lists it) without speaking for the app now.
  const current = new Set([seal.pid, ...(app.backends ?? []).map((b) => b.pid)])
  const failed = log.filter((e) => e.outcome === 'failed' && current.has(e.pid))
  add(
    failed.length === 0,
    'no part of the seal failed',
    `part of the seal failed: ${failed.map((e) => `${e.target} (${e.via})`).join('; ')}`
  )
  add(
    seal.node === 'refused',
    "a request through the main process's Node is refused",
    `a request through the main process's Node was not refused by the seal (${seal.node})`
  )
  add(
    seal.chromium === 'refused',
    "a request through the main process's Chromium is refused",
    `a request through the main process's Chromium was not refused by the seal (${seal.chromium})`
  )
  const loose = seal.windows.filter(
    (w) => !w.attached || !inPlace(log, 'main', seal.pid, 'debugger', `choosers of window ${w.id}`)
  )
  add(
    seal.windows.length > 0 && loose.length === 0,
    `file and colour choosers are cancelled in each of the app's web contents (${seal.windows.length})`,
    loose.length > 0
      ? `file and colour choosers are not cancelled in ${loose.map((w) => w.url || '(blank)').join(', ')}: ` +
          'they would open'
      : 'the app reports no web contents to cancel choosers in'
  )
  if (app.backends === null) {
    checks.push({ status: 'note', text: "the backend's seal is only checked on Linux; not checked here" })
  } else {
    for (const b of app.backends) {
      add(
        b.seal === record.seal && inPlace(log, 'backend', b.pid),
        `the backend (pid ${b.pid}) refuses its own lookups and connections`,
        b.seal === record.seal
          ? `the backend (pid ${b.pid}) wrote no "sealed in place" line: its own requests are not held`
          : `the backend (pid ${b.pid}) has PRISM_SEALED=${b.seal}, not the session's log`
      )
      add(
        b.proxy !== null && b.proxy === seal.trap,
        `the backend's proxy variables lead to the trap (${seal.trap})`,
        `the backend's HTTPS_PROXY is ${b.proxy}, not the trap ${seal.trap}: native code in it could go out`
      )
    }
  }
  const tried = log.filter((e) => e.kind !== 'sealed' && e.outcome !== 'failed' && !isProbe(e)).length
  checks.push({
    status: 'note',
    text: tried === 0 ? 'nothing refused so far' : `${tried} attempt(s) refused so far — refused lists them`
  })
  return checks
}

/** The `refused` command's lines: every attempt after message `since`, numbered by its line in the log. */
export function refusedLines(entries: SealEntry[], since: number): string[] {
  const lines: string[] = []
  entries.forEach((e, i) => {
    const n = i + 1
    if (n <= since || e.kind === 'sealed') return
    const time = e.at.slice(11, 19)
    const probe = isProbe(e) ? " (doctor's probe)" : ''
    lines.push(`#${n} ${time} ${e.proc} ${e.kind} ${e.outcome}: ${e.target} — ${e.via}${probe}`)
  })
  return lines
}
