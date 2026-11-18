/**
 * The Windows signature budget (sign-budget.mjs): how many new signatures a run may spend, and the estimate that
 * tells whoever makes a release beforehand whether it needs WINDOWS_SIGN_LIMIT — from the previous release's files
 * and what changed since its tag.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SIGN_LIMIT,
  changedPackages,
  estimateSignatures,
  lockedPackages,
  neededLimit,
  normalName,
  overLimit,
  pythonChange,
  recordEntries,
  signLimit
} from './sign-budget.mjs'

describe('the signature budget', () => {
  it('allows the default unless WINDOWS_SIGN_LIMIT names exactly this tag', () => {
    expect(signLimit(undefined, 'v1.0.0')).toEqual({ limit: DEFAULT_SIGN_LIMIT, override: false })
    expect(signLimit('', 'v1.0.0')).toEqual({ limit: DEFAULT_SIGN_LIMIT, override: false })
    expect(signLimit('v1.0.0=400', 'v1.0.0')).toEqual({ limit: 400, override: true })
    expect(signLimit(' v1.0.0-spike.2=12 ', 'v1.0.0-spike.2')).toEqual({ limit: 12, override: true })
    const stale = signLimit('v0.9.12=400', 'v1.0.0')
    expect(stale).toMatchObject({ limit: DEFAULT_SIGN_LIMIT, override: false })
    expect(stale.note).toMatch(/v0\.9\.12, not v1\.0\.0/)
  })

  it('refuses a WINDOWS_SIGN_LIMIT it cannot read rather than guessing', () => {
    for (const value of ['400', 'v1.0.0', 'v1.0.0=', 'v1.0.0=many', '1.0.0=400', 'v1.0.0=400,v1.0.1=400'])
      expect(() => signLimit(value, 'v1.0.0'), value).toThrow(/<tag>=<count>/)
  })

  it('says how to allow a larger run, for this tag only', () => {
    const text = overLimit(328, 150, 'v1.0.0', { owner: 'prismlca', repo: 'prismlca' })
    expect(text).toMatch(/^328 files need a new signature, more than the 150/)
    expect(text).toContain('gh variable set WINDOWS_SIGN_LIMIT -R prismlca/prismlca --body "v1.0.0=338"')
  })

  it('keeps the default well inside a month at the current release cadence', () => {
    // About 15 release runs a month, 5,000 signatures a month per certificate.
    expect(DEFAULT_SIGN_LIMIT * 15 + 5 * 15).toBeLessThan(5000)
  })
})

const lock = (...packages: [string, string, boolean][]) =>
  [
    'version = 1',
    'requires-python = "==3.12.*"',
    '',
    ...packages.map(([name, version, binary]) =>
      [
        '[[package]]',
        `name = "${name}"`,
        `version = "${version}"`,
        'source = { registry = "https://pypi.org/simple" }',
        'wheels = [',
        binary
          ? `    { url = "https://files.pythonhosted.org/${name}-${version}-cp312-cp312-win_amd64.whl", hash = "sha256:00" },`
          : `    { url = "https://files.pythonhosted.org/${name}-${version}-py3-none-any.whl", hash = "sha256:00" },`,
        ']',
        ''
      ].join('\n')
    )
  ].join('\n')

describe('what changed since the previous release', () => {
  it('reads every package of uv.lock, and whether it ships Windows binaries', () => {
    const packages = lockedPackages(lock(['numpy', '2.5.1', true], ['attrs', '26.1.0', false]))
    expect(packages.get('numpy')).toEqual({ version: '2.5.1', binary: true, wheels: 'sha256:00' })
    expect(packages.get('attrs')).toEqual({ version: '26.1.0', binary: false, wheels: '' })
  })

  it('lists packages that moved, appeared or went', () => {
    const before = lock(['numpy', '2.5.1', true], ['attrs', '26.1.0', false], ['old', '1.0', true])
    const after = lock(['numpy', '2.5.2', true], ['attrs', '26.1.0', false], ['new-pkg', '0.1', true])
    expect(changedPackages(before, after)).toEqual([
      { name: 'new-pkg', from: null, to: '0.1', binary: true },
      { name: 'numpy', from: '2.5.1', to: '2.5.2', binary: true },
      { name: 'old', from: '1.0', to: null, binary: true }
    ])
  })

  it('counts a rebuilt Windows wheel under the same version as a change', () => {
    const wheel = (hash: string) =>
      `[[package]]\nname = "numpy"\nversion = "2.5.1"\nwheels = [\n    { url = "https://x/numpy-2.5.1-cp312-cp312-win_amd64.whl", hash = "sha256:${hash}", size = 1 },\n]\n`
    expect(changedPackages(wheel('aa'), wheel('aa'))).toEqual([])
    expect(changedPackages(wheel('aa'), wheel('bb'))).toEqual([{ name: 'numpy', from: '2.5.1', to: '2.5.1 (rebuilt)', binary: true }])
  })

  it('tells a new Python patch release from a new minor version', () => {
    expect(pythonChange('3.12.16\n', '3.12.16')).toBeNull()
    expect(pythonChange('3.12.16', '3.12.17')).toBe('patch')
    expect(pythonChange('3.12.16', '3.13.1')).toBe('minor')
  })

  it("reads which files a package installed from its RECORD, under the package's own name", () => {
    const rel = 'resources/backend/_internal/scikit_learn-1.9.0.dist-info/RECORD'
    const text = [
      'sklearn/__init__.py,sha256=aa,100',
      'sklearn/utils/_heap.cp312-win_amd64.pyd,sha256=bb,2000',
      'scikit_learn.libs/msvcp140-abc.dll,sha256=cc,3000',
      '"sklearn/odd, name.pyd",sha256=dd,1',
      '../../Scripts/tool.exe,,',
      'scikit_learn-1.9.0.dist-info/RECORD,,'
    ].join('\n')
    const found = recordEntries(rel, text)!
    expect(found.name).toBe('scikit-learn')
    expect(found.files).toContain('resources/backend/_internal/sklearn/utils/_heap.cp312-win_amd64.pyd')
    expect(found.files).toContain('resources/backend/_internal/scikit_learn.libs/msvcp140-abc.dll')
    expect(found.files).toContain('resources/backend/_internal/sklearn/odd, name.pyd')
    expect(found.files.some((f) => f.includes('Scripts'))).toBe(false)
    expect(normalName('PyYAML')).toBe('pyyaml')
    expect(normalName('typing_extensions')).toBe('typing-extensions')
  })
})

describe('the estimate', () => {
  const B = 'resources/backend/_internal'
  const files = [
    { rel: 'PrismLCA.exe', signed: true },
    { rel: 'ffmpeg.dll', signed: true },
    { rel: 'd3dcompiler_47.dll', signed: true },
    { rel: 'resources/backend/prism-lca-backend.exe', signed: true },
    { rel: `${B}/python312.dll`, signed: true },
    { rel: `${B}/_asyncio.pyd`, signed: true },
    { rel: `${B}/sklearn/a.pyd`, signed: true },
    { rel: `${B}/sklearn/b.pyd`, signed: true },
    { rel: `${B}/scipy/c.pyd`, signed: true },
    { rel: `${B}/scipy.libs/d.dll`, signed: true },
    { rel: `${B}/torch/lib/e.dll`, signed: false }
  ]
  const owners = new Map([
    [`${B}/sklearn/a.pyd`, 'scikit-learn'],
    [`${B}/sklearn/b.pyd`, 'scikit-learn']
  ])
  const none = { python: null, electron: false, packages: [] }
  const pkg = (name: string, binary = true) => ({ name, from: '1', to: '2', binary })

  it('counts, with nothing changed, the unsigned files, our two executables and the installer files', () => {
    const r = estimateSignatures(files, owners, none)
    expect(r.count).toBe(1 + 2 + 3)
    expect(r.untraced).toEqual([])
    expect(neededLimit(r)).toBeNull()
  })

  it('adds the files of a changed package, found by its RECORD or else by its folder', () => {
    expect(estimateSignatures(files, owners, { ...none, packages: [pkg('scikit-learn')] }).count).toBe(6 + 2)
    expect(estimateSignatures(files, owners, { ...none, packages: [pkg('scipy')] }).count).toBe(6 + 2)
    // A changed pure-Python package has nothing to sign; one with binaries nobody can place is named.
    const r = estimateSignatures(files, owners, { ...none, packages: [pkg('attrs', false), pkg('mystery')] })
    expect(r.count).toBe(6)
    expect(r.untraced).toEqual(['mystery'])
  })

  it('adds the Python runtime for a patch release, every backend file for a new minor version', () => {
    expect(estimateSignatures(files, owners, { ...none, python: 'patch' }).count).toBe(6 + 2)
    expect(estimateSignatures(files, owners, { ...none, python: 'minor' }).count).toBe(8 + 1 + 3)
  })

  it('adds the top-level files for a new Electron, counting a maker-signed one generously', () => {
    expect(estimateSignatures(files, owners, { ...none, electron: true }).count).toBe(6 + 2)
  })

  it('asks for an allowance with room to spare, the room counted before the comparison', () => {
    expect(neededLimit({ count: 130, untraced: [] })).toBeNull()
    // 149 expected may become more than 150 when a changed package's new wheel brings files of its own.
    expect(neededLimit({ count: 149, untraced: [] })).toBe(180)
    expect(neededLimit({ count: 335, untraced: [] })).toBe(390)
    expect(neededLimit({ count: 80, untraced: ['a'] })).toBeNull()
    expect(neededLimit({ count: 90, untraced: ['a'] })).toBe(170)
    expect(DEFAULT_SIGN_LIMIT).toBe(150)
  })
})
