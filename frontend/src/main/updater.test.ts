/**
 * The manual update check as the renderer reaches it: registered against a fake ipcMain, with a fake
 * `electron-updater` whose events the test fires by hand. The promises under test are the privacy
 * ones — nothing downloads on a check, nothing loads the updater in a dev build, no installation ID
 * leaves the machine (V-1) — the install ones (backend stopped first, V-2; failures reported, V-3; the
 * AppImage swapped atomically, V-4), and that every failure
 * comes back as a state with a sentence, never as a rejected invoke. The updater's own session gets the
 * distrusted roots and, only while a check or download runs, the system's proxy settings.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const ipcListeners = new Map<string, Handler[]>()
/** What the page does when main asks it to save before the backend stops (App.tsx → saveViewsNow). */
const pageSaves = vi.fn()
const appListeners = new Map<string, Array<(e: { preventDefault: () => void }) => void>>()
const sent: Array<{ channel: string; state: unknown }> = []
const appState = { isPackaged: true, userData: '' }
const quit = vi.fn()
const relaunch = vi.fn()

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.0',
    get isPackaged() {
      return appState.isPackaged
    },
    getPath: () => appState.userData,
    on: (event: string, fn: (e: { preventDefault: () => void }) => void) => {
      appListeners.set(event, [...(appListeners.get(event) ?? []), fn])
    },
    quit: () => quit(),
    relaunch: (opts?: unknown) => relaunch(opts)
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: (channel: string, fn: Handler) =>
      ipcListeners.set(channel, [...(ipcListeners.get(channel) ?? []), fn]),
    removeListener: (channel: string, fn: Handler) =>
      ipcListeners.set(
        channel,
        (ipcListeners.get(channel) ?? []).filter((f) => f !== fn)
      )
  }
}))

/** The build kind the module sees (main/buildInfo.ts); release by default, as an installed release would. */
const buildState: { kind: 'release' | 'feedtest' | 'dev' } = { kind: 'release' }
vi.mock('./buildInfo', () => ({
  get BUILD() {
    return { commit: 'abc1234', kind: buildState.kind, feedUrl: 'http://127.0.0.1:8765/' }
  }
}))

class FakeUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  // The two private members V-1 replaces, shaped like electron-updater's (a Lazy and a method).
  stagingUserIdPromise: { value: Promise<string> } = { value: Promise.resolve('a-real-installation-id') }
  computeFinalHeaders(headers: Record<string, string>): Record<string, string> {
    return headers
  }
  checkForUpdates = vi.fn(async (): Promise<unknown> => null)
  downloadUpdate = vi.fn(async (): Promise<unknown> => [])
  install = vi.fn((_isSilent: boolean, _isForceRunAfter: boolean): boolean => true)
  quitAndInstall = vi.fn()
  setFeedURL = vi.fn()
  /** electron-updater's own session; `proxyModes` records every switch, `proxyDuringWork` what a request saw. */
  proxyModes: string[] = []
  netSession = {
    setProxy: vi.fn(async (c: { mode: string }) => void this.proxyModes.push(c.mode)),
    setCertificateVerifyProc: vi.fn()
  }
}
let fake: FakeUpdater = new FakeUpdater()
const loaded = vi.fn()
const appImageUpdaterBuilt = vi.fn()
vi.mock('electron-updater', () => {
  loaded()
  return {
    get autoUpdater() {
      return fake
    },
    // An AppImage run builds its updater by name (updater.ts loadUpdater); the test hands back the fake.
    AppImageUpdater: function AppImageUpdater() {
      appImageUpdaterBuilt()
      return fake
    }
  }
})

const win = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, state: unknown) => {
      sent.push({ channel, state })
      // The page answers a save request the way preload's onSaveRequest does: after its save.
      if (channel === 'updates:save-now')
        setTimeout(() => {
          pageSaves()
          for (const fn of ipcListeners.get('updates:saved') ?? []) fn(null, state)
        }, 1)
    }
  }
}
const waitForBackendExit = vi.fn(async (): Promise<boolean> => true)
const prepareInstall = vi.fn(async (_opts: { force: boolean }): Promise<unknown> => ({ ok: true }))
const realPlatform = process.platform

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

