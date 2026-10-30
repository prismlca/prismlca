/**
 * The release script's decisions: the next version is chosen, never
 * guessed; the previous release is the last one PUBLISHED; the changelog draft cannot go out unread.
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM without types, run by node directly
import * as lib from './lib.mjs'

describe('the release script', () => {
  it('counts up only what it is told to', () => {
    expect(lib.nextVersion('0.8.0', 'minor')).toBe('0.9.0')
    expect(lib.nextVersion('0.9.0', 'patch')).toBe('0.9.1')
    expect(lib.nextVersion('0.9.1', 'minor')).toBe('0.10.0')
    expect(lib.nextVersion('0.9.1', '1.0.0')).toBe('1.0.0')
    expect(() => lib.nextVersion('0.9.0', undefined)).toThrow(/never guesses/)
    expect(() => lib.nextVersion('0.9.0', '0.9.0')).toThrow(/not higher/)
  })

  it('takes the last PUBLISHED stable release as the previous one, not the first in the list', () => {
    const releases = [
      { tag_name: 'v0.9.2', draft: false, prerelease: false, published_at: '2026-11-02T10:00:00Z' },
      { tag_name: 'v0.9.3', draft: true, prerelease: false, published_at: null },
      { tag_name: 'v0.0.0-spike.1', draft: false, prerelease: false, published_at: '2026-12-01T00:00:00Z' },
      { tag_name: 'v0.9.1', draft: false, prerelease: false, published_at: '2026-11-20T09:00:00Z' }
    ]
    expect(lib.pickPreviousRelease(releases)).toEqual({ tag: 'v0.9.1', publishedAt: '2026-11-20T09:00:00Z' })
    expect(lib.pickPreviousRelease([])).toBeNull()
  })

  it('drafts the section from What\'s new after the previous release, with TODO lines that stop the run', () => {
    const entries = [
      { date: '2026-11-25', title: 'Late feature' },
      { date: '2026-11-20', title: 'Same day as the release' },
      { date: '2026-11-01', title: 'Old feature' }
    ]
    const since = lib.whatsNewSince(entries, '2026-11-20T09:00:00Z')
    expect(since.map((e: { title: string }) => e.title)).toEqual(['Late feature'])
    const section = lib.changelogSection({
      version: '0.9.2',
      date: '2026-11-30',
      previous: { tag: 'v0.9.1' },
      entries: since,
      repoUrl: 'https://github.com/prismlca/prismlca'
    })
    expect(section).toContain('## 0.9.2 — 2026-11-30')
    expect(section).toContain('https://github.com/prismlca/prismlca/compare/v0.9.1...v0.9.2')
    expect(section).toContain('- Late feature')
    expect(section).toContain(lib.TODO)
  })

  it('asks for hand-written notes on the first release and keeps older sections below', () => {
    const first = lib.changelogSection({ version: '0.9.0', date: '2026-10-22', previous: null, entries: [], repoUrl: 'x' })
    expect(first).toContain('First public beta.')
    expect(first).toContain(lib.TODO)
    const merged = lib.insertSection('# Changelog\n\n## 0.8.0 — old\n', '## 0.9.0 — new\n')
    expect(merged).toBe('# Changelog\n\n## 0.9.0 — new\n\n## 0.8.0 — old\n')
    // The paragraph that introduces the file stays on top, also before the very first section.
    const intro = '# Changelog\n\nEvery release, newest first.\n'
    expect(lib.insertSection(intro, '## 0.9.0 — new\n')).toBe(`${intro}\n## 0.9.0 — new\n`)
    expect(lib.insertSection(`${intro}\n## 0.9.0 — new\n`, '## 0.9.1 — newer\n')).toBe(
      `${intro}\n## 0.9.1 — newer\n\n## 0.9.0 — new\n`
    )
  })
})

describe('commits as raw material for the Fixes', () => {
  it('leaves out release commits, merges and documentation-only commits', () => {
    expect(
      lib.commitSuggestions([
        'release: v0.9.3',
        'Merge PR #4: something',
        'docs: record a test',
        'docs(umzug): runbook',
        'Update page: a failed download says what failed',
        'fix(website): privacy page always light'
      ])
    ).toEqual(['Update page: a failed download says what failed', 'fix(website): privacy page always light'])
  })

  it('lists them in the draft, every line marked so none can be published unread', () => {
    const section = lib.changelogSection({
      version: '0.9.4',
      date: '2026-10-31',
      previous: { tag: 'v0.9.3', publishedAt: '2026-10-30T12:00:00Z' },
      entries: [],
      repoUrl: 'https://github.com/prismlca/prismlca',
      commits: ['Update page: a failed download says what failed']
    })
    const raw = section.split('\n').filter((l) => l.includes('Update page'))
    expect(raw).toHaveLength(1)
    expect(raw[0].startsWith(lib.TODO)).toBe(true)
    expect(section).toContain('the commits since v0.9.3')
  })
})

describe('the update feed', () => {
  const feed = (url: string): { name: string; text: string }[] => [
    { name: 'latest.yml', text: `version: 0.9.2\nfiles:\n  - url: ${url}\n    sha512: x\npath: ${url}\n` }
  ]

  it('passes when every file the feed names is among the release files', () => {
    const files = ['PrismLCA-Setup-0.9.3.exe', 'PrismLCA-Setup-0.9.3.exe.blockmap', 'latest.yml']
    expect(lib.feedProblems(feed('PrismLCA-Setup-0.9.3.exe'), files)).toEqual([])
  })

  it('catches what broke 0.9.2: a name with spaces that GitHub renames, and a feed naming another file', () => {
    const problems = lib.feedProblems(feed('PrismLCA-Setup-0.9.2.exe'), ['PrismLCA Setup 0.9.2.exe', 'latest.yml'])
    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toMatch(/has a space/)
    expect(problems.join('\n')).toMatch(/latest\.yml names PrismLCA-Setup-0\.9\.2\.exe/)
  })

  it('reads quoted names and the Linux feed with two files', () => {
    const linux = [
      {
        name: 'latest-linux.yml',
        text: "files:\n  - url: 'PrismLCA-0.9.3.AppImage'\n  - url: prism-lca_0.9.3_amd64.deb\npath: PrismLCA-0.9.3.AppImage\n"
      }
    ]
    expect(lib.feedProblems(linux, ['PrismLCA-0.9.3.AppImage'])).toEqual([
      'latest-linux.yml names prism-lca_0.9.3_amd64.deb, which is not among the release files'
    ])
  })
})

describe('the release workflow checks', () => {
  it('builds only from a vX.Y.Z tag that every version source agrees with', () => {
    expect(lib.checkReleaseRef('refs/tags/v0.9.0', '0.9.0', '0.9.0')).toBeNull()
    expect(lib.checkReleaseRef('refs/heads/main', '0.9.0', '0.9.0')).toMatch(/only from a tag/)
    expect(lib.checkReleaseRef('refs/tags/v0.9.0-spike.1', '0.9.0', '0.9.0')).toBeNull()
    expect(lib.checkReleaseRef('refs/tags/v0.0.0-spike.1', '0.9.0', '0.9.0')).toMatch(/frontend\/package.json says 0.9.0/)
    expect(lib.checkReleaseRef('refs/tags/v0.9.0-rc.1', '0.9.0', '0.9.0')).toMatch(/only from a tag/)
    expect(lib.isSpike('0.9.0-spike.2')).toBe(true)
    expect(lib.isSpike('0.9.0')).toBe(false)
    expect(lib.checkReleaseRef('refs/tags/v0.9.0', '0.9.0', '0.8.0')).toMatch(/pyproject.toml 0.8.0/)
  })

  it('blocks an unsupported or unpatched Electron and warns on the oldest line', () => {
    const tags = { latest: '44.9.1', '44-x-y': '44.9.1', '43-x-y': '43.8.1', '42-x-y': '42.11.16', '41-x-y': '41.10.7' }
    expect(lib.electronSupport('44.9.1', tags)).toEqual({ block: [], warn: [] })
    expect(lib.electronSupport('44.9.0', tags).block[0]).toMatch(/behind its line's newest patch 44.9.1/)
    expect(lib.electronSupport('41.10.7', tags).block[0]).toMatch(/out of support/)
    expect(lib.electronSupport('42.11.16', tags).warn[0]).toMatch(/oldest supported line/)
  })

  it('blocks open shipped advisories, accepts assessed ones until they expire, lists build-only ones', () => {
    const findings = [
      { id: 'A', package: 'echarts', severity: 'moderate', shipped: true },
      { id: 'B', package: 'urllib3', severity: 'unrated', shipped: true },
      { id: 'C', package: 'vite', severity: 'high', shipped: false },
      { id: 'D', package: 'esbuild', severity: 'critical', shipped: false },
      { id: 'E', package: 'deepdiff', severity: 'unrated', shipped: true }
    ]
    const exceptions = [
      { id: 'A', package: 'echarts', reason: 'not reachable', expires: '2027-01-31' },
      { id: 'E', package: 'deepdiff', reason: 'pinned', expires: '2026-01-01' },
      { id: 'Z', package: 'old', reason: 'gone', expires: '2027-01-31' }
    ]
    const v = lib.auditVerdict(findings, exceptions, '2026-10-22')
    expect(v.blocked.map((f: { id: string }) => f.id).sort()).toEqual(['B', 'D', 'E'])
    expect(v.accepted.map((f: { id: string }) => f.id)).toEqual(['A'])
    expect(v.reported.map((f: { id: string }) => f.id)).toEqual(['C'])
    expect(v.expired.map((e: { id: string }) => e.id)).toEqual(['E'])
    expect(v.stale.map((e: { id: string }) => e.id)).toEqual(['Z'])
  })

  it('audits the whole locked Python closure: every platform, plain versions, exact pins only', () => {
    const exported = [
      'colorama==0.4.6 ; sys_platform == \'win32\'',
      'torch==2.9.1 ; sys_platform == \'darwin\'',
      'torch==2.9.1+cpu ; sys_platform != \'darwin\'',
      'numpy==2.5.1',
      '# via something',
      './vendor/local-pkg',
      'some-git-pkg @ git+https://example.org/x.git'
    ].join('\n')
    const { pins, unpinned } = lib.auditRequirements(exported)
    expect(pins).toEqual(['colorama==0.4.6', 'numpy==2.5.1', 'torch==2.9.1'])
    expect(unpinned).toEqual(['./vendor/local-pkg', 'some-git-pkg @ git+https://example.org/x.git'])
    expect(lib.pyName('Win32_SetCTime')).toBe('win32-setctime')
  })

  it('takes a failed audit request for a failure, never for a clean result', () => {
    const report = JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {} })
    expect(lib.npmAuditReport(report).vulnerabilities).toEqual({})
    const error = JSON.stringify({ error: { code: 'ENOTFOUND', summary: 'request failed' } })
    expect(() => lib.npmAuditReport(error)).toThrow(/npm audit failed: .*ENOTFOUND/)
    expect(() => lib.npmAuditReport('')).toThrow(/no report/)

    const pins = ['numpy==2.5.1', 'win32-setctime==1.2.0']
    const pip = { dependencies: [{ name: 'numpy', version: '2.5.1', vulns: [] }] }
    expect(() => lib.pipAuditReport(JSON.stringify(pip), pins)).toThrow(/did not report on win32-setctime/)
    pip.dependencies.push({ name: 'Win32_SetCTime', version: '1.2.0', vulns: [] })
    expect(lib.pipAuditReport(JSON.stringify(pip), pins).dependencies).toHaveLength(2)
    expect(() => lib.pipAuditReport('{"error":"offline"}', pins)).toThrow(/pip-audit failed/)
  })

  it('cuts one version out of CHANGELOG.md as release notes', () => {
    const log = '# Changelog\n\n## 0.9.1 — 2026-11-01\n\nFixes.\n\n## 0.9.0 — 2026-10-22\n\nFirst public beta.\n'
    expect(lib.notesFor(log, '0.9.0')).toBe('First public beta.')
    expect(lib.notesFor(log, '0.9.1')).toBe('Fixes.')
    expect(lib.notesFor(log, '1.0.0')).toBeNull()
  })
})
