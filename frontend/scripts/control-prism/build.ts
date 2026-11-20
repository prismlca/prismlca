/**
 * Whether `out/` holds the build of the checkout as it is now — the first thing a proof depends on. A
 * driven app shows what was built, not what was written, and a run against an old build proves nothing.
 *
 * Two fingerprints: one of the sources the build reads (`git ls-files`, so new untracked files count and
 * ignored ones do not; test files are left out, a test changes no build), one of `out/` itself. `build`
 * records both in a stamp; afterwards the build is current while the sources still hash to the stamp's
 * value and `out/` has not been rebuilt by anything else. The stamp lives in `.cache/control-prism/`,
 * never in `out/`, which electron-builder packs into the installer as it is.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { listProcesses } from '../../e2e/processes'

/** What electron-vite reads: the four source trees, the assets, the house theme the renderer's CSS imports
 *  from outside frontend/, and the configuration around them. */
export const BUILD_INPUTS = [
  'src',
  'resources',
  '../design',
  'electron.vite.config.ts',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json'
]

/** Unit tests are never bundled; editing one must not make a build stale. */
export function isBuildInput(path: string): boolean {
  return !/\.test\.[cm]?[jt]sx?$/.test(path)
}

export interface Stamp {
  /** Fingerprint of the sources the build was made from. */
  src: string
  /** Fingerprint of `out/` right after the build. */
  out: string
  builtAt: string
}

function sha(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** One hash over (path, content) pairs, independent of the order they were found in. */
export function fingerprint(files: { path: string; content: Buffer }[]): string {
  const h = createHash('sha256')
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(f.path).update('\0').update(sha(f.content)).update('\n')
  }
  return h.digest('hex')
}

/** Paths as git sees them, relative to `frontend`: tracked and untracked, without what .gitignore excludes. */
function listedPaths(frontend: string, inputs: string[]): string[] {
  const listed = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard', '--', ...inputs], {
    cwd: frontend,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  return listed.split('\0').filter((p) => p !== '' && isBuildInput(p))
}

function fingerprintOf(frontend: string, inputs: string[]): string {
  return fingerprint(
    listedPaths(frontend, inputs)
      // A file deleted from the working tree but still in the index is listed and gone: it is not an input.
      .filter((p) => existsSync(join(frontend, p)))
      .map((p) => ({ path: p, content: readFileSync(join(frontend, p)) }))
  )
}

export function sourceFingerprint(frontend: string): string {
  return fingerprintOf(frontend, BUILD_INPUTS)
}

/** What the backend runs from source: a change here reaches the app only with a restart, no build. */
export const BACKEND_INPUTS = ['../backend/src', '../backend/pyproject.toml', '../backend/uv.lock']

export function backendFingerprint(frontend: string): string {
  return fingerprintOf(frontend, BACKEND_INPUTS)
}

function walk(dir: string, root: string, into: { path: string; content: Buffer }[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, root, into)
    else if (e.isFile())
      into.push({ path: relative(root, full).split(sep).join('/'), content: readFileSync(full) })
  }
}

/** Fingerprint of `out/`, or null when there is no build at all. */
export function outFingerprint(frontend: string): string | null {
  const out = join(frontend, 'out')
  if (!existsSync(out)) return null
  const files: { path: string; content: Buffer }[] = []
  walk(out, out, files)
  return files.length === 0 ? null : fingerprint(files)
}

export function stampPath(frontend: string): string {
  return join(frontend, '.cache', 'control-prism', 'build.json')
}

export function readStamp(frontend: string): Stamp | null {
  try {
    return JSON.parse(readFileSync(stampPath(frontend), 'utf8')) as Stamp
  } catch {
    return null
  }
}

export type BuildState =
  | { current: true; stamp: Stamp }
  | { current: false; reason: string; stamp: Stamp | null }

/** Compares what is on disk now with the stamp of the last build. Pure, so it can be tested. */
export function judgeBuild(stamp: Stamp | null, src: string, out: string | null): BuildState {
  if (out === null) return { current: false, reason: 'there is no build in out/', stamp }
  if (stamp === null)
    return { current: false, reason: 'out/ was not built by control-prism, so its source is unknown', stamp }
  if (stamp.out !== out)
    return { current: false, reason: 'out/ changed after control-prism built it (another build ran)', stamp }
  if (stamp.src !== src) return { current: false, reason: 'the sources changed since the last build', stamp }
  return { current: true, stamp }
}

export function buildState(frontend: string): BuildState {
  return judgeBuild(readStamp(frontend), sourceFingerprint(frontend), outFingerprint(frontend))
}

/**
 * A dev server watching this same `frontend/` dies when `out/` is rebuilt under it, and with it the app
 * someone is using. Only processes whose command line names this checkout's own electron-vite count; a
 * worktree's node_modules link resolves to another checkout and never matches.
 */
export function devServerHere(frontend: string): string | null {
  const own = join(frontend, 'node_modules', '.bin', 'electron-vite')
  const own2 = join(frontend, 'node_modules', 'electron-vite')
  const dev = listProcesses().find(
    (p) => (p.command.includes(own) || p.command.includes(own2)) && / dev\b/.test(p.command)
  )
  return dev ? `pid ${dev.pid}: ${dev.command.slice(0, 160)}` : null
}

/** Builds `out/` with electron-vite and stamps it. Returns the stamp; throws with the build's output on failure. */
export function build(frontend: string, log: (line: string) => void): Stamp {
  const dev = devServerHere(frontend)
  if (dev) {
    throw new Error(
      `a dev server runs from this checkout (${dev}); building out/ under it would end it and the app it ` +
        `serves. Work in a worktree of your own, or stop that dev server first.`
    )
  }
  const before = sourceFingerprint(frontend)
  log('building out/ with electron-vite …')
  const started = Date.now()
  const bin = join(frontend, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
  const r = spawnSync(process.execPath, [bin, 'build'], {
    cwd: frontend,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  })
  if (r.status !== 0) {
    throw new Error(
      `electron-vite build failed (exit ${r.status}):\n${(r.stdout + r.stderr).split('\n').slice(-30).join('\n')}`
    )
  }
  const out = outFingerprint(frontend)
  if (out === null) throw new Error('electron-vite build finished but out/ is empty')
  // The fingerprint taken BEFORE the build: a file saved while it ran makes the stamp disagree with the
  // sources, so the next check rebuilds instead of trusting a build of a mix.
  const stamp: Stamp = { src: before, out, builtAt: new Date().toISOString() }
  mkdirSync(join(frontend, '.cache', 'control-prism'), { recursive: true })
  writeFileSync(stampPath(frontend), JSON.stringify(stamp, null, 2))
  log(`built in ${((Date.now() - started) / 1000).toFixed(1)} s`)
  if (sourceFingerprint(frontend) !== before)
    log('note: sources changed during the build; it counts as stale already')
  return stamp
}
