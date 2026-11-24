/**
 * Which Python the backend of an app started from this checkout runs on — for the end-to-end tests and for
 * control-prism alike, since both start the app through launch() in app.ts. An unpackaged app starts its
 * backend as `uv run prism-lca-backend` in `backend/` next to its `frontend/`. In the main checkout, or in a
 * worktree with an environment of its own, that is right as it is. A worktree without one would have uv
 * create a fresh environment on the first start (minutes, gigabytes), and a worktree whose `.venv` is a
 * link to the main checkout's lets uv re-sync the main environment's editable install onto the worktree —
 * after which every other session's backend runs this worktree's code.
 *
 * So in a worktree without its own real `.venv`, a small `uv` placed first on PATH runs the main checkout's
 * installed backend entry point with this worktree's `backend/src` first on PYTHONPATH (ahead of the
 * editable install's path file), and touches no environment. Linux and macOS only: on Windows the app
 * starts `uv` without a shell, which finds no script in its place, so a worktree there needs its own.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'

export interface BackendPlan {
  via: 'own' | 'shim'
  detail: string
  /** What the shim runs (shim only): the main checkout's backend entry point, with `src` first on PYTHONPATH. */
  shim?: { entry: string; src: string }
  /** Set when the worktree's dependency lock differs from the environment it borrows. */
  warning?: string
}

function isRealDir(path: string): boolean {
  try {
    const s = lstatSync(path)
    return s.isDirectory() && !s.isSymbolicLink()
  } catch {
    return false
  }
}

/** The main checkout that owns the git directory (also when asked from a worktree), and whether `frontend`
 *  lies in that main checkout itself. Both answers come from git in one form, so neither depends on how a
 *  path is spelled: Windows short names (`RUNNER~1`) or drive-letter case, links on the way elsewhere.
 *  Git finds the repository from `frontend` alone: an inherited GIT_DIR (set inside git hooks, for one)
 *  would have it answer for another checkout, and take a worktree for the main one. */
function checkoutOf(frontend: string): { main: string; isMain: boolean } {
  const env = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE']) delete env[name]
  const [gitDir, common] = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    { cwd: frontend, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
    .trim()
    .split(/\r?\n/)
  return { main: dirname(common), isMain: gitDir === common }
}

function entryPoint(venv: string): string {
  return join(venv, 'bin', 'prism-lca-backend')
}

/** Decides how the backend of an app started from `frontend` will run. Writes nothing (see backendEnv). */
export function planBackend(frontend: string): BackendPlan {
  const backend = resolve(frontend, '..', 'backend')
  // Sources without git (an unpacked archive) have no worktrees and nothing to borrow from. Only the missing
  // `.git` says so: a worktree where git fails must not fall back to `uv run`, which would build or re-sync
  // the very environment the shim keeps away from.
  if (!existsSync(resolve(frontend, '..', '.git'))) {
    return { via: 'own', detail: `uv run in ${backend} (not a git checkout)` }
  }
  let checkout: { main: string; isMain: boolean }
  try {
    checkout = checkoutOf(frontend)
  } catch (e) {
    const why = (e as { stderr?: string }).stderr?.trim() || (e as Error).message
    throw new Error(`git could not say which checkout ${resolve(frontend, '..')} belongs to: ${why}`)
  }
  if (checkout.isMain) {
    return { via: 'own', detail: `uv run in the main checkout (${backend})` }
  }
  const main = checkout.main
  if (isRealDir(join(backend, '.venv'))) {
    return { via: 'own', detail: `uv run on the worktree's own environment (${join(backend, '.venv')})` }
  }
  if (process.platform === 'win32') {
    // The app starts `uv` without a shell, and Windows finds no .cmd that way: a shim cannot stand in.
    return {
      via: 'own',
      detail: 'uv run in the worktree',
      warning:
        'this worktree has no backend environment of its own; on Windows uv creates one on the first start ' +
        '(minutes). Run `uv sync --extra dev` in backend/ beforehand to see it happen.'
    }
  }
  const entry = entryPoint(join(main, 'backend', '.venv'))
  if (!existsSync(entry)) {
    throw new Error(
      `this worktree has no backend environment of its own and the main checkout has none to borrow ` +
        `(${entry} is missing). Create one here with \`uv sync --extra dev\` in backend/.`
    )
  }
  let warning: string | undefined
  try {
    if (
      readFileSync(join(backend, 'uv.lock'), 'utf8') !==
      readFileSync(join(main, 'backend', 'uv.lock'), 'utf8')
    ) {
      warning =
        "backend/uv.lock differs from the main checkout's: the borrowed environment may lack a dependency " +
        'this branch needs. Create one here with `uv sync --extra dev` in backend/ if the backend fails.'
    }
  } catch {
    /* no lock to compare */
  }
  return {
    via: 'shim',
    detail: `the main checkout's environment with this worktree's backend/src first on PYTHONPATH`,
    shim: { entry, src: join(backend, 'src') },
    warning
  }
}

/** What the app's environment needs for its backend to run as planned: PATH led by the folder the shim is
 *  written to (`binDir`), or nothing to change. */
export function backendEnv(plan: BackendPlan, binDir: string): { PATH?: string } {
  if (!plan.shim) return {}
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, 'uv'), `#!/bin/sh\nPYTHONPATH=${q(plan.shim.src)} exec ${q(plan.shim.entry)}\n`)
  chmodSync(join(binDir, 'uv'), 0o755)
  const path = process.env.PATH
  return { PATH: path ? `${binDir}${delimiter}${path}` : binDir }
}
