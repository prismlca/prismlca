/**
 * The workflow rules, checked on every workflow file in .github/workflows
 * (also the `.disabled` ones, so a workflow is checked before it is switched on). A rule here is cheaper
 * than a review that has to catch it:
 *  - every action pinned to a full commit SHA, so a moved tag cannot change what runs;
 *  - every job with a time limit of its own;
 *  - `pull_request_target` only in the CLA workflow (it must answer pull requests from forks), and that
 *    workflow runs nothing from the pull request: default branch only, no token kept, no shell steps, and
 *    a short time limit;
 *  - the self-hosted release runner (label prism-release-win) only in the release workflow, and never
 *    in a workflow a pull request can start — labels route jobs, they do not protect the runner;
 *  - only the release workflow publishes, and only in the job behind the `release` environment — the
 *    maintainer's approval is the gate; electron-builder never publishes on its own;
 *  - the release workflow starts only on tags and by hand, denies all permissions at the top, and every
 *    checkout keeps no credentials.
 *  - Windows is built on the release VM, and the signing session opens only after everything that needs no
 *    key is built — the previous release's signed files included — and closes after the installer, also when a
 *    step failed; the final check covers every program file of the package.
 *  - Both builds start the packaged program's MCP bridge once, as a client does, after their start check —
 *    on Windows after the signing session has closed.
 *  - The tests on Windows restore the previous release's installer from main's Actions cache and never save one;
 *    only the cache workflow fills it, from main, without running anything from the repository.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// js-yaml comes with electron-updater; no extra dependency for one test.
const yaml = createRequire(import.meta.url)('js-yaml') as { load: (s: string) => unknown }

type Step = { uses?: string; run?: string; if?: string; with?: Record<string, unknown> }
type Job = {
  'runs-on'?: unknown
  'timeout-minutes'?: unknown
  uses?: string
  permissions?: unknown
  steps?: Step[]
}
type Workflow = { on?: Record<string, unknown>; permissions?: unknown; jobs?: Record<string, Job> }

const DIR = join(__dirname, '..', '..', '..', '.github', 'workflows')
const files = readdirSync(DIR).filter((f) => /\.ya?ml(\.disabled)?$/.test(f))
const load = (f: string): { text: string; wf: Workflow } => {
  const text = readFileSync(join(DIR, f), 'utf-8')
  return { text, wf: yaml.load(text) as Workflow }
}
// js-yaml reads a bare `on:` key as the boolean true.
const triggers = (wf: Workflow): Record<string, unknown> =>
  (wf.on ?? (wf as Record<string, unknown>)['true'] ?? {}) as Record<string, unknown>

describe('GitHub workflows', () => {
  it('has the release workflow to check', () => {
    expect(files.some((f) => f.startsWith('release.yml'))).toBe(true)
  })

  it.each(files)('%s pins every action to a commit SHA', (f) => {
    const { wf } = load(f)
    for (const job of Object.values(wf.jobs ?? {}))
      for (const step of job.steps ?? [])
        if (step.uses && !step.uses.startsWith('./')) expect(step.uses).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/)
  })

  it.each(files)('%s gives every job a time limit', (f) => {
    for (const [name, job] of Object.entries(load(f).wf.jobs ?? {}))
      // A job that calls a reusable workflow cannot set one; the called workflow's jobs do.
      if (!job.uses) expect(job['timeout-minutes'], `${name} sets timeout-minutes`).toBeGreaterThan(0)
  })

  it.each(files)('%s uses pull_request_target only if it is the CLA workflow', (f) => {
    if ('pull_request_target' in triggers(load(f).wf)) expect(f).toMatch(/^cla\.ya?ml/)
  })

  it.each(files)('%s keeps the self-hosted release runner to the release workflow', (f) => {
    const { text, wf } = load(f)
    if (!text.includes('prism-release-win')) return
    expect(f).toMatch(/^release\.ya?ml/)
    const on = triggers(wf)
    expect(on).not.toHaveProperty('pull_request')
    expect(on).not.toHaveProperty('pull_request_target')
  })

  const PUBLISHES = /--draft=false|draft:\s*false|make_latest|gh release edit/
  it.each(files)('%s publishes only behind the release environment', (f) => {
    const { text, wf } = load(f)
    expect(text).not.toMatch(/electron-builder[^\n]*--publish (always|onTag)/)
    for (const [name, job] of Object.entries(wf.jobs ?? {})) {
      const runs = (job.steps ?? []).map((s) => s.run ?? '').join('\n')
      if (!PUBLISHES.test(runs)) continue
      expect(f, `${name} publishes`).toMatch(/^release\.ya?ml/)
      expect((job as { environment?: unknown }).environment, `${name} publishes without the approval gate`).toBe(
        'release'
      )
    }
  })

  it('CLA workflow: runs nothing from the pull request — default branch only, no token kept, no shell', () => {
    const name = files.find((f) => /^cla\.ya?ml/.test(f))!
    const { wf } = load(name)
    expect(wf.permissions).toEqual({})
    for (const job of Object.values(wf.jobs ?? {})) {
      expect(job['timeout-minutes'], 'a short time limit').toBeLessThanOrEqual(10)
      for (const step of job.steps ?? []) {
        expect(step.run).toBeUndefined()
        if (step.uses?.startsWith('actions/checkout@')) {
          expect(step.with?.ref).toBe('${{ github.event.repository.default_branch }}')
          expect(step.with?.['persist-credentials']).toBe(false)
        }
      }
    }
  })

  it('release workflow: tags and manual starts only, no default permissions, no stored credentials', () => {
    const name = files.find((f) => f.startsWith('release.yml'))!
    const { wf } = load(name)
    const on = triggers(wf)
    expect(Object.keys(on).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(on.push).toEqual({ tags: ['v*'] })
    expect(wf.permissions).toEqual({})
    for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
      expect(job.permissions, `${jobName} states its permissions`).toBeDefined()
      for (const step of job.steps ?? [])
        if (step.uses?.startsWith('actions/checkout@'))
          expect(step.with?.['persist-credentials'], `${jobName}: checkout keeps no token`).toBe(false)
    }
    // Write access only in the one job that creates the draft.
    const writers = Object.entries(wf.jobs ?? {})
      .filter(([, job]) => (job.permissions as Record<string, string> | undefined)?.contents === 'write')
      .map(([n]) => n)
    expect(writers).toEqual(['draft'])
  })

  it('release workflow: Windows signs on the release VM, between the sign-in and the installer', () => {
    const name = files.find((f) => f.startsWith('release.yml'))!
    const job = load(name).wf.jobs!.windows
    expect(job['runs-on']).toEqual(['self-hosted', 'prism-release-win'])
    const steps = job.steps ?? []
    const at = (re: RegExp) => steps.findIndex((s) => re.test(s.run ?? ''))
    const order = [
      /pyinstaller/,
      /electron-vite build/,
      /sign-windows\.mjs previous/,
      /sign-windows\.mjs wait/,
      /electron-builder --win/,
      /Stop-Process/,
      /sign-windows\.mjs check/
    ].map(at)
    expect(order.every((i) => i >= 0), `steps found: ${order}`).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(steps[at(/Stop-Process/)].if, 'the session closes also after a failed step').toBe('always()')
  })

  it('release workflow: both builds start the packaged MCP bridge after their start check', () => {
    const name = files.find((f) => f.startsWith('release.yml'))!
    for (const jobName of ['linux', 'windows']) {
      const steps = load(name).wf.jobs![jobName].steps ?? []
      const at = (re: RegExp): number => steps.findIndex((s) => re.test(s.run ?? ''))
      expect(at(/PRISM_SMOKE=1/), `${jobName} has its start check`).toBeGreaterThanOrEqual(0)
      expect(at(/ci\.mjs bridge-check /), `${jobName} starts the bridge after it`).toBeGreaterThan(at(/PRISM_SMOKE=1/))
      if (jobName === 'windows')
        expect(at(/ci\.mjs bridge-check /), 'not while the signing session is open').toBeGreaterThan(at(/Stop-Process/))
    }
  })

  it('test workflow: Windows runs the reading half of the signing before a release does', () => {
    // What Windows says about a program file's signature needs no key. A release run was twice the first place
    // that script met a real Windows, and each time a tag was spent on it.
    const steps = load('ci.yml').wf.jobs!['test-windows'].steps ?? []
    const at = steps.findIndex((s) => /sign-windows\.mjs inspect-previous /.test(s.run ?? ''))
    expect(at).toBeGreaterThan(-1)
    // Early, and never skipped because another check failed: it is over in minutes.
    expect(at).toBeLessThan(steps.findIndex((s) => /vitest run/.test(s.run ?? '')))
    expect(steps[at].if).toBeUndefined()
    // The signing half follows with a throwaway certificate, in Windows PowerShell as on the release machine.
    const selftest = steps[at + 1] as Step & { shell?: string }
    expect(selftest.run).toMatch(/sign-windows-selftest\.ps1 -From /)
    expect(selftest.shell).toBe('powershell')
  })

  it("test workflow: the previous release's installer is restored from main's cache, never saved by a pull request", () => {
    // Every download from a release counts in its statistics, and this job runs on every pull request.
    const steps = load('ci.yml').wf.jobs!['test-windows'].steps ?? []
    const at = steps.findIndex((s) => /sign-windows\.mjs inspect-previous /.test(s.run ?? ''))
    const caches = steps.filter((s) => s.uses?.startsWith('actions/cache'))
    expect(caches.map((s) => s.uses!.split('@')[0])).toEqual(['actions/cache/restore'])
    const restore = steps.indexOf(caches[0])
    expect(restore).toBeLessThan(at)
    const { path } = caches[0].with as { path: string }
    expect(steps[at].run).toContain(`--cache "$RUNNER_TEMP/${path.split('/').pop()}"`)
    // The same entry the cache workflow saves: one key, one path, one platform.
    const warm = load('previous-installer-cache.yml').wf.jobs!.installer
    const saved = (warm.steps ?? []).find((s) => s.uses?.startsWith('actions/cache/save@'))!
    expect(saved.with).toEqual(caches[0].with)
    expect(warm['runs-on']).toBe(load('ci.yml').wf.jobs!['test-windows']['runs-on'])
  })

  it('cache workflow: only main fills it, on a schedule or by hand, and nothing from the repository runs there', () => {
    const { wf } = load('previous-installer-cache.yml')
    expect(Object.keys(triggers(wf)).sort()).toEqual(['schedule', 'workflow_dispatch'])
    expect(wf.permissions).toEqual({})
    const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? [])
    expect(steps.some((s) => s.uses?.startsWith('actions/checkout'))).toBe(false)
    // One download per release: the installer is fetched and saved only when the cache does not hold it yet —
    // looked up under the very key and path it is saved with, or every run would download it again.
    const lookup = steps.find((s) => s.uses?.startsWith('actions/cache/restore@'))!
    const saved = steps.find((s) => s.uses?.startsWith('actions/cache/save@'))!
    expect(lookup.with).toEqual({ ...saved.with, 'lookup-only': true })
    for (const s of steps.filter((s) => /gh release download/.test(s.run ?? '') || s === saved))
      expect(s.if).toBe("steps.cache.outputs.cache-hit != 'true'")
  })

  it('the signing self-test trusts its certificate on a hosted runner only, and the release never calls it', () => {
    const script = readFileSync(join(__dirname, 'sign-windows-selftest.ps1'), 'utf-8')
    expect(script).toMatch(/\$env:RUNNER_ENVIRONMENT -ne 'github-hosted'\) \{\s*throw /)
    expect(script.indexOf('RUNNER_ENVIRONMENT')).toBeLessThan(script.indexOf('New-SelfSignedCertificate'))
    for (const f of files.filter((f) => f.startsWith('release.yml'))) expect(load(f).text).not.toContain('selftest')
  })

  it('release workflow: the previous release is read before the sign-in, and every program file is checked', () => {
    const name = files.find((f) => f.startsWith('release.yml'))!
    const steps = load(name).wf.jobs!.windows.steps ?? []
    type EnvStep = Step & { env?: Record<string, string> }
    const step = (re: RegExp) => steps.find((s) => re.test(s.run ?? '')) as EnvStep
    const previous = step(/sign-windows\.mjs previous/)
    const build = step(/electron-builder --win/)
    // afterSign finds the copies where the step before the sign-in left them, and both count against one limit.
    expect(build.env?.PRISM_SIGN_PREVIOUS).toBe(previous.env?.PRISM_SIGN_PREVIOUS)
    expect(previous.env?.PRISM_SIGN_PREVIOUS).toMatch(/runner\.temp/)
    for (const s of [previous, build]) expect(s.env?.WINDOWS_SIGN_LIMIT).toBe('${{ vars.WINDOWS_SIGN_LIMIT }}')
    // The whole unpacked app, not a list of our own executables: nothing unsigned may ship.
    expect(step(/sign-windows\.mjs check/).run).toMatch(/sign-windows\.mjs check release\/win-unpacked release\/PrismLCA-Setup-\*\.exe/)
  })
})
