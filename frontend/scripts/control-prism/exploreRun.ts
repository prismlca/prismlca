/**
 * One exploring run, start to finish: a fresh sealed session (`launch --seed --sealed`), doctor, the model recipe
 * of features/model.md (and a control's preparation), Bombadil against the window for the run's time, then the
 * record a person would keep — doctor, `console --all`, `refused`, a screenshot, status, the session's logs — and
 * `stop`. Every step is the control-prism command a person types, run as one and written to the run's folder, so
 * the record shows exactly what happened. Afterwards the trace and the backend log are read (exploreTrace.ts,
 * backendLog.ts).
 *
 * A run that broke off stays open: if the window still answers past the driver, Bombadil broke; if not, the app.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { groupErrors, unhandledErrors, type ErrorGroup } from './backendLog'
import { traceScreenshot, traceStates } from './bombadil'
import { readCoverageTable, TraceDigest, type RunDigest } from './exploreTrace'
import { readSealLog, SEAL_LOG } from './sealed'
import { controlDir } from './session'
import { devToolsEndpoint, probeWindow } from './windowProbe'

export interface RunPlan {
  /** The session's name. */
  session: string
  /** The run's folder: its record, trace and report material. */
  dir: string
  /** The `frontend/` whose app runs: this checkout, or a throwaway build for a positive control. */
  frontend: string
  /** What the run is, for the report: "explore", "control rest on the patched build" … */
  label: string
  /** The spec folder (features/explore of the checkout that asked) and the spec in it to run. */
  specDir: string
  spec: string
  seconds: number
  /** control-prism commands run after the model recipe, as words. */
  prep: string[][]
  recipe: string[][]
  bombadil: string
  /** Set when the person running it stops the whole run. */
  signal: AbortSignal
  log: (line: string) => void
}

export type Outcome = 'complete' | 'open' | 'not started'

export interface RunRecord {
  session: string
  label: string
  dir: string
  seconds: number
  outcome: Outcome
  /** Why a run is open or did not start: which step failed, or whether Bombadil or the app broke. */
  why?: string
  bombadil: { exit: number | null; seconds: number } | null
  digest: RunDigest | null
  /** Named functions the run executed, for the union across runs. */
  namedFunctions: string[]
  hitBlocks: number[]
  totalBlocks: number
  backend: { unhandled: number; groups: ErrorGroup[] }
  consoleErrors: number | null
  refused: { count: number; byKind: Record<string, number>; targets: string[] }
  load: number[]
  /** First state of each shown episode → its screenshot, relative to the run's folder. */
  screenshots: Record<string, string>
  /** Whether `stop` ended the session. When it did not, its record is the way to try again (`stop` once more). */
  stopped: boolean
}

interface Done {
  code: number | null
  text: string
}

/** Runs a control-prism command of `frontend` on the plan's session, its output appended to `file` in the run's folder. */
function controlPrism(plan: RunPlan, args: string[], file: string, ms = 15 * 60_000): Promise<Done> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(plan.frontend, 'scripts', 'control-prism.mjs'), ...args], {
      cwd: plan.frontend,
      env: { ...process.env, CONTROL_PRISM_SESSION: plan.session },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let text = ''
    child.stdout.on('data', (d: Buffer) => (text += d.toString()))
    child.stderr.on('data', (d: Buffer) => (text += d.toString()))
    const timer = setTimeout(() => child.kill('SIGTERM'), ms)
    child.on('close', (code) => {
      clearTimeout(timer)
      appendFileSync(join(plan.dir, file), `$ control-prism ${args.join(' ')}\n${text}(exit ${code})\n\n`)
      resolve({ code, text })
    })
  })
}

/** The page target of the app's main window (the renderer from a file:, not the splash). */
async function windowOrigin(port: string): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10_000) })
    const targets = (await res.json()) as { type: string; url: string }[]
    return targets.find((t) => t.type === 'page' && t.url.startsWith('file:'))?.url ?? null
  } catch {
    return null
  }
}

function runBombadil(
  plan: RunPlan,
  port: string,
  origin: string,
  spec: string
): Promise<{ exit: number | null; seconds: number; stopped: boolean }> {
  const args = [
    'browser',
    'test-external',
    '--remote-debugger',
    `http://127.0.0.1:${port}`,
    '--width',
    '1920',
    '--height',
    '1080',
    '--time-limit',
    `${plan.seconds}s`,
    '--coverage-symbols',
    join(plan.dir, 'coverage.jsonl'),
    '--output-path',
    join(plan.dir, 'trace.bin'),
    origin,
    spec
  ]
  writeFileSync(join(plan.dir, 'bombadil.log'), `$ bombadil ${args.join(' ')}\n\n`)
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(plan.bombadil, args, { cwd: plan.dir, stdio: ['ignore', 'pipe', 'pipe'] })
    const write = (d: Buffer): void => appendFileSync(join(plan.dir, 'bombadil.log'), d)
    child.stdout.on('data', write)
    child.stderr.on('data', write)
    let stopped = false
    const stop = (): void => {
      stopped = true
      child.kill('SIGTERM')
    }
    plan.signal.addEventListener('abort', stop, { once: true })
    // Bombadil ends itself at the time limit; past that and a margin for its last capture it is stuck.
    const guard = setTimeout(stop, (plan.seconds + 300) * 1000)
    child.on('close', (code) => {
      clearTimeout(guard)
      plan.signal.removeEventListener('abort', stop)
      resolve({ exit: code, seconds: Math.round((Date.now() - started) / 1000), stopped })
    })
    child.on('error', (e) => {
      write(Buffer.from(`could not start Bombadil: ${e.message}\n`))
    })
  })
}

