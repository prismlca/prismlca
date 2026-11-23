import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprint, isBuildInput, judgeBuild } from './build'
import { changedSince, inside, judge, realDirs, type DoctorInput } from './doctor'
import type { AppFacts, BackendFacts } from './facts'
import type { SessionRecord } from './session'

const FE = '/w/frontend'
const ROOT = '/tmp/prism-e2e-abc'

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    name: 'default',
    frontend: FE,
    token: 't',
    status: 'ready',
    port: 1,
    host: null,
    hostRecorded: true,
    install: {
      root: ROOT,
      data: `${ROOT}/data`,
      userData: `${ROOT}/user-data`,
      downloads: `${ROOT}/downloads`
    },
    mode: 'fresh',
    seeded: false,
    keys: null,
    build: { src: 'S1', out: 'O1' },
    backendSrc: 'B1',
    logs: `${FE}/.cache/control-prism/logs/default`,
    backend: { via: 'shim', detail: '' },
    launchedAt: '2026-11-21T18:00:00.000Z',
    processes: [],
    idleMinutes: 60,
    ...over
  }
}

function backend(over: Partial<BackendFacts> = {}): BackendFacts {
  return {
    pid: 7,
    cwd: '/w/backend',
    dataDir: `${ROOT}/data`,
    brightwayDir: `${ROOT}/data/brightway`,
    pythonPath: '/w/backend/src',
    editableSrc: '/main/backend/src',
    keySettings: [],
    ...over
  }
}

function app(over: Partial<AppFacts> = {}): AppFacts {
  return {
    alive: true,
    appPath: FE,
    userData: `${ROOT}/user-data`,
    rendererUrl: pathToFileURL(`${FE}/out/renderer/index.html`).href,
    env: {
      PRISM_DATA_DIR: `${ROOT}/data`,
      XDG_CONFIG_HOME: `${ROOT}/config`,
      PRISM_DOWNLOAD_DIR: `${ROOT}/downloads`,
      BRIGHTWAY2_DIR: null,
      PRISM_BRIGHTWAY_DIR: `${ROOT}/data/brightway`,
      ELECTRON_RENDERER_URL: null,
      PRISM_EMBEDDING_BACKEND: 'hashing',
      PRISM_IGNORE_DEV_KEYS: '1'
    },
    keyVars: [
      { name: 'OPENROUTER_API_KEY', set: false },
      { name: 'GEMINI_API_KEY', set: false }
    ],
    processes: [],
    backends: [backend()],
    openInRealDirs: [],
    keyStore: 'basic_text',
    storedKeys: [],
    ...over
  }
}

function input(over: Partial<DoctorInput> = {}): DoctorInput {
  return {
    frontend: FE,
    record: record(),
    app: app(),
    current: { src: 'S1', out: 'O1', backend: 'B1' },
    stamp: { src: 'S1', out: 'O1' },
    realDirs: ['/home/u/.config/prism-lca', '/home/u/.local/share/Prism LCA'],
    realChanged: [],
    devKeyFiles: [],
    backendEnvKeys: [],
    ...over
  }
}

const failures = (i: DoctorInput): string[] =>
  judge(i)
    .filter((c) => c.status === 'FAIL')
    .map((c) => c.text)

