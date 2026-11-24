/**
 * How the backend of an app started from a checkout runs, on a throwaway repository with a main checkout and
 * a worktree: the main checkout and a worktree with an environment of its own run `uv` as it is, any other
 * worktree borrows the main checkout's environment through a shim — which is run here for real.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { backendEnv, planBackend } from './backend'

const windows = process.platform === 'win32'

describe('planBackend', () => {
  let root: string
  let main: string
  let worktree: string

  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', ...args], {
      cwd,
      stdio: 'ignore'
    })
  }
  /** A backend entry point that prints the import path it got and the arguments it was given. */
  const entryOf = (checkout: string): string => join(checkout, 'backend', '.venv', 'bin', 'prism-lca-backend')

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'prism-backend-plan-')))
    main = join(root, 'main')
    worktree = join(root, 'wt')
    for (const dir of ['frontend', 'backend/src']) mkdirSync(join(main, dir), { recursive: true })
    writeFileSync(join(main, 'backend', 'uv.lock'), 'lock 1\n')
    git(main, 'init', '-q')
    git(main, 'add', '.')
    git(main, 'commit', '-q', '-m', 'start')
    git(main, 'worktree', 'add', '-q', worktree)
    mkdirSync(join(worktree, 'frontend'), { recursive: true })
    mkdirSync(join(worktree, 'backend', 'src'), { recursive: true })
    const entry = entryOf(main)
    mkdirSync(join(entry, '..'), { recursive: true })
    writeFileSync(entry, '#!/bin/sh\necho "PYTHONPATH=$PYTHONPATH args=$*"\n')
    chmodSync(entry, 0o755)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('runs uv as it is in the main checkout', () => {
    const plan = planBackend(join(main, 'frontend'))
    expect(plan.via).toBe('own')
    expect(plan.detail).toContain('main checkout')
    expect(backendEnv(plan, join(root, 'bin'))).toEqual({})
  })

  it('knows the main checkout however its path is spelled', () => {
    // Reached through a link, as a Windows short name (RUNNER~1) spells the same folder differently.
    const alias = join(root, 'alias')
    symlinkSync(main, alias, 'junction')
    const plan = planBackend(join(alias, 'frontend'))
    expect(plan.detail).toContain('main checkout')
  })

  it('takes a worktree for a worktree also when GIT_DIR names the main repository', () => {
    // As inside a git hook; uv would re-sync the linked environment if this counted as the main checkout.
    symlinkSync(join(main, 'backend', '.venv'), join(worktree, 'backend', '.venv'), 'junction')
    vi.stubEnv('GIT_DIR', join(main, '.git'))
    try {
      expect(planBackend(join(worktree, 'frontend')).detail).not.toContain('uv run in the main checkout')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('runs uv as it is in a worktree with an environment of its own', () => {
    mkdirSync(join(worktree, 'backend', '.venv'))
    const plan = planBackend(join(worktree, 'frontend'))
    expect(plan.via).toBe('own')
    expect(plan.warning).toBeUndefined()
    expect(plan.detail).toContain("worktree's own environment")
  })

  it('runs uv as it is outside a git checkout', () => {
    const loose = join(root, 'unpacked')
    mkdirSync(join(loose, 'frontend'), { recursive: true })
    const plan = planBackend(join(loose, 'frontend'))
    expect(plan.via).toBe('own')
    expect(plan.detail).toContain('not a git checkout')
  })

  it('refuses when git cannot answer for a checkout, rather than letting uv run', () => {
    // A worktree whose link to the repository is broken; uv would re-sync the linked environment. Git for
    // Windows marks the `.git` file hidden, and Windows will not open a hidden file for overwriting: replace it.
    rmSync(join(worktree, '.git'))
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(root, 'gone')}\n`)
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    symlinkSync(join(main, 'backend', '.venv'), join(worktree, 'backend', '.venv'), 'junction')
    expect(() => planBackend(join(worktree, 'frontend'))).toThrow(/git could not say which checkout/)
  })

  it.runIf(windows)('warns on Windows that uv will build an environment in a worktree without one', () => {
    const plan = planBackend(join(worktree, 'frontend'))
    expect(plan.via).toBe('own')
    expect(plan.warning).toContain('uv creates one')
  })

  describe.skipIf(windows)('a worktree without an environment of its own', () => {
    it("borrows the main checkout's environment with the worktree's code first", () => {
      const plan = planBackend(join(worktree, 'frontend'))
      expect(plan.via).toBe('shim')
      expect(plan.shim).toEqual({ entry: entryOf(main), src: join(worktree, 'backend', 'src') })
      expect(plan.warning).toBeUndefined()

      const bin = join(root, 'install', 'bin')
      const env = backendEnv(plan, bin)
      expect(env.PATH?.split(delimiter)[0]).toBe(bin)
      // The app runs `uv run prism-lca-backend`; the shim ignores those words and starts the entry point.
      const said = execFileSync('uv', ['run', 'prism-lca-backend'], {
        env: { ...process.env, ...env, PYTHONPATH: '/somewhere/else' },
        encoding: 'utf8'
      })
      expect(said.trim()).toBe(`PYTHONPATH=${join(worktree, 'backend', 'src')} args=`)
    })

    it('borrows it also when the worktree links to the main environment', () => {
      // uv would re-sync the linked environment onto the worktree, for every other session too.
      symlinkSync(join(main, 'backend', '.venv'), join(worktree, 'backend', '.venv'))
      expect(planBackend(join(worktree, 'frontend')).via).toBe('shim')
    })

    it("warns when the worktree's dependency lock differs", () => {
      writeFileSync(join(worktree, 'backend', 'uv.lock'), 'lock 2\n')
      expect(planBackend(join(worktree, 'frontend')).warning).toContain('uv.lock differs')
    })

    it('refuses when the main checkout has no environment to lend', () => {
      rmSync(join(main, 'backend', '.venv'), { recursive: true })
      expect(() => planBackend(join(worktree, 'frontend'))).toThrow(/main checkout has none to borrow/)
    })
  })
})