/** The last error Bombadil printed: the line after its last "Error:". */
function bombadilError(dir: string): string {
  const lines = readFileSync(join(dir, 'bombadil.log'), 'utf8').split('\n')
  const at = lines.map((l) => l.startsWith('Error:')).lastIndexOf(true)
  if (at < 0) return lines.filter((l) => l.trim()).slice(-1)[0] ?? 'no message'
  return lines
    .slice(at, at + 4)
    .filter((l) => l.trim())
    .join(' / ')
}

function summariseSeal(path: string): RunRecord['refused'] {
  const entries = (readSealLog(path) ?? []).filter(
    (e) => e.kind !== 'sealed' && !e.target.includes('.invalid')
  )
  const byKind: Record<string, number> = {}
  const targets = new Map<string, number>()
  for (const e of entries) {
    const k = `${e.kind} ${e.outcome}`
    byKind[k] = (byKind[k] ?? 0) + 1
    const t = e.kind === 'dialog' ? e.target : e.target.replace(/^(\w+:\/\/[^/]+).*/, '$1')
    targets.set(t, (targets.get(t) ?? 0) + 1)
  }
  return {
    count: entries.length,
    byKind,
    targets: [...targets]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([t, n]) => `${t} ×${n}`)
  }
}

export async function runOnce(plan: RunPlan): Promise<RunRecord> {
  mkdirSync(plan.dir, { recursive: true })
  // The record keeps the spec it ran: the whole spec folder, so the controls' "../lib.ts" resolves as well.
  const specCopy = join(plan.dir, 'spec')
  cpSync(plan.specDir, specCopy, { recursive: true })
  const spec = join(specCopy, relative(plan.specDir, plan.spec))
  const record: RunRecord = {
    session: plan.session,
    label: plan.label,
    dir: plan.dir,
    seconds: plan.seconds,
    outcome: 'not started',
    bombadil: null,
    digest: null,
    namedFunctions: [],
    hitBlocks: [],
    totalBlocks: 0,
    backend: { unhandled: 0, groups: [] },
    consoleErrors: null,
    refused: { count: 0, byKind: {}, targets: [] },
    load: [],
    screenshots: {},
    stopped: false
  }
  const idle = Math.ceil(plan.seconds / 60) + 30
  plan.log(`  launch --seed --sealed (session ${plan.session}) …`)
  const launched = await controlPrism(
    plan,
    ['launch', '--seed', '--sealed', '--idle', String(idle)],
    'launch.txt'
  )
  // The session's logs, where launch puts them; copied into the record however far the run got.
  const logs = join(controlDir(plan.frontend), 'logs', plan.session)
  const stop = async (): Promise<void> => {
    const done = await controlPrism(plan, ['stop'], 'stop.txt')
    // No session left is as good as stopped: a launch that failed cleans up after itself.
    record.stopped = done.code === 0 || /no session/.test(done.text)
    if (!record.stopped)
      markOpen(record, `stop did not end the session (stop.txt) — run stop for session ${plan.session}`)
    if (existsSync(logs)) cpSync(logs, join(plan.dir, 'logs'), { recursive: true })
  }
  if (launched.code !== 0) {
    record.why = `launch failed (launch.txt): ${launched.text.trim().split('\n').slice(-1)[0]}`
    await stop()
    return record
  }
  try {
    const doctor = await controlPrism(plan, ['doctor'], 'doctor-start.txt')
    if (doctor.code !== 0) {
      record.why = 'doctor found the session no valid witness (doctor-start.txt)'
      return record
    }
    plan.log('  model recipe of features/model.md …')
    for (const words of [...plan.recipe, ...plan.prep]) {
      const step = await controlPrism(plan, words, 'prep.txt')
      if (step.code !== 0) {
        record.why = `the preparation failed at "${words.join(' ')}" (prep.txt)`
        return record
      }
    }
    await controlPrism(plan, ['console'], 'console-prep.txt')
    const status = await controlPrism(plan, ['status'], 'status-start.txt')
    const session = JSON.parse(status.text.slice(status.text.indexOf('{'))) as {
      install: { userData: string }
    }
    const endpoint = devToolsEndpoint(session.install.userData)
    const port = endpoint ? /:(\d+)\//.exec(endpoint)?.[1] : undefined
    const origin = port ? await windowOrigin(port) : null
    if (!port || !origin) {
      record.why = `the window's DevTools target was not found (port ${port ?? 'none'})`
      return record
    }
    await controlPrism(plan, ['shot', join(plan.dir, 'before.png')], 'shot.txt')

    if (plan.signal.aborted) {
      record.why = 'stopped by the person running it before Bombadil started'
      return record
    }
    plan.log(`  Bombadil for ${plan.seconds} s …`)
    const sampler = setInterval(() => record.load.push(Math.round(loadavg()[0] * 10) / 10), 30_000)
    record.load.push(Math.round(loadavg()[0] * 10) / 10)
    const b = await runBombadil(plan, port, origin, spec)
    clearInterval(sampler)
    record.bombadil = { exit: b.exit, seconds: b.seconds }
    // Exit 0: the time ran out with no violation; 2: it ran out with violations. Anything else broke off.
    if (b.exit === 0 || b.exit === 2) record.outcome = 'complete'
    else {
      record.outcome = 'open'
      const probe = await probeWindow(session.install.userData)
      const what =
        probe.outcome === 'answers'
          ? 'Bombadil broke; the window still answers'
          : `the app broke: the window ${probe.outcome}${'why' in probe ? ` (${probe.why})` : ''}`
      record.why = b.stopped
        ? `stopped after ${b.seconds} s (${plan.signal.aborted ? 'by the person running it' : 'Bombadil did not end at its time limit'}); ${what}`
        : `${what} — Bombadil exit ${b.exit} after ${b.seconds} s: ${bombadilError(plan.dir)}`
    }
    await controlPrism(plan, ['doctor'], 'doctor-end.txt')
    const consoleAll = await controlPrism(plan, ['console', '--all'], 'console-all.txt')
    const errors = /^(\d+) error\(s\)/m.exec(consoleAll.text)
    record.consoleErrors = errors ? Number(errors[1]) : null
    await controlPrism(plan, ['refused'], 'refused.txt')
    await controlPrism(plan, ['shot', join(plan.dir, 'after.png')], 'shot.txt')
    await controlPrism(plan, ['status'], 'status-end.txt')
  } catch (e) {
    // Something of explore's own failed (an answer it could not read): the run is open, the record kept.
    if (record.outcome === 'complete')
      markOpen(record, `explore failed after the run: ${(e as Error).message}`)
    else record.why = `${record.why ? record.why + '; ' : ''}explore failed: ${(e as Error).message}`
  } finally {
    await stop()
  }
  return record
}