describe('judge', () => {
  it('passes an isolated instance of the current build', () => {
    expect(failures(input())).toEqual([])
  })

  it('refuses a build that is not the worktree as it is now', () => {
    expect(failures(input({ current: { src: 'S2', out: 'O1', backend: 'B1' } }))).toEqual([
      expect.stringMatching(/sources changed since the build/),
      expect.stringMatching(/older build/)
    ])
    expect(failures(input({ stamp: null }))[0]).toMatch(/no control-prism stamp/)
    expect(failures(input({ current: { src: 'S1', out: 'O9', backend: 'B1' } }))[0]).toMatch(
      /out\/ changed after/
    )
  })

  it('refuses an app started before the latest build, even when out/ is current', () => {
    const i = input({ current: { src: 'S2', out: 'O2', backend: 'B1' }, stamp: { src: 'S2', out: 'O2' } })
    expect(failures(i)).toEqual([expect.stringMatching(/started from an older build/)])
  })

  it('refuses a backend that still runs older backend sources', () => {
    expect(failures(input({ current: { src: 'S1', out: 'O1', backend: 'B2' } }))).toEqual([
      expect.stringMatching(/backend sources changed/)
    ])
  })

  it('refuses an instance of another checkout, or one whose host is gone', () => {
    expect(failures(input({ record: record({ frontend: '/other/frontend' }) }))[0]).toMatch(
      /not yours to drive/
    )
    expect(failures(input({ app: null, hostError: 'refused' }))).toEqual([
      expect.stringMatching(/does not answer \(refused\)/)
    ])
  })

  it('refuses a dev-server renderer or a renderer from elsewhere', () => {
    const env = { ...app().env, ELECTRON_RENDERER_URL: 'http://localhost:5173' }
    expect(failures(input({ app: app({ env, rendererUrl: 'http://localhost:5173/' }) }))).toHaveLength(1)
  })

  it('refuses folders outside the session, unset ones, and overlaps with the real profile', () => {
    const env = { ...app().env, XDG_CONFIG_HOME: null, PRISM_DATA_DIR: '/home/u/.local/share/Prism LCA' }
    const f = failures(input({ app: app({ env, backends: [] }) }))
    expect(f).toContainEqual(expect.stringMatching(/XDG_CONFIG_HOME is not set/))
    expect(f).toContainEqual(expect.stringMatching(/PRISM_DATA_DIR is .*outside/))
    expect(f).toContainEqual(expect.stringMatching(/overlaps your real profile/))
    expect(f).toContainEqual(expect.stringMatching(/no backend process/))
  })

  it('refuses a Brightway directory handed in from outside, or one outside the session', () => {
    const env = { ...app().env, BRIGHTWAY2_DIR: '/home/u/.local/share/Brightway3' }
    expect(failures(input({ app: app({ env }) }))).toEqual([
      expect.stringMatching(/BRIGHTWAY2_DIR is passed in/)
    ])
    const real = '/home/u/.local/share/Prism LCA/brightway'
    const moved = app({
      env: { ...app().env, PRISM_BRIGHTWAY_DIR: real },
      backends: [backend({ brightwayDir: real })]
    })
    expect(failures(input({ app: moved }))).toEqual([
      expect.stringMatching(/PRISM_BRIGHTWAY_DIR is .*outside/),
      expect.stringMatching(/backend has PRISM_BRIGHTWAY_DIR=.*outside/)
    ])
  })

  it('refuses provider keys that reach the app, from the environment or the checkout', () => {
    const keyVars = [{ name: 'GEMINI_API_KEY', set: true }]
    expect(failures(input({ app: app({ keyVars }) }))).toEqual([expect.stringMatching(/GEMINI_API_KEY/)])
    const devKeyFiles = ['/w/.secrets/openrouter-key']
    const reads = app({ env: { ...app().env, PRISM_IGNORE_DEV_KEYS: null } })
    expect(failures(input({ app: reads, devKeyFiles }))).toEqual([expect.stringMatching(/key files/)])
    expect(failures(input({ devKeyFiles }))).toEqual([])
  })

  it('checks the backend: its data folder, its working folder, and with the shim its code first', () => {
    const backends = [backend({ cwd: '/main/backend', pythonPath: '/main/backend/src:/w/backend/src' })]
    expect(failures(input({ app: app({ backends }) }))).toEqual([
      expect.stringMatching(/runs in \/main\/backend/),
      expect.stringMatching(/PYTHONPATH/)
    ])
  })

  it("refuses another checkout's code in the backend of an environment of its own", () => {
    const own = record({ backend: { via: 'own', detail: '' } })
    const ok = backend({ pythonPath: null, editableSrc: '/w/backend/src' })
    expect(failures(input({ record: own, app: app({ backends: [ok] }) }))).toEqual([])
    const inherited = backend({ pythonPath: '/other/backend/src', editableSrc: '/w/backend/src' })
    expect(failures(input({ record: own, app: app({ backends: [inherited] }) }))).toEqual([
      expect.stringMatching(/PYTHONPATH=\/other/)
    ])
    const elsewhere = backend({ pythonPath: null, editableSrc: '/w2/backend/src' })
    expect(failures(input({ record: own, app: app({ backends: [elsewhere] }) }))).toEqual([
      expect.stringMatching(/installs \/w2\/backend\/src/)
    ])
  })

  it('fails on files of the real profile held open, and only notes changes there', () => {
    expect(
      failures(input({ app: app({ openInRealDirs: ['/home/u/.config/prism-lca/Cookies (pid 7)'] }) }))
    ).toHaveLength(1)
    const checks = judge(input({ realChanged: ['/home/u/.config/prism-lca/Preferences'] }))
    expect(checks.filter((c) => c.status === 'FAIL')).toEqual([])
    expect(checks.at(-1)).toMatchObject({ status: 'note', text: expect.stringMatching(/your own PrismLCA/) })
  })

  it("notes what a developer's backend/.env sets", () => {
    const checks = judge(input({ backendEnvKeys: ['PRISM_BRIGHTWAY_DIR'] }))
    expect(
      checks.some((c) => c.status === 'note' && /backend\/\.env sets PRISM_BRIGHTWAY_DIR/.test(c.text))
    ).toBe(true)
  })

  it('refuses stored keys nobody asked for, and keys the app cannot read; notes the ones it can', () => {
    const keys = [
      { provider: 'openai', readable: true },
      { provider: 'openrouter', readable: true }
    ]
    expect(failures(input({ app: app({ storedKeys: keys }) }))).toEqual([
      expect.stringMatching(/holds stored keys \(openai, openrouter\) though launch was not asked/)
    ])
    const asked = record({ keys: ['openai', 'openrouter'] })
    const notes = judge(input({ record: asked, app: app({ storedKeys: keys }) })).filter(
      (c) => c.status === 'note'
    )
    expect(notes.map((c) => c.text)).toEqual([
      expect.stringMatching(/openai, openrouter .* bills your provider/)
    ])
    const unreadable = [keys[0], { provider: 'openrouter', readable: false }]
    expect(failures(input({ record: asked, app: app({ storedKeys: unreadable }) }))).toEqual([
      expect.stringMatching(/cannot decrypt your stored key\(s\) for openrouter/)
    ])
    const none = judge(input({ record: record({ keys: [] }) })).filter((c) => c.status === 'note')
    expect(none.map((c) => c.text)).toEqual([expect.stringMatching(/there were none/)])
  })

  it('refuses provider keys in the backend nobody asked for, as backend/.env can set them', () => {
    const keyed = app({ backends: [backend({ keySettings: ['PRISM_OPENAI_API_KEY'] })] })
    expect(failures(input({ app: keyed }))).toEqual([
      expect.stringMatching(/backend has provider keys \(PRISM_OPENAI_API_KEY\) though launch was not asked/)
    ])
    const asked = record({ keys: ['openai'] })
    const readable = [{ provider: 'openai', readable: true }]
    expect(failures(input({ record: asked, app: { ...keyed, storedKeys: readable } }))).toEqual([])
  })

  it("wants the app's own search model on a copy and offline hashing on an empty install", () => {
    const copy = {
      from: { data: '/home/u/.local/share/Prism LCA', profile: '/home/u/.config/prism-lca' },
      at: '2026-11-21T18:00:00.000Z',
      files: 3,
      bytes: 10,
      attempts: 1,
      shared: true
    }
    const appModel = app({ env: { ...app().env, PRISM_EMBEDDING_BACKEND: null } })
    expect(failures(input({ record: record({ mode: 'copy', copy }), app: appModel }))).toEqual([])
    expect(failures(input({ record: record({ mode: 'copy', copy }) }))).toEqual([
      expect.stringMatching(/embeds with hashing, but the copied index/)
    ])
    expect(failures(input({ record: record({ mode: 'copy' }), app: appModel }))).toEqual([
      expect.stringMatching(/does not say of what/)
    ])
    expect(failures(input({ app: appModel }))).toEqual([expect.stringMatching(/would download first/)])
  })

  it('says outside Linux that the backend environment was not read', () => {
    const checks = judge(input({ app: app({ backends: null, openInRealDirs: null }) }))
    expect(checks.some((c) => c.status === 'note' && /only read on Linux/.test(c.text))).toBe(true)
    expect(checks.some((c) => c.status === 'FAIL')).toBe(false)
  })
})

