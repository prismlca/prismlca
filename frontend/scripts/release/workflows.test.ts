/**
 * The release-workflow rules, checked on every workflow file in .github/workflows
 * (also the `.disabled` ones, which become live in the new repo). A rule here is cheaper than a review
 * that has to catch it:
 *  - every action pinned to a full commit SHA, so a moved tag cannot change what runs;
 *  - `pull_request_target` only in the CLA workflow (it must answer pull requests from forks);
 *  - the self-hosted release runner (label prism-release-win) only in the release workflow, and never
 *    in a workflow a pull request can start — labels route jobs, they do not protect the runner;
 *  - no workflow publishes a release: drafts only, the maintainer publishes;
 *  - the release workflow starts only on tags and by hand, denies all permissions at the top, and every
 *    checkout keeps no credentials.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// js-yaml comes with electron-updater; no extra dependency for one test.
const yaml = createRequire(import.meta.url)('js-yaml') as { load: (s: string) => unknown }

type Step = { uses?: string; run?: string; with?: Record<string, unknown> }
type Job = { 'runs-on'?: unknown; permissions?: unknown; steps?: Step[] }
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

  it.each(files)('%s never publishes a release', (f) => {
    const { text } = load(f)
    expect(text).not.toMatch(/--draft=false|draft:\s*false|make_latest|gh release edit/)
    expect(text).not.toMatch(/electron-builder[^\n]*--publish (always|onTag)/)
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
})
