/**
 * The Windows publisher check (updateSignature.ts), offline: PowerShell is a fake that answers the way the
 * real script would, and electron-updater's own NsisUpdater and default verifier run unchanged next to it.
 * Three promises: a check without a complete answer never lets an update through; the pin accepts and
 * refuses exactly the subjects electron-updater's verifier accepts and refuses; and NsisUpdater really
 * calls the replacement with the publisher from app-update.yml and stops the download when it refuses.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  acceptedChecks,
  CHECK_TIMEOUT_MS,
  confirmChecked,
  FILE_VARIABLE,
  guardUpdateSignature,
  parseDn,
  POWERSHELL_ARGS,
  SIGNATURE_UNCHECKED,
  signedByPublisher,
  verifyUpdateSignature,
  type PowerShellRun,
  type RunPowerShell
} from './updateSignature'

const require = createRequire(import.meta.url)

/** The publisher every installed copy pins, exactly as the build writes it into app-update.yml. */
const PINNED = (() => {
  const yml = readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf-8')
  const m = yml.match(/^\s*publisherName:\s*'([^']+)'\s*$/m)
  if (!m) throw new Error('publisherName not found in electron-builder.yml')
  return m[1]
})()
/** One attribute of the pinned subject. */
const attr = (key: string): string => {
  const part = PINNED.split(', ').find((p) => p.startsWith(`${key}=`))
  if (!part) throw new Error(`the pinned subject has no ${key}`)
  return part.slice(key.length + 1)
}
const CN = attr('CN')
/** The pinned subject with one attribute changed, or dropped for `undefined`. */
const pinnedWith = (key: string, value: string | undefined): string =>
  PINNED.split(', ')
    .flatMap((p) => (p.startsWith(`${key}=`) ? (value === undefined ? [] : [`${key}=${value}`]) : [p]))
    .join(', ')
const ELSEWHERE = pinnedWith('L', 'Elsewhere')
const FILE = "C:\\Users\\user ü'1\\AppData\\Local\\prism-lca-updater\\pending\\temp-PrismLCA-Setup-1.3.0.exe"
const WIN_ENV = {
  SystemRoot: 'C:\\Windows',
  PATH: 'C:\\Windows\\system32',
  PSModulePath: 'C:\\pwsh\\Modules'
}

/** What the script prints: compact JSON with every character above 126 escaped, then a line break. */
function scriptOutput(o: Record<string, unknown>): string {
  return (
    JSON.stringify(o).replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
    ) + '\r\n'
  )
}

type Call = { exe: string; args: string[]; env: Record<string, string>; timeoutMs: number }
function fakeRun(result: Partial<PowerShellRun>, calls: Call[] = []): RunPowerShell {
  return async (exe, args, env, timeoutMs) => {
    calls.push({ exe, args, env, timeoutMs })
    return { error: null, stdout: '', stderr: '', ...result }
  }
}
const answering = (o: Record<string, unknown>, calls?: Call[]): RunPowerShell =>
  fakeRun({ stdout: scriptOutput(o) }, calls)
const valid = { Status: 0, Path: FILE, Subject: PINNED }
const failedWith = (message: string, extra: Record<string, unknown>): Error =>
  Object.assign(new Error(message), extra)