describe('inside', () => {
  it('compares whole path segments', () => {
    expect(inside('/tmp/a/b', '/tmp/a')).toBe(true)
    expect(inside('/tmp/a', '/tmp/a')).toBe(true)
    expect(inside('/tmp/ab', '/tmp/a')).toBe(false)
    expect(inside('/tmp', '/tmp/a')).toBe(false)
  })
})

describe('realDirs', () => {
  it('names the profile and data folders a normal start uses', () => {
    expect(realDirs({}, 'linux', '/home/u')).toEqual([
      '/home/u/.config/prism-lca',
      '/home/u/.config/PrismLCA',
      '/home/u/.local/share/Prism LCA'
    ])
    expect(realDirs({ XDG_CONFIG_HOME: '/c', XDG_DATA_HOME: '/d' }, 'linux', '/home/u')).toEqual([
      '/c/prism-lca',
      '/c/PrismLCA',
      '/d/Prism LCA'
    ])
    expect(realDirs({}, 'win32', 'C:\\Users\\u')).toEqual([
      'C:\\Users\\u\\AppData\\Roaming\\prism-lca',
      'C:\\Users\\u\\AppData\\Roaming\\PrismLCA',
      'C:\\Users\\u\\AppData\\Local\\Prism LCA'
    ])
  })
})

