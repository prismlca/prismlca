/**
 * `explore`: Bombadil explores the app at random before a release, run by run, each run in a fresh sealed session
 * (exploreRun.ts), with the spec in features/explore/. A finding comes from three sources — the spec's properties,
 * every "Unhandled error" in the session's backend log, and a visible "Unexpected server error" (a property) — and
 * the report (exploreReport.ts) says per run where it went and what it found. `explore --control <name|all>` runs
 * the spec's positive controls instead (controls.ts).
 *
 * Everything goes to .cache/control-prism/explore/<time>/ of this checkout: report.md, report.json, one folder per run.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FRONTEND } from '../../e2e/app'
import type { Parsed } from './args'
import { BOMBADIL_VERSION, ensureBombadil } from './bombadil'
import { Exit, out } from './client'
import {
  missingRed,
  readControls,
  readVerified,
  specHash,
  throwawayBuild,
  unexpectedRed,
  writeVerified,
  type ControlDef
} from './controls'
import { analyse, runOnce, type RunPlan, type RunRecord } from './exploreRun'
import { findingsOf, renderReport, runLines } from './exploreReport'
import { drivingCommands, modelRecipe } from './recipe'
import { controlDir } from './session'

/** Short runs in fresh sessions reach more than one long run of the same time: three runs of 5 minutes beat one
 *  of 15 in blocks, dialog types and named functions, twice in a row. 6 × 5 spends the half hour a release can. */
export const DEFAULT_MINUTES = 5
export const DEFAULT_RUNS = 6

const SPEC_DIR = join(FRONTEND, 'features', 'explore')

function positive(flag: string | true | undefined, name: string, fallback: number, max: number): number {
  if (flag === undefined) return fallback
  const n = Number(flag)
  if (!Number.isFinite(n) || n <= 0 || n > max)
    throw new Exit(2, `--${name} takes a number above 0, at most ${max}`)
  return n
}

/** Local time as a folder and session name part: 20261126-214500. */
function stamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Stops the runs on Ctrl+C or a kill: the run under way is recorded and its session stopped, no further run starts. */
function stopOnSignal(): { signal: AbortSignal; release: () => void } {
  const ctrl = new AbortController()
  const on = (): void => {
    if (ctrl.signal.aborted) return
    out('stopping: the run under way is recorded and its session stopped; no further run starts')
    ctrl.abort()
  }
  process.on('SIGINT', on)
  process.on('SIGTERM', on)
  return {
    signal: ctrl.signal,
    release: () => {
      process.off('SIGINT', on)
      process.off('SIGTERM', on)
    }
  }
}

async function oneRun(plan: RunPlan, bombadil: string): Promise<RunRecord> {
  const r = await runOnce(plan)
  await analyse(r, bombadil, out)
  const f = findingsOf(r)
  out(
    `  ${r.outcome}${r.why ? ` (${r.why})` : ''}; ${f.length} finding(s)${f.length ? ': ' + f.map((x) => x.title).join('; ') : ''}`
  )
  return r
}

export async function explore(flags: Parsed['flags']): Promise<void> {
  if (flags.control !== undefined) return controls(String(flags.control))
  const minutes = positive(flags.minutes, 'minutes', DEFAULT_MINUTES, 240)
  const runs = Math.round(positive(flags.runs, 'runs', DEFAULT_RUNS, 20))
  const bombadil = await ensureBombadil(out)
  const recipe = modelRecipe(FRONTEND)
  const hash = specHash(SPEC_DIR)
  const verified = readVerified(SPEC_DIR)?.spec === hash
  if (!verified)
    out('warning: the spec has changed since its positive controls last passed — run explore --control all')
  const time = stamp()
  const root = join(controlDir(FRONTEND), 'explore', time)
  mkdirSync(root, { recursive: true })
  out(`exploring: ${runs} run(s) of ${minutes} min, each in a fresh sealed session; record in ${root}`)
  const { signal, release } = stopOnSignal()
  const records: RunRecord[] = []
  try {
    for (let i = 1; i <= runs && !signal.aborted; i++) {
      out(`run ${i} of ${runs}:`)
      records.push(
        await oneRun(
          {
            session: `xp-${time}-${i}`,
            dir: join(root, `run-${i}`),
            frontend: FRONTEND,
            label: 'explore',
            specDir: SPEC_DIR,
            spec: join(SPEC_DIR, 'explore.ts'),
            seconds: Math.round(minutes * 60),
            prep: [],
            recipe,
            bombadil,
            signal,
            log: out
          },
          bombadil
        )
      )
    }
  } finally {
    release()
    const meta = {
      title: `control-prism explore — ${time}`,
      checkout: FRONTEND,
      bombadil: BOMBADIL_VERSION,
      spec: { hash, verified },
      runs: records.length,
      seconds: Math.round(minutes * 60)
    }
    writeFileSync(join(root, 'report.md'), renderReport(meta, records))
    writeFileSync(join(root, 'report.json'), JSON.stringify({ ...meta, records }, null, 1))
    out(`report: ${join(root, 'report.md')}`)
  }
  const findings = records.flatMap(findingsOf).length
  const open = records.filter((r) => r.outcome !== 'complete').length
  if (signal.aborted) throw new Exit(130, 'stopped before all runs were done')
  if (findings || open)
    throw new Exit(1, `${findings} finding(s), ${open} run(s) not complete — see the report`)
  out('no findings, every run complete')
}