describe('the Windows publisher check', () => {
  it('accepts a valid signature by the pinned publisher on exactly this file', async () => {
    const calls: Call[] = []
    expect(PINNED).toMatch(/ü/) // the subject needs more than ASCII
    expect(scriptOutput(valid)).toMatch(/^[\x20-\x7e\r\n]+$/)
    expect(await verifyUpdateSignature([PINNED], FILE, answering(valid, calls), WIN_ENV)).toBeNull()
    expect(calls).toHaveLength(1)
  })

  it('starts Windows PowerShell by its absolute path, hands the file over in the environment only', async () => {
    const calls: Call[] = []
    await verifyUpdateSignature([PINNED], FILE, answering(valid, calls), WIN_ENV)
    const [{ exe, args, env, timeoutMs }] = calls
    expect(exe).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args).toEqual(POWERSHELL_ARGS)
    expect(args.join(' ')).not.toContain('temp-PrismLCA')
    expect(env[FILE_VARIABLE]).toBe(FILE)
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(Object.keys(env).map((k) => k.toLowerCase())).not.toContain('psmodulepath')
    expect(timeoutMs).toBe(CHECK_TIMEOUT_MS)
  })

  it('returns a refusal for an unsigned, broken or foreign signature', async () => {
    const refusals = [
      { ...valid, Status: 2, Subject: '' }, // NotSigned
      { ...valid, Status: 3 }, // HashMismatch
      { ...valid, Status: 4 }, // NotTrusted
      { ...valid, Subject: ELSEWHERE },
      { ...valid, Subject: PINNED.replace('ü', 'ue') },
      { ...valid, Subject: `CN=${CN}` }
    ]
    for (const answer of refusals) {
      const verdict = await verifyUpdateSignature([PINNED], FILE, answering(answer), WIN_ENV)
      expect(typeof verdict, JSON.stringify(answer)).toBe('string')
    }
  })

  it('refuses with SIGNATURE_UNCHECKED whenever PowerShell gives no complete answer', async () => {
    const cases: Array<[string, RunPowerShell, NodeJS.ProcessEnv?]> = [
      ['no SystemRoot', answering(valid), { PATH: 'C:\\Windows' }],
      [
        'starting it throws',
        async () => {
          throw new TypeError('The argument is invalid')
        }
      ],
      [
        'PowerShell cannot be started',
        fakeRun({ error: failedWith('spawn powershell.exe ENOENT', { code: 'ENOENT' }) })
      ],
      [
        'blocked by policy, exit 1',
        fakeRun({ error: failedWith('Command failed', { code: 1 }), stderr: 'This program is blocked' })
      ],
      [
        'stopped after the timeout',
        fakeRun({ error: failedWith('Command failed', { killed: true, signal: 'SIGTERM' }) })
      ],
      [
        'an error on stderr with exit 0',
        fakeRun({ stdout: scriptOutput(valid), stderr: 'Get-Authenticode…' })
      ],
      ['output that is not JSON', fakeRun({ stdout: 'The command is not recognized\r\n' })],
      ['no output', fakeRun({ stdout: '' })],
      ['JSON without a subject', answering({ Status: 0, Path: FILE })],
      ['a status that is not a number', answering({ ...valid, Status: 'Valid' })],
      ['another file than the one asked for', answering({ ...valid, Path: 'C:\\other\\signed.exe' })]
    ]
    for (const [what, run, env] of cases) {
      await expect(verifyUpdateSignature([PINNED], FILE, run, env ?? WIN_ENV), what).rejects.toMatchObject({
        code: SIGNATURE_UNCHECKED
      })
    }
  })
})

describe('the pin compares subjects exactly as electron-updater does', () => {
  const subjects = [
    PINNED,
    PINNED.replace(/, /g, ','),
    PINNED.split(', ').reverse().join(', '),
    `${PINNED}, E=releases@example.org`,
    ELSEWHERE,
    PINNED.replace('ü', 'ue'),
    pinnedWith('S', undefined),
    `CN=${CN}`,
    pinnedWith('CN', `"${CN}"`),
    PINNED.replace('ü', '\\c3'),
    `CN=Someone Else, ${PINNED}`,
    PINNED.replace(', O=', '+O='),
    `  CN = ${CN} ; O=${attr('O')} `,
    'CN=trailing\\',
    'CN=a\\4g',
    ''
  ]
  const publisherSets = [[PINNED], [CN], ['CN=Someone Else', PINNED]]

  it('reads distinguished names like builder-util-runtime', () => {
    const { parseDn: theirs } = require('builder-util-runtime') as {
      parseDn: (s: string) => Map<string, string>
    }
    for (const s of [...subjects, ...publisherSets.flat()])
      expect([...parseDn(s)], JSON.stringify(s)).toEqual([...theirs(s)])
  })

  it('gives the default verifier’s verdict whenever PowerShell answers', async () => {
    const cp = require('child_process') as { execFile: unknown }
    const { verifySignature } = require('electron-updater/out/windowsExecutableCodeSignatureVerifier') as {
      verifySignature: (names: string[], file: string, logger: unknown) => Promise<string | null>
    }
    const quiet = { info: () => {}, warn: () => {}, error: () => {} }
    const realExecFile = cp.execFile
    try {
      for (const subject of subjects)
        for (const names of publisherSets) {
          cp.execFile = (_f: string, _a: string[], _o: unknown, cb: (...r: unknown[]) => void): void =>
            cb(null, JSON.stringify({ Status: 0, Path: FILE, SignerCertificate: { Subject: subject } }), '')
          const before = (await verifySignature(names, FILE, quiet)) === null
          const now =
            (await verifyUpdateSignature(names, FILE, answering({ ...valid, Subject: subject }), WIN_ENV)) ===
            null
          expect(now, `${JSON.stringify(subject)} against ${JSON.stringify(names)}`).toBe(before)
          expect(signedByPublisher(names, subject)).toBe(before)
        }
    } finally {
      cp.execFile = realExecFile
    }
    // The table covers both outcomes, so the comparison is not vacuous.
    expect(signedByPublisher([PINNED], PINNED)).toBe(true)
    expect(signedByPublisher([PINNED], ELSEWHERE)).toBe(false)
  })
})