describe('changedSince', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('lists files modified after the moment, through subfolders', () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-changed-'))
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'old'), 'x')
    writeFileSync(join(dir, 'sub', 'new'), 'x')
    const then = Date.now() - 60_000
    utimesSync(join(dir, 'old'), new Date(then - 60_000), new Date(then - 60_000))
    expect(changedSince([dir, join(dir, 'missing')], then)).toEqual([join(dir, 'sub', 'new')])
  })
})

describe('build stamp', () => {
  it('fingerprints content and path, not the order files were found in', () => {
    const a = { path: 'a.ts', content: Buffer.from('1') }
    const b = { path: 'b.ts', content: Buffer.from('2') }
    expect(fingerprint([a, b])).toBe(fingerprint([b, a]))
    expect(fingerprint([a, b])).not.toBe(fingerprint([a, { ...b, content: Buffer.from('3') }]))
    expect(fingerprint([a])).not.toBe(fingerprint([{ ...a, path: 'c.ts' }]))
  })

  it('leaves unit tests out of the build inputs', () => {
    expect(isBuildInput('src/renderer/src/App.tsx')).toBe(true)
    expect(isBuildInput('src/renderer/src/App.dom.test.tsx')).toBe(false)
    expect(isBuildInput('src/main/ai/tools.test.ts')).toBe(false)
  })

  it('judges the build against its stamp', () => {
    const stamp = { src: 'S', out: 'O', builtAt: '' }
    expect(judgeBuild(stamp, 'S', 'O')).toEqual({ current: true, stamp })
    expect(judgeBuild(stamp, 'S', null)).toMatchObject({
      current: false,
      reason: expect.stringMatching(/no build/)
    })
    expect(judgeBuild(null, 'S', 'O')).toMatchObject({
      current: false,
      reason: expect.stringMatching(/not built by control-prism/)
    })
    expect(judgeBuild(stamp, 'S', 'X')).toMatchObject({
      current: false,
      reason: expect.stringMatching(/another build ran/)
    })
    expect(judgeBuild(stamp, 'T', 'O')).toMatchObject({
      current: false,
      reason: expect.stringMatching(/sources changed/)
    })
  })
})