/** A run whose evidence is incomplete is open, never green: what it shows still counts, but not as a clean run. */
export function markOpen(record: RunRecord, why: string): void {
  if (record.outcome === 'complete') record.outcome = 'open'
  record.why = record.why ? `${record.why}; ${why}` : why
}

/** Reads what the run left: the backend log, the seal log and the trace, with a screenshot per shown episode. A run
 *  that drove the app must have left a backend log and a whole, readable trace; otherwise it is open. */
export async function analyse(
  record: RunRecord,
  bombadil: string,
  log: (line: string) => void
): Promise<void> {
  const dir = record.dir
  const ran = record.bombadil !== null
  const appLog = join(dir, 'logs', 'app.log')
  if (existsSync(appLog)) {
    const errors = unhandledErrors(readFileSync(appLog, 'utf8'))
    record.backend = { unhandled: errors.length, groups: groupErrors(errors) }
    if (errors.length > 0) {
      writeFileSync(
        join(dir, 'backend-unhandled.txt'),
        errors.map((e) => `app.log line ${e.line}: ${e.exception}\n${e.traceback.join('\n')}\n`).join('\n')
      )
    }
  } else if (ran) markOpen(record, 'the session left no backend log to read (logs/app.log)')
  record.refused = summariseSeal(join(dir, 'logs', SEAL_LOG))
  const trace = join(dir, 'trace.bin')
  if (!existsSync(trace)) {
    if (ran) markOpen(record, 'Bombadil left no trace')
    return
  }
  const coverage = join(dir, 'coverage.jsonl')
  const table = existsSync(coverage) ? readCoverageTable(readFileSync(coverage, 'utf8')) : null
  const digest = new TraceDigest(table)
  try {
    for await (const s of traceStates(bombadil, trace)) digest.add(s)
  } catch (e) {
    log(`  the trace could not be read to its end: ${(e as Error).message}`)
    markOpen(
      record,
      `the trace could not be read to its end (${(e as Error).message}); what it showed until then is reported`
    )
  }
  record.digest = digest.result()
  if (ran && record.digest.states === 0) markOpen(record, 'the trace holds no state')
  // Exit 2 says Bombadil saw a violation; a trace that shows none disagrees, and the run is not taken as clean.
  if (record.bombadil?.exit === 2 && record.digest.violations.length === 0)
    markOpen(record, 'Bombadil reported a violation that the trace does not show')
  record.namedFunctions = [...digest.namedFunctions()]
  record.hitBlocks = table ? [...digest.hit].filter((b) => table.has(b)) : []
  record.totalBlocks = table?.size ?? 0
  for (const v of record.digest.violations) {
    for (const e of v.shown.slice(0, 3)) {
      const file = await traceScreenshot(bombadil, trace, e.first, join(dir, 'states'))
      if (file) record.screenshots[`${v.property}@${e.first}`] = relative(dirname(dir), file)
    }
  }
}