async function setup(): Promise<typeof import('./updater')> {
  vi.resetModules()
  handlers.clear()
  ipcListeners.clear()
  pageSaves.mockClear()
  appListeners.clear()
  sent.length = 0
  loaded.mockClear()
  quit.mockClear()
  relaunch.mockClear()
  prepareInstall.mockClear()
  waitForBackendExit.mockClear()
  prepareInstall.mockImplementation(async () => ({ ok: true }))
  const mod = await import('./updater')
  mod.setInstallerLaunchGraceForTests(20)
  mod.registerUpdaterIpc({
    getWindow: () => win as never,
    prepareInstall: prepareInstall as never,
    waitForBackendExit
  })
  return mod
}
const call = (channel: string): Promise<any> => Promise.resolve(handlers.get(channel)!(null))
const marker = (): string => join(appState.userData, 'pending-update.json')

/** Check → available → download → downloaded, the way the real events arrive. */
async function reachDownloaded(downloadedFile?: string): Promise<void> {
  fake.checkForUpdates.mockImplementation(async () => {
    fake.emit('update-available', { version: '1.3.0' })
    return { isUpdateAvailable: true, updateInfo: { version: '1.3.0' } }
  })
  fake.downloadUpdate.mockImplementation(async () => {
    fake.emit('update-downloaded', { version: '1.3.0', downloadedFile })
    return []
  })
  await call('updates:check')
  expect((await call('updates:download')).phase).toBe('downloaded')
}

beforeEach(async () => {
  appState.isPackaged = true
  appState.userData = mkdtempSync(join(tmpdir(), 'prism-updater-'))
  fake = new FakeUpdater()
  setPlatform('win32')
  vi.stubEnv('APPIMAGE', '')
  await setup()
})

afterEach(() => {
  setPlatform(realPlatform)
  vi.unstubAllEnvs()
  rmSync(appState.userData, { recursive: true, force: true })
})