interface ControlResult {
  def: ControlDef
  passed: boolean
  problems: string[]
  runs: RunRecord[]
}

async function controls(which: string): Promise<void> {
  const all = readControls(SPEC_DIR)
  const chosen = which === 'all' ? all : all.filter((c) => c.name === which)
  if (chosen.length === 0)
    throw new Exit(2, `no control "${which}" — there are ${all.map((c) => c.name).join(', ')} (or all)`)
  const bombadil = await ensureBombadil(out)
  const recipe = modelRecipe(FRONTEND)
  const hash = specHash(SPEC_DIR)
  const time = stamp()
  const root = join(controlDir(FRONTEND), 'explore', `controls-${time}`)
  mkdirSync(root, { recursive: true })
  out(`positive controls: ${chosen.map((c) => c.name).join(', ')}; record in ${root}`)
  const { signal, release } = stopOnSignal()
  const results: ControlResult[] = []
  try {
    for (const def of chosen) {
      if (signal.aborted) break
      const plan = (frontend: string, kind: string): RunPlan => ({
        session: `xc-${def.name}-${kind}-${time.slice(9)}`,
        dir: join(root, `${def.name}-${kind}`),
        frontend,
        label: `control ${def.name}, ${kind === 'red' ? (def.patch ? `with ${def.patch}` : 'causing its conditions') : 'this checkout as it is'}`,
        specDir: SPEC_DIR,
        spec: join(SPEC_DIR, 'controls', def.spec),
        seconds: def.seconds,
        prep: drivingCommands(def.prep ?? []),
        recipe,
        bombadil,
        signal,
        log: out
      })
      const result: ControlResult = { def, passed: false, problems: [], runs: [] }
      results.push(result)
      out(`control ${def.name} — ${def.about}`)
      let build: { frontend: string; remove: () => void } | null = null
      try {
        if (def.patch) {
          out(`  a throwaway build with ${def.patch} …`)
          build = throwawayBuild(
            FRONTEND,
            join(SPEC_DIR, 'controls', def.patch),
            `explore-control-${def.name}-${time}`
          )
        }
        const red = await oneRun(plan(build?.frontend ?? FRONTEND, 'red'), bombadil)
        result.runs.push(red)
        result.problems.push(...missingRed(def, red).map((p) => `red run: ${p}`))
        if (build && !red.stopped) {
          // Its session record lives in the throwaway checkout: removing it would remove the way to stop it.
          result.problems.push(
            `red run: its session was not stopped; the throwaway checkout stays: ${build.frontend}`
          )
          build = null
        }
      } catch (e) {
        result.problems.push(`red run: ${(e as Error).message}`)
      } finally {
        build?.remove()
      }
      if (def.patch && !signal.aborted) {
        const green = await oneRun(plan(FRONTEND, 'green'), bombadil)
        result.runs.push(green)
        result.problems.push(...unexpectedRed(green).map((p) => `green run: ${p}`))
      }
      result.passed = result.problems.length === 0 && !signal.aborted
      out(`  ${result.passed ? 'passed' : 'FAILED: ' + result.problems.join('; ')}`)
    }
  } finally {
    release()
    writeFileSync(join(root, 'report.md'), controlsReport(time, hash, results))
    writeFileSync(join(root, 'report.json'), JSON.stringify(results, null, 1))
    out(`report: ${join(root, 'report.md')}`)
  }
  if (signal.aborted) throw new Exit(130, 'stopped before all controls were done')
  const failed = results.filter((r) => !r.passed)
  if (failed.length)
    throw new Exit(1, `${failed.length} control(s) failed: ${failed.map((r) => r.def.name).join(', ')}`)
  if (which === 'all' && specHash(SPEC_DIR) !== hash) {
    throw new Exit(1, 'all controls passed, but the spec changed while they ran: run them again')
  }
  if (which === 'all') {
    writeVerified(SPEC_DIR, {
      bombadil: BOMBADIL_VERSION,
      spec: hash,
      controls: Object.fromEntries(
        results.map((r) => [
          r.def.name,
          `${r.def.red.join(', ')} red${r.def.patch ? ` with ${r.def.patch}, nothing red without` : ''}`
        ])
      )
    })
    out(
      'all controls passed; features/explore/controls/verified.json records this spec — commit it with the spec'
    )
  } else out(`control ${which} passed (verified.json is written only when all controls run)`)
}

function controlsReport(time: string, hash: string, results: ControlResult[]): string {
  const lines = [
    `# Positive controls of the exploring spec — ${time}`,
    '',
    `Spec ${hash.slice(0, 12)}; Bombadil ${BOMBADIL_VERSION}.`,
    ''
  ]
  lines.push('| Control | Red | Verdict |', '|---|---|---|')
  for (const r of results)
    lines.push(`| ${r.def.name} | ${r.def.red.join(', ')} | ${r.passed ? 'passed' : 'FAILED'} |`)
  lines.push('')
  for (const r of results) {
    lines.push(`## ${r.def.name}: ${r.passed ? 'passed' : 'FAILED'}`, '', r.def.about + '.', '')
    for (const p of r.problems) lines.push(`- **${p}**`)
    for (const run of r.runs) {
      lines.push('', `### ${run.label}`, '')
      for (const f of findingsOf(run)) lines.push(`- red: **${f.title}**`, ...f.lines.map((l) => `  - ${l}`))
      lines.push(...runLines(run, run.dir.split(/[/\\]/).slice(-1)[0]))
    }
    lines.push('')
  }
  return lines.join('\n')
}