describe('in electron-updater’s NsisUpdater', () => {
  type Nsis = {
    verifyUpdateCodeSignature: unknown
    updateConfigPath: string
    httpExecutor: unknown
    logger: unknown
    verifySignature: (file: string) => Promise<string | null>
    disableWebInstaller: boolean
    disableDifferentialDownload: boolean
    updateInfoAndProvider: unknown
    downloadUpdate: () => Promise<string[]>
  }
  let dir = ''
  let downloads: string[] = []
  const INSTALLER_BYTES = 'installer bytes'
  const APP_UPDATE_YML = `owner: prismlca\nrepo: prismlca\nprovider: github\nupdaterCacheDirName: prism-lca-updater\n`

  function nsisUpdater(): Nsis {
    const { NsisUpdater } = require('electron-updater/out/NsisUpdater') as {
      NsisUpdater: new (options: unknown, app: unknown) => Nsis
    }
    const app = {
      version: '1.2.0',
      name: 'prism-lca',
      isPackaged: true,
      appUpdateConfigPath: join(dir, 'app-update.yml'),
      userDataPath: join(dir, 'userData'),
      baseCachePath: join(dir, 'cache'),
      onQuit: () => {},
      quit: () => {},
      relaunch: () => {}
    }
    const u = new NsisUpdater(null, app)
    u.logger = null
    u.updateConfigPath = app.appUpdateConfigPath
    // As updater.ts configures it.
    u.disableWebInstaller = true
    u.disableDifferentialDownload = true
    u.httpExecutor = {
      download: async (_url: URL, destination: string) => {
        writeFileSync(destination, INSTALLER_BYTES)
        downloads.push(destination)
        return destination
      }
    }
    return u
  }

  /** Answers about whichever file NsisUpdater asks for: its temp name is not known in advance. */
  const aboutAskedFile =
    (o: Record<string, unknown>, calls: Call[] = []): RunPowerShell =>
    (exe, args, env, timeoutMs) =>
      answering({ ...o, Path: env[FILE_VARIABLE] }, calls)(exe, args, env, timeoutMs)

  /**
   * The download as updater.ts starts it: what the last check found (a full installer, or a web installer
   * with its package when `web`), through the public `downloadUpdate`.
   */
  function download(u: Nsis, { web = false } = {}): Promise<string[]> {
    const name = 'PrismLCA-Setup-1.3.0.exe'
    const sha512 = createHash('sha512').update(INSTALLER_BYTES).digest('base64')
    const info = { version: '1.3.0', path: name, sha512, files: [{ url: name, sha512 }] }
    const packageInfo = { path: 'https://example.invalid/prism-lca-1.3.0-x64.nsis.7z', sha512, size: 15 }
    const provider = {
      resolveFiles: () => [
        {
          url: new URL(`https://example.invalid/${name}`),
          info: info.files[0],
          ...(web ? { packageInfo } : {})
        }
      ]
    }
    u.updateInfoAndProvider = { info, provider }
    return u.downloadUpdate()
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prism-update-signature-'))
    downloads = []
    // The guard reads the real environment, as on Windows.
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    // As electron-builder writes it: the pinned subject as a one-entry list.
    writeFileSync(join(dir, 'app-update.yml'), `${APP_UPDATE_YML}publisherName:\n  - '${PINNED}'\n`, 'utf-8')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('calls the replacement with the publisher from app-update.yml', async () => {
    const u = nsisUpdater()
    const calls: Call[] = []
    guardUpdateSignature(u, answering(valid, calls))
    expect(await u.verifySignature(FILE)).toBeNull()
    expect(calls).toHaveLength(1)
    guardUpdateSignature(u, answering({ ...valid, Subject: 'CN=Someone Else' }))
    expect(typeof (await u.verifySignature(FILE))).toBe('string')
  })

  it('stops the download and keeps no file when PowerShell cannot run', async () => {
    const u = nsisUpdater()
    guardUpdateSignature(u, fakeRun({ error: failedWith('spawn powershell.exe ENOENT', { code: 'ENOENT' }) }))
    await expect(download(u)).rejects.toMatchObject({ code: SIGNATURE_UNCHECKED })
    expect(downloads).toHaveLength(1)
    const pending = join(dir, 'cache', 'prism-lca-updater', 'pending')
    expect(existsSync(pending) ? readdirSync(pending) : []).toEqual([])
  })

  it('stops the download as before when the signature belongs to someone else', async () => {
    const u = nsisUpdater()
    guardUpdateSignature(u, aboutAskedFile({ ...valid, Subject: 'CN=Someone Else' }))
    await expect(download(u)).rejects.toMatchObject({ code: 'ERR_UPDATER_INVALID_SIGNATURE' })
  })

  it('completes the download only for the pinned publisher', async () => {
    const u = nsisUpdater()
    guardUpdateSignature(u, aboutAskedFile(valid))
    const [updateFile] = await download(u)
    expect(existsSync(updateFile)).toBe(true)
  })

  it('counts a fresh download that passed the check as checked', async () => {
    const u = nsisUpdater()
    const calls: Call[] = []
    guardUpdateSignature(u, aboutAskedFile(valid, calls))
    const before = acceptedChecks()
    await confirmChecked(u, await download(u), before)
    expect(calls).toHaveLength(1)
  })

  it('checks an installer a previous run left in the cache, which the download itself skips', async () => {
    const first = nsisUpdater()
    guardUpdateSignature(first, aboutAskedFile(valid))
    await download(first)
    expect(downloads).toHaveLength(1)

    // The next start: same cache, and an installer that would not pass any more.
    const u = nsisUpdater()
    const calls: Call[] = []
    guardUpdateSignature(u, aboutAskedFile({ ...valid, Subject: 'CN=Someone Else' }, calls))
    const before = acceptedChecks()
    const files = await download(u)
    expect(downloads).toHaveLength(1) // served from the cache
    expect(calls).toHaveLength(0) // without the check
    await expect(confirmChecked(u, files, before)).rejects.toMatchObject({
      code: 'ERR_UPDATER_INVALID_SIGNATURE'
    })
    expect(calls).toHaveLength(1)

    guardUpdateSignature(u, aboutAskedFile(valid))
    await confirmChecked(u, files, acceptedChecks())
  })

  it('refuses a download when app-update.yml names no publisher', async () => {
    writeFileSync(join(dir, 'app-update.yml'), APP_UPDATE_YML, 'utf-8')
    const u = nsisUpdater()
    const calls: Call[] = []
    guardUpdateSignature(u, answering(valid, calls))
    const before = acceptedChecks()
    const files = await download(u)
    expect(calls).toHaveLength(0) // electron-updater skips the check without a publisher
    await expect(confirmChecked(u, files, before)).rejects.toMatchObject({ code: SIGNATURE_UNCHECKED })
    await expect(confirmChecked(u, [], before)).rejects.toMatchObject({ code: SIGNATURE_UNCHECKED })
  })

  it('refuses a web installer, also one the cache would hand on with its package', async () => {
    const fresh = nsisUpdater()
    guardUpdateSignature(fresh, aboutAskedFile(valid))
    await expect(download(fresh, { web: true })).rejects.toMatchObject({
      code: 'ERR_UPDATER_WEB_INSTALLER_DISABLED'
    })

    // A full installer in the cache, and a release that now names a package beside it.
    await download(fresh)
    const u = nsisUpdater()
    guardUpdateSignature(u, aboutAskedFile(valid))
    const before = acceptedChecks()
    const files = await download(u, { web: true })
    expect(files).toHaveLength(2) // the cache passed it on, package included
    await expect(confirmChecked(u, files, before)).rejects.toMatchObject({
      code: 'ERR_UPDATER_WEB_INSTALLER_DISABLED'
    })
  })

  it('fails closed when the updater offers no verifier slot', () => {
    expect(() => guardUpdateSignature({})).toThrow(/signature guard/)
    expect(() => guardUpdateSignature({ verifyUpdateCodeSignature: null })).toThrow(/signature guard/)
    expect(() => guardUpdateSignature(null)).toThrow(/signature guard/)
  })
})