describe('the manual update check', () => {
  it('starts idle with the app version and loads nothing until asked', async () => {
    expect(await call('updates:state')).toEqual({ phase: 'idle', current: '1.2.0' })
    expect(loaded).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('is unavailable in a dev build and never loads electron-updater there', async () => {
    appState.isPackaged = false
    await setup()
    const expected = {
      phase: 'unavailable',
      current: '1.2.0',
      reason: 'Update checks work in the installed app only.'
    }
    expect(await call('updates:state')).toEqual(expected)
    expect(await call('updates:check')).toEqual(expected)
    expect(loaded).not.toHaveBeenCalled()
  })

  it('is switched off in a dev build even when packaged, and never loads electron-updater', async () => {
    buildState.kind = 'dev'
    try {
      await setup()
      const s = await call('updates:check')
      expect(s).toEqual({
        phase: 'unavailable',
        current: '1.2.0',
        reason: 'Update checks are switched off in development builds.'
      })
      expect(loaded).not.toHaveBeenCalled()
    } finally {
      buildState.kind = 'release'
    }
  })

  it('asks only the local test feed in a feedtest build', async () => {
    buildState.kind = 'feedtest'
    try {
      await setup()
      fake.checkForUpdates.mockImplementation(async () => ({
        isUpdateAvailable: false,
        updateInfo: { version: '1.2.0' }
      }))
      await call('updates:check')
      expect(fake.setFeedURL).toHaveBeenCalledWith({ provider: 'generic', url: 'http://127.0.0.1:8765/' })
    } finally {
      buildState.kind = 'release'
    }
  })

  it('leaves the feed alone in a release build (GitHub, from app-update.yml)', async () => {
    fake.checkForUpdates.mockImplementation(async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: '1.2.0' }
    }))
    await call('updates:check')
    expect(fake.setFeedURL).not.toHaveBeenCalled()
  })

  it('checks without downloading, and reports a newer version with plain-text notes', async () => {
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit('update-available', { version: '1.3.0', releaseNotes: '<p>Faster &amp; <b>better</b></p>' })
      return { isUpdateAvailable: true, updateInfo: { version: '1.3.0' } }
    })
    const s = await call('updates:check')
    expect(s).toEqual({ phase: 'available', current: '1.2.0', version: '1.3.0', notes: 'Faster & better' })
    expect(fake.autoDownload).toBe(false)
    // Install-on-quit is the updater module's own (V-2/V-4), never electron-updater's.
    expect(fake.autoInstallOnAppQuit).toBe(false)
    expect(fake.downloadUpdate).not.toHaveBeenCalled()
    // Every change is pushed to the window: checking, then the answer.
    expect(sent.map((e) => (e.state as { phase: string }).phase)).toEqual(['checking', 'available'])
    expect(sent.every((e) => e.channel === 'updates:event')).toBe(true)
  })

  it('borrows the system proxy settings for the check and the download only', async () => {
    const seen: string[] = []
    fake.checkForUpdates.mockImplementation(async () => {
      seen.push(`check:${fake.proxyModes.at(-1)}`)
      fake.emit('update-available', { version: '1.3.0' })
      return { isUpdateAvailable: true, updateInfo: { version: '1.3.0' } }
    })
    fake.downloadUpdate.mockImplementation(async () => {
      seen.push(`download:${fake.proxyModes.at(-1)}`)
      throw new Error('net::ERR_INTERNET_DISCONNECTED')
    })
    await call('updates:check')
    expect((await call('updates:download')).phase).toBe('error')
    expect(seen).toEqual(['check:system', 'download:system'])
    // Back to none after each, the failed download included.
    expect(fake.proxyModes).toEqual(['system', 'direct', 'system', 'direct'])
  })

  it('hooks the distrusted roots into the updater session before its first request', async () => {
    fake.checkForUpdates.mockImplementation(async () => {
      expect(fake.netSession.setCertificateVerifyProc).toHaveBeenCalledTimes(1)
      return null
    })
    await call('updates:check')
    expect(fake.checkForUpdates).toHaveBeenCalled()
  })

  it('says up to date when there is nothing newer', async () => {
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit('update-not-available', { version: '1.2.0' })
      return { isUpdateAvailable: false, updateInfo: { version: '1.2.0' } }
    })
    const s = await call('updates:check')
    expect(s.phase).toBe('up-to-date')
    expect(s.current).toBe('1.2.0')
    expect(typeof s.checkedAt).toBe('number')
  })

  it('turns a 404 (no release yet) and a dead network into readable errors, never a rejection', async () => {
    fake.checkForUpdates.mockRejectedValueOnce(
      new Error(
        'Unable to find latest version on GitHub (https://github.com/x/y/releases/latest), HttpError: 404'
      )
    )
    expect(await call('updates:check')).toEqual({
      phase: 'error',
      current: '1.2.0',
      message: 'No release of PrismLCA has been published on GitHub yet.'
    })
    fake.checkForUpdates.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api.github.com'))
    const s = await call('updates:check')
    expect(s.phase).toBe('error')
    expect(s.message).toMatch(/github\.com could not be reached/)
  })

  it('reports a failed download as an error state', async () => {
    fake.checkForUpdates.mockImplementation(async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: '1.3.0' }
    }))
    expect((await call('updates:check')).phase).toBe('available')
    fake.downloadUpdate.mockRejectedValueOnce(new Error('sha512 checksum mismatch'))
    expect(await call('updates:download')).toEqual({
      phase: 'error',
      current: '1.2.0',
      message: 'The download failed: sha512 checksum mismatch'
    })
    expect(fake.install).not.toHaveBeenCalled()
  })

  it('blocks an installer that fails its signature check without pointing to a manual install', async () => {
    const { describeUpdateError } = await import('./updater')
    const err = Object.assign(new Error('New version 1.3.0 is not signed by the application owner'), {
      code: 'ERR_UPDATER_INVALID_SIGNATURE'
    })
    const msg = describeUpdateError(err, 'download')
    expect(msg).toBe('The downloaded update failed its signature check and was not installed.')
    expect(msg).not.toMatch(/manual|release page|download it/i)
  })
})

