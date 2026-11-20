/**
 * Which Python the driven app's backend runs on. An unpackaged app starts it as `uv run prism-lca-backend`
 * in `backend/` next to its `frontend/`. In the main checkout, or in a worktree with an environment of its
 * own, that is right as it is. A worktree without one would have uv create a fresh environment on the first
 * start (minutes, gigabytes), and a worktree whose `.venv` is a link to the main checkout's lets uv re-sync
 * the main environment's editable install onto the worktree — after which every other session's backend
 * runs this worktree's code.
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
  /** Directory to put first on PATH (shim only). */
  pathDir?: string
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

/** The checkout that owns the git directory: the main checkout, also when called from a worktree. */
export function mainCheckout(frontend: string): string {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: frontend,
    encoding: 'utf8'
  }).trim()
  return dirname(common)
}

function entryPoint(venv: string): string {
  return join(venv, 'bin', 'prism-lca-backend')
}

export function planBackend(frontend: string, binDir: string): BackendPlan {
  const backend = resolve(frontend, '..', 'backend')
  const main = mainCheckout(frontend)
  if (resolve(main, 'backend') === backend) {
    return { via: 'own', detail: `uv run in the main checkout (${backend})` }
  }
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
  const src = join(backend, 'src')
  mkdirSync(binDir, { recursive: true })
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  writeFileSync(join(binDir, 'uv'), `#!/bin/sh\nPYTHONPATH=${q(src)} exec ${q(entry)}\n`)
  chmodSync(join(binDir, 'uv'), 0o755)
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
    pathDir: binDir,
    warning
  }
}

export function withPathFirst(dir: string, path: string | undefined): string {
  return path ? `${dir}${delimiter}${path}` : dir
}
