/**
 * The positive controls of the exploring spec (features/explore/controls/controls.json): every property the spec
 * ships is seen to go red once, where its condition is known to happen — or a green run would say nothing. A control
 * with a patch runs twice: on a throwaway build of this checkout with the patch applied (each property it names must
 * go red) and on this checkout as it is (nothing may go red). A control without a patch causes its conditions itself.
 * When all pass, controls/verified.json records the spec they passed on, and a test holds the spec to that record:
 * a changed spec runs its controls again before it explores.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { sha256 } from './bombadil'
import type { RunRecord } from './exploreRun'

export interface ControlDef {
  name: string
  about: string
  /** The control's spec, in controls/. */
  spec: string
  /** A change that brings a known bug back, in controls/; none when the spec causes its conditions itself. */
  patch?: string
  seconds: number
  /** control-prism command lines run after the model recipe. */
  prep?: string[]
  /** The properties that must go red; "backendLog" for an Unhandled error in the backend log. */
  red: string[]
}

export const BACKEND_LOG = 'backendLog'

export function readControls(specDir: string): ControlDef[] {
  return (
    JSON.parse(readFileSync(join(specDir, 'controls', 'controls.json'), 'utf8')) as { controls: ControlDef[] }
  ).controls
}

/** Files of the spec folder that are not the spec: its description and the record of the last passed controls. */
const NOT_SPEC = new Set(['README.md', 'controls/verified.json'])

/** The spec's files, relative and with "/" on every system, so the fingerprint is the same on Windows. */
function specFiles(specDir: string): string[] {
  return readdirSync(specDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(specDir, join(e.parentPath, e.name)).split(/[/\\]/).join('/'))
    .filter((f) => !NOT_SPEC.has(f))
    .sort()
}

/** A fingerprint of the spec: every file of the spec folder but README.md and verified.json, line ends unified. */
export function specHash(specDir: string): string {
  const parts = specFiles(specDir).map(
    (f) => `${f}\n${readFileSync(join(specDir, ...f.split('/')), 'utf8').replace(/\r\n/g, '\n')}`
  )
  return sha256(new TextEncoder().encode(parts.join('\u0000')))
}

export interface Verified {
  bombadil: string
  spec: string
  controls: Record<string, string>
}

export function readVerified(specDir: string): Verified | null {
  try {
    return JSON.parse(readFileSync(join(specDir, 'controls', 'verified.json'), 'utf8')) as Verified
  } catch {
    return null
  }
}

export function writeVerified(specDir: string, v: Verified): void {
  writeFileSync(join(specDir, 'controls', 'verified.json'), JSON.stringify(v, null, 2) + '\n')
}

/** The names a spec file defines with `export const`. */
export function definedNames(source: string): string[] {
  return [...source.matchAll(/^export const (\w+) =/gm)].map((m) => m[1])
}

/** The names a spec file re-exports from a module whose path ends in `from` (`export { a, b } from "…"`). */
export function reexported(source: string, from: string): string[] {
  const names: string[] = []
  for (const m of source.matchAll(/export \{([^}]*)\} from "([^"]+)"/g)) {
    if (!m[2].endsWith(from)) continue
    names.push(
      ...m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  }
  return names
}

/** The properties the spec ships: everything properties.ts defines or re-exports from Bombadil's defaults. */
export function shippedProperties(propertiesSource: string): string[] {
  return [...definedNames(propertiesSource), ...reexported(propertiesSource, '/defaults/properties')]
}

/** What a run that should have gone red did not show; empty when it did. */
export function missingRed(def: ControlDef, r: RunRecord): string[] {
  if (!r.digest) return [`the run has no trace to judge (${r.outcome}${r.why ? `: ${r.why}` : ''})`]
  const red = new Set(r.digest.violations.map((v) => v.property))
  const missing = def.red.filter((p) => (p === BACKEND_LOG ? r.backend.unhandled === 0 : !red.has(p)))
  return missing.map((p) =>
    p === BACKEND_LOG ? 'no Unhandled error in the backend log' : `${p} stayed green`
  )
}

/** What went red on the sound build; empty when nothing did. */
export function unexpectedRed(r: RunRecord): string[] {
  if (r.outcome !== 'complete') return [`the run is ${r.outcome}${r.why ? `: ${r.why}` : ''}`]
  return [
    ...(r.digest?.violations ?? []).map((v) => `${v.property} went red (${v.episodes} episode(s))`),
    ...(r.backend.unhandled > 0 ? [`${r.backend.unhandled} Unhandled error(s) in the backend log`] : [])
  ]
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A throwaway checkout of this checkout's HEAD with `patch` applied, in the main checkout's worktree folder, sharing
 *  this checkout's node_modules. Detached: no branch, nothing to push. `remove` deletes it again. */
export function throwawayBuild(
  frontend: string,
  patch: string,
  name: string
): { frontend: string; remove: () => void } {
  const main = dirname(git(frontend, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  const dir = join(main, '.claude', 'worktrees', name)
  if (existsSync(dir)) throw new Error(`${dir} exists already — a control of another run? Remove it first.`)
  git(frontend, ['worktree', 'add', '--detach', dir, 'HEAD'])
  const remove = (): void => {
    try {
      git(frontend, ['worktree', 'remove', '--force', dir])
    } catch {
      rmSync(dir, { recursive: true, force: true })
      git(frontend, ['worktree', 'prune'])
    }
  }
  try {
    symlinkSync(realpathSync(join(frontend, 'node_modules')), join(dir, 'frontend', 'node_modules'))
    git(dir, ['apply', patch])
  } catch (e) {
    remove()
    const why = (e as { stderr?: string }).stderr?.trim() || (e as Error).message
    throw new Error(`${relative(frontend, patch)} does not apply to HEAD: ${why}. Refresh the patch.`)
  }
  return { frontend: join(dir, 'frontend'), remove }
}