describe('V-1: no installation ID', () => {
  it('replaces the persistent ID with a constant and drops the header from every request', async () => {
    const { NIL_STAGING_ID } = await import('./updater')
    fake.checkForUpdates.mockImplementation(async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: '1.2.0' }
    }))
    await call('updates:check')
    expect(await fake.stagingUserIdPromise.value).toBe(NIL_STAGING_ID)
    expect(fake.computeFinalHeaders({ 'x-user-staging-id': NIL_STAGING_ID, accept: 'x' })).toEqual({
      accept: 'x'
    })
    expect(existsSync(join(appState.userData, '.updaterId'))).toBe(false)
  })

  it('fails closed: without the members it guards, the check sends nothing', async () => {
    const bare = new FakeUpdater() as unknown as Record<string, unknown>
    delete bare.stagingUserIdPromise
    fake = bare as unknown as FakeUpdater
    const s = await call('updates:check')
    expect(s.phase).toBe('error')
    expect(s.message).toMatch(/privacy guard/)
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
  })

  it('removes an ID file an earlier build left behind', async () => {
    writeFileSync(join(appState.userData, '.updaterId'), 'b3c1-old-id')
    await setup()
    expect(existsSync(join(appState.userData, '.updaterId'))).toBe(false)
  })
})

describe('V-2/V-3: installing on Windows', () => {
  it('stops the backend first, writes the marker, starts the installer and quits', async () => {
    await reachDownloaded()
    const s = await call('updates:install')
    expect(prepareInstall).toHaveBeenCalledWith({ force: false })
    expect(fake.install).toHaveBeenCalledWith(false, true)
    expect(prepareInstall.mock.invocationCallOrder[0]).toBeLessThan(fake.install.mock.invocationCallOrder[0])
    expect(JSON.parse(readFileSync(marker(), 'utf-8'))).toMatchObject({ version: '1.3.0', from: '1.2.0' })
    expect(quit).toHaveBeenCalled()
    expect(s.phase).toBe('installing')
    expect(fake.quitAndInstall).not.toHaveBeenCalled()
  })

  it('does not install while work is running, and says why', async () => {
    await reachDownloaded()
    prepareInstall.mockImplementation(async () => ({
      ok: false,
      stopped: false,
      message: 'PrismLCA is still busy (1 calculation running). Install the update once that has finished.'
    }))
    const s = await call('updates:install')
    expect(s).toMatchObject({ phase: 'downloaded', version: '1.3.0' })
    expect(s.note).toMatch(/still busy/)
    expect(fake.install).not.toHaveBeenCalled()
    expect(existsSync(marker())).toBe(false)
    expect(quit).not.toHaveBeenCalled()
  })

  it('reports an installer that cannot start, removes the marker and offers a restart', async () => {
    await reachDownloaded()
    fake.install.mockImplementation(() => {
      fake.emit('error', new Error('spawn EACCES'))
      return false
    })
    const s = await call('updates:install')
    expect(s).toMatchObject({ phase: 'error', restart: true })
    expect(s.message).toMatch(/could not be installed: spawn EACCES/)
    expect(existsSync(marker())).toBe(false)
    expect(quit).not.toHaveBeenCalled()

    await call('updates:relaunch')
    // The old backend is gone before the new instance starts (its lock would refuse the new one).
    expect(waitForBackendExit).toHaveBeenCalled()
    expect(waitForBackendExit.mock.invocationCallOrder[0]).toBeLessThan(relaunch.mock.invocationCallOrder[0])
    expect(relaunch).toHaveBeenCalledWith(undefined)
    expect(quit).toHaveBeenCalled()
  })

  it('reports an installer whose launch fails after install() returned true', async () => {
    // NsisUpdater.doInstall spawns asynchronously: `true` comes first, the spawn error after.
    await reachDownloaded()
    fake.install.mockImplementation(() => {
      setTimeout(() => fake.emit('error', new Error('spawn UNKNOWN')), 5)
      return true
    })
    const s = await call('updates:install')
    expect(s).toMatchObject({ phase: 'error', restart: true })
    expect(s.message).toBe('The update could not be installed: spawn UNKNOWN')
    expect(quit).not.toHaveBeenCalled()
    expect(existsSync(marker())).toBe(false)
  })

  it('keeps the app alive for the restart: no further check, no discard', async () => {
    await reachDownloaded()
    fake.install.mockImplementation(() => false)
    expect(await call('updates:install')).toMatchObject({ phase: 'error', restart: true })
    fake.checkForUpdates.mockClear()
    expect(await call('updates:check')).toMatchObject({ phase: 'error', restart: true })
    expect(fake.checkForUpdates).not.toHaveBeenCalled()
    expect(await call('updates:discard')).toMatchObject({ phase: 'error', restart: true })
  })

  it('holds back a second quit while the install is still stopping the backend', async () => {
    await reachDownloaded()
    let release: (v: unknown) => void = () => {}
    prepareInstall.mockImplementation(() => new Promise((r) => (release = r)))
    const pending = call('updates:install')
    await vi.waitFor(() => expect(prepareInstall).toHaveBeenCalled())
    const preventDefault = vi.fn()
    appListeners.get('before-quit')![0]({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    release({ ok: true })
    await pending
    expect(fake.install).toHaveBeenCalledWith(false, true)
    expect(quit).toHaveBeenCalled()
  })

  it('recovers when the preparation itself throws: no stuck install guard, restart offered', async () => {
    await reachDownloaded()
    prepareInstall.mockImplementation(async () => {
      throw new Error('EPERM: operation not permitted, unlink mcp-endpoint.json')
    })
    const s = await call('updates:install')
    expect(s).toMatchObject({ phase: 'error', restart: true })
    // The guard is down: a quit now goes through.
    const preventDefault = vi.fn()
    appListeners.get('before-quit')![0]({ preventDefault })
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('completes a quit held back during the install, even when the install is refused', async () => {
    await reachDownloaded()
    let answer: (v: unknown) => void = () => {}
    prepareInstall.mockImplementation(() => new Promise((r) => (answer = r)))
    const pending = call('updates:install')
    await vi.waitFor(() => expect(prepareInstall).toHaveBeenCalled())
    appListeners.get('before-quit')![0]({ preventDefault: vi.fn() }) // the window was closed
    answer({ ok: false, stopped: false, message: 'PrismLCA is still busy (1 calculation running).' })
    await pending
    expect(fake.install).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalled()
  })

  it('leaves a marker when preparation fails on the quit path, so the next start reports it', async () => {
    await reachDownloaded()
    prepareInstall.mockImplementation(async () => ({
      ok: false,
      stopped: true,
      message: 'did not answer in time'
    }))
    appListeners.get('before-quit')![0]({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(quit).toHaveBeenCalled())
    expect(fake.install).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(marker(), 'utf-8'))).toMatchObject({ version: '1.3.0', from: '1.2.0' })
  })

  it('closes without relaunching when the old backend cannot be confirmed gone', async () => {
    await reachDownloaded()
    fake.install.mockImplementation(() => false)
    await call('updates:install')
    waitForBackendExit.mockImplementationOnce(async () => false)
    await call('updates:relaunch')
    expect(relaunch).not.toHaveBeenCalled()
    expect(quit).toHaveBeenCalled()
  })

  it('relaunches the AppImage file itself after a failed AppImage install', async () => {
    setPlatform('linux')
    const target = join(appState.userData, 'PrismLCA.AppImage')
    writeFileSync(target, 'old')
    vi.stubEnv('APPIMAGE', target)
    await reachDownloaded(join(appState.userData, 'gone.AppImage'))
    expect(await call('updates:install')).toMatchObject({ phase: 'error', restart: true })
    await call('updates:relaunch')
    expect(relaunch).toHaveBeenCalledWith({ execPath: target, args: [] })
  })

  it('keeps the marker when an install on quit fails, so the next start can report it', async () => {
    setPlatform('linux')
    const target = join(appState.userData, 'PrismLCA.AppImage')
    writeFileSync(target, 'old')
    vi.stubEnv('APPIMAGE', target)
    await reachDownloaded(join(appState.userData, 'gone.AppImage'))
    appListeners.get('before-quit')![0]({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(quit).toHaveBeenCalled())
    expect(readFileSync(target, 'utf-8')).toBe('old')
    expect(JSON.parse(readFileSync(marker(), 'utf-8'))).toMatchObject({ version: '1.3.0', from: '1.2.0' })
  })

  it('installs silently on a normal quit, stopping the backend even with work running', async () => {
    await reachDownloaded()
    const preventDefault = vi.fn()
    appListeners.get('before-quit')![0]({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    await vi.waitFor(() => expect(quit).toHaveBeenCalled())
    expect(prepareInstall).toHaveBeenCalledWith({ force: true })
    expect(fake.install).toHaveBeenCalledWith(true, false)
    // The second quit (the one the install sends) goes through untouched.
    const again = vi.fn()
    appListeners.get('before-quit')![0]({ preventDefault: again })
    expect(again).not.toHaveBeenCalled()
  })

  it('leaves a quit alone when nothing is downloaded, and forgets a discarded download', async () => {
    const untouched = vi.fn()
    appListeners.get('before-quit')![0]({ preventDefault: untouched })
    expect(untouched).not.toHaveBeenCalled()

    await reachDownloaded()
    expect((await call('updates:discard')).phase).toBe('idle')
    const stillUntouched = vi.fn()
    appListeners.get('before-quit')![0]({ preventDefault: stillUntouched })
    expect(stillUntouched).not.toHaveBeenCalled()
    expect(fake.install).not.toHaveBeenCalled()
  })

  it('reports on the next start that the installer did not finish, until the warning is dismissed', async () => {
    writeFileSync(marker(), JSON.stringify({ version: '1.3.0', from: '1.2.0', at: 1, kind: 'nsis' }))
    await setup()
    expect(await call('updates:state')).toEqual({ phase: 'incomplete', current: '1.2.0', version: '1.3.0' })
    // Reading the state (before-quit does, unseen) does not use the warning up.
    expect(existsSync(marker())).toBe(true)
    await setup()
    expect((await call('updates:state')).phase).toBe('incomplete')
    expect((await call('updates:discard')).phase).toBe('idle')
    expect(existsSync(marker())).toBe(false)
  })

  it('lets the page save its canvas and views before the backend is stopped', async () => {
    await reachDownloaded()
    await call('updates:install')
    expect(sent.some((e) => e.channel === 'updates:save-now')).toBe(true)
    expect(pageSaves).toHaveBeenCalledTimes(1)
    expect(pageSaves.mock.invocationCallOrder[0]).toBeLessThan(prepareInstall.mock.invocationCallOrder[0])
    expect(ipcListeners.get('updates:saved')).toEqual([])
  })

  it('says nothing after a successful update and removes the kept AppImage', async () => {
    const prev = join(appState.userData, '.PrismLCA.AppImage.prev')
    writeFileSync(prev, 'old')
    writeFileSync(
      marker(),
      JSON.stringify({ version: '1.2.0', from: '1.1.0', at: 1, kind: 'appimage', prev })
    )
    await setup()
    expect(await call('updates:state')).toEqual({ phase: 'idle', current: '1.2.0' })
    expect(existsSync(prev)).toBe(false)
    expect(existsSync(marker())).toBe(false)
  })
})

describe('V-3: a deb installation is updated from the release page', () => {
  it('marks the update as manual-only and refuses download and install in main', async () => {
    setPlatform('linux')
    fake.checkForUpdates.mockImplementation(async () => {
      fake.emit('update-available', { version: '1.3.0' })
      return { isUpdateAvailable: true, updateInfo: { version: '1.3.0' } }
    })
    expect(await call('updates:check')).toMatchObject({ phase: 'available', manualOnly: true })
    expect((await call('updates:download')).phase).toBe('available')
    expect(fake.downloadUpdate).not.toHaveBeenCalled()
    expect((await call('updates:install')).phase).toBe('available')
    expect(fake.install).not.toHaveBeenCalled()
  })
})

describe('V-4: the AppImage swap', () => {
  it('puts the new file in place under the same name and keeps the old one as .prev', async () => {
    const { swapAppImage } = await import('./updater')
    const target = join(appState.userData, 'PrismLCA.AppImage')
    const downloaded = join(appState.userData, 'download.AppImage')
    writeFileSync(target, 'old')
    writeFileSync(downloaded, 'new')
    const prev = swapAppImage(downloaded, target)
    expect(readFileSync(target, 'utf-8')).toBe('new')
    expect(statSync(target).mode & 0o111).not.toBe(0)
    expect(readFileSync(prev, 'utf-8')).toBe('old')
    expect(existsSync(join(appState.userData, '.PrismLCA.AppImage.new'))).toBe(false)
  })

  it('leaves the old file untouched and no leftovers when the swap fails', async () => {
    const { swapAppImage } = await import('./updater')
    const target = join(appState.userData, 'PrismLCA.AppImage')
    writeFileSync(target, 'old')
    expect(() => swapAppImage(join(appState.userData, 'missing.AppImage'), target)).toThrow()
    expect(readFileSync(target, 'utf-8')).toBe('old')
    expect(existsSync(join(appState.userData, '.PrismLCA.AppImage.new'))).toBe(false)
    expect(existsSync(join(appState.userData, '.PrismLCA.AppImage.prev'))).toBe(false)
  })

  it('uses the AppImage updater by name in an AppImage run, never the package-type singleton', async () => {
    setPlatform('linux')
    vi.stubEnv('APPIMAGE', join(appState.userData, 'PrismLCA.AppImage'))
    appImageUpdaterBuilt.mockClear()
    fake.checkForUpdates.mockImplementation(async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: '1.2.0' }
    }))
    await call('updates:check')
    expect(appImageUpdaterBuilt).toHaveBeenCalledTimes(1)
  })

  it('installs an AppImage by swapping it itself and relaunching the new file', async () => {
    setPlatform('linux')
    const target = join(appState.userData, 'PrismLCA.AppImage')
    const downloaded = join(appState.userData, 'download.AppImage')
    writeFileSync(target, 'old')
    writeFileSync(downloaded, 'new')
    vi.stubEnv('APPIMAGE', target)
    await reachDownloaded(downloaded)
    await call('updates:install')
    expect(prepareInstall).toHaveBeenCalledWith({ force: false })
    expect(fake.install).not.toHaveBeenCalled()
    expect(readFileSync(target, 'utf-8')).toBe('new')
    expect(JSON.parse(readFileSync(marker(), 'utf-8'))).toMatchObject({
      version: '1.3.0',
      kind: 'appimage',
      prev: join(appState.userData, '.PrismLCA.AppImage.prev')
    })
    expect(relaunch).toHaveBeenCalledWith({ execPath: target, args: [] })
    expect(quit).toHaveBeenCalled()
  })
})
