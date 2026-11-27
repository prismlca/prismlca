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
    window: { outcome: 'answers', attached: true, ms: 3, readyState: 'complete' },
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
    expect(failures(input({ app: null, hostError: 'refused', window: null }))).toEqual([
      expect.stringMatching(/does not answer \(refused\) — run stop, then launch/)
    ])
  })

  it('sends a session whose kept copy outlived its host to restart or stop, not to stop-then-launch', () => {
    // stop-then-launch would remove the copy, and with it what was built in it.
    const kept =
      'session "default" is over (it ended without stop), and its copy … restart starts the app on it again'
    expect(failures(input({ app: null, hostError: 'refused', keptCopy: kept, window: null }))).toEqual([kept])
  })

  it('tells a stuck driver from a frozen window when the host does not answer', () => {
    const silent = (window: DoctorInput['window']): string[] =>
      failures(input({ app: null, hostError: 'no answer within 40 s', window }))
    expect(silent({ outcome: 'answers', attached: true, ms: 4, readyState: 'complete' })).toEqual([
      expect.stringMatching(
        /but the window does \(document complete, 4 ms\): the driver is stuck, not the app/
      )
    ])
    expect(silent({ outcome: 'answers', attached: false, ms: 4, readyState: 'complete' })[0]).toMatch(
      /nothing holds it any more: the driver is stuck/
    )
    expect(silent({ outcome: 'answers', attached: true, ms: 4, readyState: 'complete' })[0]).toMatch(
      /logs\/default\/console\.log/
    )
    for (const frozen of [
      { outcome: 'window-silent', attached: true, why: 'no answer within 10 s' },
      { outcome: 'browser-silent', why: 'no answer within 10 s' }
    ] as const) {
      expect(silent(frozen)).toEqual([
        expect.stringMatching(
          /and neither does the window \(no answer within 10 s\): the app itself is frozen/
        )
      ])
    }
    expect(silent({ outcome: 'no-window', pages: [] })[0]).toMatch(/no main window/)
    expect(silent({ outcome: 'unreachable', why: 'refused' })[0]).toMatch(
      /could not be asked past it \(refused\) — run stop, then launch/
    )
  })

  it('checks with the host answering that the window answers past the driver and is still held', () => {
    const checks = judge(input())
    expect(checks).toContainEqual({
      status: 'ok',
      text: 'the window answers a plain question past the driver (document complete, 3 ms)'
    })
    expect(
      failures(input({ window: { outcome: 'answers', attached: false, ms: 3, readyState: 'complete' } }))
    ).toEqual([expect.stringMatching(/nothing holds it any more: the driver has lost the window — restart/)])
    expect(
      failures(input({ window: { outcome: 'window-silent', attached: true, why: 'no answer within 10 s' } }))
    ).toEqual([expect.stringMatching(/does not answer a plain question past the driver.*frozen or busy/)])
    // A window that cannot be asked is said, not failed: the host's own checks still stand.
    const unreachable = judge(input({ window: { outcome: 'unreachable', why: 'no port' } }))
    expect(unreachable.filter((c) => c.status === 'FAIL')).toEqual([])
    expect(unreachable).toContainEqual({
      status: 'note',
      text: 'the window could not be asked past the driver: no port'
    })
  })

  it('says what the driver is busy with, and fails while a command given up on may still land', () => {
    const driver = {
      busy: [{ what: 'wait visible "Run"', ms: 12_000, leftMs: 38_000 }],
      outstanding: { what: 'click "Delete"', ms: 41_000 },
      overdue: []
    }
    const checks = judge(input({ app: app({ driver }) }))
    expect(checks).toContainEqual({
      status: 'note',
      text:
        'the driver is busy with wait visible "Run" for 12 s (it gives up on it in 38 s); commands wait ' +
        'their turn behind it'
    })
    expect(failures(input({ app: app({ driver }) }))).toEqual([
      expect.stringMatching(/gave up on click "Delete" 41 s ago, and it has not settled.*restart frees/)
    ])
    expect(failures(input({ app: app({ driver: { busy: [], outstanding: null, overdue: [] } }) }))).toEqual(
      []
    )
  })

  it('notes looks given up on that Playwright never answered, without failing on them', () => {
    const overdue = ['snapshot', 'shot', 'read', 'snapshot "css=.modal"'].map((what, i) => ({
      what,
      ms: (i + 1) * 10_000
    }))
    const i = input({ app: app({ driver: { busy: [], outstanding: null, overdue } }) })
    expect(failures(i)).toEqual([])
    expect(judge(i)).toContainEqual({
      status: 'note',
      text:
        'the driver gave up on snapshot (10 s ago), shot (20 s ago), read (30 s ago) and 1 more, and ' +
        'Playwright has not answered since: when more commands are given up on, the driver is stuck — restart'
    })
  })

  it('tells a look whose caller left from a stuck driver, and does not advise a restart for it', () => {
    // A script stopped in the middle of a long wait: the host lets the wait go on in the background and
    // takes the next command. Nothing about it says the driver is stuck.
    const driver = {
      busy: [],
      outstanding: null,
      overdue: [],
      left: [{ what: 'wait chat-idle', ms: 5_000 }]
    }
    const checks = judge(input({ app: app({ driver }) }))
    expect(failures(input({ app: app({ driver }) }))).toEqual([])
    expect(checks).toContainEqual({
      status: 'note',
      text: 'wait chat-idle (5 s ago) lost its caller and still runs in the background; nothing waits behind it'
    })
    expect(checks.map((c) => c.text).join('\n')).not.toMatch(/stuck|restart/)
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
    // The keys' notes; an unsealed session also says it is not sealed (sealed.test.ts).
    const keyNote = (c: { status: string; text: string }): boolean =>
      c.status === 'note' && !c.text.startsWith('not sealed')
    const notes = judge(input({ record: asked, app: app({ storedKeys: keys }) })).filter(keyNote)
    expect(notes.map((c) => c.text)).toEqual([
      expect.stringMatching(/openai, openrouter .* bills your provider/)
    ])
    const unreadable = [keys[0], { provider: 'openrouter', readable: false }]
    expect(failures(input({ record: asked, app: app({ storedKeys: unreadable }) }))).toEqual([
      expect.stringMatching(/cannot decrypt your stored key\(s\) for openrouter/)
    ])
    const none = judge(input({ record: record({ keys: [] }) })).filter(keyNote)
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
