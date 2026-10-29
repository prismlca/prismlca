/**
 * The update check — manual only, a small state machine around `electron-updater`.
 *
 * WHY manual: PrismLCA makes no network request without a user action (see PRIVACY.md). So nothing here
 * runs at start-up: the check happens when the user clicks "Check for updates" on the About page, the
 * download only after they confirm it,
 * and the install on "Restart and install" (or on the next normal quit). The request goes to GitHub
 * Releases and carries the user's IP address and this program version — no device ID, nothing else.
 * There is deliberately no "check automatically" switch.
 *
 * The rest of this file closes the gaps of a plain electron-updater setup (V-1 to V-4):
 *  - V-1: electron-updater sends a persistent installation ID with every check unless told not to
 *    (`neutraliseInstallationId`).
 *  - V-2: the backend is stopped in order BEFORE anything replaces the program files
 *    (`deps.prepareInstall`, implemented in index.ts).
 *  - V-3: an install that fails is reported — at once if the app is still running, on the next start
 *    (via `pending-update.json`) if the installer failed after the app had quit; and a deb package is
 *    refused here, not only hidden in the UI.
 *  - V-4: the AppImage is swapped atomically by this file (`swapAppImage`), because electron-updater
 *    deletes the old file before it moves the new one into place.
 * electron-updater's own install-on-quit is therefore off; `before-quit` below does it instead.
 *
 * `electron-updater` is imported lazily, on the first click, so dev and smoke runs never load it. Its
 * requests run in a session of their own: the distrusted roots are hooked there too, and the check and
 * the download use the system's proxy settings while they run — at no other time (networkProxy.ts).
 * Failures land in the `error` phase as a readable sentence — the renderer never sees an exception.
 */
import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

import type { PrepareInstallResult, UpdateState } from '../shared/updates'
import { BUILD } from './buildInfo'
import { distrustIn } from './distrustedRoots'
import { withSystemProxy } from './networkProxy'

export type { PrepareInstallResult, UpdateState }

type AutoUpdater = (typeof import('electron-updater'))['autoUpdater']

const NOT_PACKAGED = 'Update checks work in the installed app only.'
/** Every local build is a `dev` build (main/buildInfo.ts): only the release workflow makes one that may
 *  ask GitHub, so a package built on a laptop can never install something by itself. */
const DEV_BUILD = 'Update checks are switched off in development builds.'

/** Why this build cannot check for updates, or null when it can. */
function unavailableReason(): string | null {
  if (!app.isPackaged) return NOT_PACKAGED
  if (BUILD.kind === 'dev') return DEV_BUILD
  return null
}
/** Release notes are shown as plain text on the About page; a long changelog is cut. */
const MAX_NOTES_CHARS = 2000
/** Written just before an install starts, read on the next start (V-3). In `userData`. */
const MARKER_FILE = 'pending-update.json'
/** What electron-updater would otherwise create in `userData` and send as `x-user-staging-id` (V-1). */
const STAGING_ID_FILE = '.updaterId'
/** A constant in place of the per-installation UUID. Staged rollouts (which would read it) are not used. */
export const NIL_STAGING_ID = '00000000-0000-0000-0000-000000000000'

/** How this installation gets updated: NSIS on Windows, the AppImage swap, or by hand (deb, other). */
export type InstallKind = 'nsis' | 'appimage' | 'manual'

export function installKind(
  platform: NodeJS.Platform = process.platform,
  appImage: string | undefined = process.env.APPIMAGE
): InstallKind {
  if (platform === 'win32') return 'nsis'
  if (platform === 'linux' && appImage) return 'appimage'
  return 'manual'
}

type Deps = {
  getWindow: () => BrowserWindow | null
  /** Stop the backend in order (V-2). `force`: the user is quitting anyway, running work or not. */
  prepareInstall: (opts: { force: boolean }) => Promise<PrepareInstallResult>
  /** Before a relaunch after a failed install: make sure the old backend is gone, or the new one
   *  finds its instance lock still held and refuses to start (index.ts). */
  waitForBackendExit?: () => Promise<boolean>
}

type Marker = { version: string; from: string; at: number; kind: InstallKind; prev?: string }

let state: UpdateState | null = null
let updater: AutoUpdater | null = null
let deps: Deps = { getWindow: () => null, prepareInstall: async () => ({ ok: true }) }
/** The file electron-updater downloaded and verified (sha512, and the signature on Windows). */
let downloadedFile: string | null = null
/** The last error electron-updater reported while an install was starting (it reports, not throws). */
let installError: string | null = null
let installing = false
/** Set once an install (or a failed one on the quit path) has decided to let the app quit. */
let quitThrough = false
/** The backend was stopped for an install that then failed: nothing works until the app restarts. */
let restartRequired = false
/** A quit arrived while the install was under way (the window was closed) and was held back. Whatever
 *  the install comes to, it must end in that quit — a window-less process with no way to show an
 *  error or a restart button would otherwise stay behind. */
let quitDeferred = false
/** How long a started installer has to report a launch failure. `NsisUpdater.doInstall` spawns it
 *  asynchronously and returns true at once; a failed spawn (and its elevate.exe / openPath
 *  fallbacks) arrives later through 'error'. */
export const INSTALLER_LAUNCH_GRACE_MS = 1500
let launchGraceMs = INSTALLER_LAUNCH_GRACE_MS
/** Tests only: the real grace would add 1.5 s to every install test. */
export function setInstallerLaunchGraceForTests(ms: number): void {
  launchGraceMs = ms
}

const markerPath = (): string => join(app.getPath('userData'), MARKER_FILE)

function readMarker(): Marker | null {
  try {
    const m = JSON.parse(readFileSync(markerPath(), 'utf-8')) as Partial<Marker>
    return typeof m.version === 'string' && typeof m.from === 'string' ? (m as Marker) : null
  } catch {
    return null
  }
}

/** Best effort: a marker that cannot be removed (locked on Windows) must not break a recovery path. */
function removeMarker(): void {
  try {
    rmSync(markerPath(), { force: true })
  } catch (err) {
    console.error('[updater] could not remove the update marker', err)
  }
}

/** Only ever the `.<name>.prev` file `swapAppImage` made — never anything a corrupt marker names. */
function removePrev(prev: string | undefined): void {
  if (!prev || !isAbsolute(prev) || !/^\..+\.prev$/.test(basename(prev))) return
  try {
    rmSync(prev, { force: true })
  } catch (err) {
    console.error('[updater] could not remove', prev, err)
  }
}

/**
 * A packaged start: what did the last start's install come to? A successful one clears the marker
 * (and the AppImage's `.prev`). A failed one KEEPS it until the user has seen and dismissed the
 * warning, or acted on it with a new check — reading the state for a quit (before-quit asks first)
 * must not use the warning up unseen.
 */
function outcomeOfLastInstall(current: string): UpdateState | null {
  const m = readMarker()
  if (!m) return null
  if (m.version === current) {
    removeMarker()
    removePrev(m.prev)
    return null
  }
  // Still the version the install started from: the installer failed or was cancelled.
  if (m.from === current) return { phase: 'incomplete', current, version: m.version }
  removeMarker() // something else was installed in between — nothing to say
  return null
}

function initialState(): UpdateState {
  const current = app.getVersion()
  const reason = unavailableReason()
  if (reason) return { phase: 'unavailable', current, reason }
  return outcomeOfLastInstall(current) ?? { phase: 'idle', current }
}

export function getUpdateState(): UpdateState {
  return (state ??= initialState())
}

function setState(next: UpdateState): UpdateState {
  state = next
  const win = deps.getWindow()
  if (win && !win.isDestroyed()) win.webContents.send('updates:event', next)
  return next
}

/** The version the renderer shows, from the app itself (never from the feed). */
const current = (): string => getUpdateState().current

/** GitHub's release notes arrive as HTML (a string, or one entry per version). Plain text out. */
export function plainNotes(raw: unknown): string | undefined {
  const parts = Array.isArray(raw)
    ? raw.map((r) => (r && typeof r === 'object' ? String((r as { note?: unknown }).note ?? '') : ''))
    : typeof raw === 'string'
      ? [raw]
      : []
  const text = parts
    .join('\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) return undefined
  return text.length > MAX_NOTES_CHARS ? `${text.slice(0, MAX_NOTES_CHARS).trimEnd()}…` : text
}

/** One readable sentence for whatever the updater threw. */
export function describeUpdateError(err: unknown, during: 'check' | 'download' | 'install'): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  const code = (err as { code?: unknown } | null)?.code
  // A downloaded installer that fails its Authenticode check may be an attack. Say so and stop —
  // never point the user at a manual install from here.
  if (
    code === 'ERR_UPDATER_INVALID_SIGNATURE' ||
    /not signed by the application owner|invalid signature/i.test(raw)
  )
    return 'The downloaded update failed its signature check and was not installed.'
  if (/\b404\b|Unable to find latest version|No published versions|Cannot find latest/i.test(raw))
    return 'No release of PrismLCA has been published on GitHub yet.'
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|net::ERR_|getaddrinfo|socket hang up/i.test(
      raw
    )
  )
    return 'github.com could not be reached. Check your internet connection and try again.'
  const first = raw.split('\n')[0].trim().slice(0, 200)
  const what =
    during === 'check'
      ? 'The update check failed'
      : during === 'download'
        ? 'The download failed'
        : 'The update could not be installed'
  return first ? `${what}: ${first}` : `${what}.`
}

/**
 * V-1. electron-updater 6.x creates `<userData>/.updaterId` with a random UUID on the first check and
 * sends it as the header `x-user-staging-id` with every request after (`AppUpdater.
 * getUpdateInfoAndProvider` → `getOrCreateStagingUserId`). That is an installation ID, which the
 * privacy rules forbid. Both private members are replaced here: the lazy ID resolves to a constant
 * without touching the disk, and the header is dropped from whatever goes out. If the members are not
 * where they are expected (a newer electron-updater), this throws — the check then fails with a
 * sentence instead of sending an ID. `updater.privacy.test.ts` pins the names against the installed
 * package, so an upgrade that moves them fails the tests first.
 */
export function neutraliseInstallationId(u: unknown): void {
  const internals = u as {
    stagingUserIdPromise?: unknown
    computeFinalHeaders?: (headers: Record<string, string>) => Record<string, string>
  } | null
  if (
    !internals ||
    typeof internals.computeFinalHeaders !== 'function' ||
    !('stagingUserIdPromise' in internals)
  )
    throw new Error('its privacy guard could not be applied, so no request was sent')
  internals.stagingUserIdPromise = { value: Promise.resolve(NIL_STAGING_ID) }
  const original = internals.computeFinalHeaders.bind(u)
  internals.computeFinalHeaders = (headers) => {
    const out = original(headers)
    delete out['x-user-staging-id']
    return out
  }
}

/** A `.updaterId` from a build before V-1 goes, so it can never be read again. */
function removeStagingIdFile(): void {
  try {
    rmSync(join(app.getPath('userData'), STAGING_ID_FILE), { force: true })
  } catch (err) {
    console.error('[updater] could not remove', STAGING_ID_FILE, err)
  }
}

function fsyncPath(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * V-4. Put the downloaded AppImage in place of the running one so that the path always holds a
 * complete file — the old one or the new one, never half and never none. electron-updater's own
 * `AppImageUpdater.doInstall` unlinks the old file before it moves the new one in.
 *
 * The new file is copied next to the target first (same directory = same file system, so the final
 * `rename` is atomic), made executable and flushed. The old file is kept as `.<name>.prev` through a
 * hard link (a copy where the file system has none) and removed on the next successful start. The
 * name stays the same, so desktop entries that point at it keep working. Returns the `.prev` path.
 */
export function swapAppImage(downloaded: string, target: string): string {
  if (!isAbsolute(target)) throw new Error(`the AppImage path is not absolute: ${target}`)
  const dir = dirname(target)
  const name = basename(target)
  const tmp = join(dir, `.${name}.new`)
  const prev = join(dir, `.${name}.prev`)
  rmSync(tmp, { force: true })
  let prevMade = false
  try {
    copyFileSync(downloaded, tmp)
    chmodSync(tmp, 0o755)
    fsyncPath(tmp)
    rmSync(prev, { force: true })
    try {
      linkSync(target, prev)
    } catch {
      copyFileSync(target, prev)
    }
    prevMade = true
    renameSync(tmp, target)
  } catch (err) {
    rmSync(tmp, { force: true })
    if (prevMade) rmSync(prev, { force: true })
    throw err
  }
  try {
    fsyncPath(dir)
  } catch (err) {
    // The rename is done and visible; a directory fsync some file systems refuse changes nothing.
    console.error('[updater] directory fsync after the swap failed', err)
  }
  return prev
}

async function loadUpdater(): Promise<AutoUpdater> {
  if (updater) return updater
  const mod = await import('electron-updater')
  // electron-updater's own singleton picks its Linux updater from `resources/package-type` alone. The
  // deb target writes that file into the shared unpacked folder, so an AppImage built after the deb
  // would carry "deb" and download the .deb — which the swap below would then put in place of the
  // program (seen with electron-builder 26; only the target order prevented it).
  // An AppImage run therefore gets its updater by name, whatever the file says.
  const autoUpdater = installKind() === 'appimage' ? new mod.AppImageUpdater() : mod.autoUpdater
  neutraliseInstallationId(autoUpdater)
  distrustIn(autoUpdater.netSession)
  // A feedtest build asks only the local test feed, never GitHub.
  if (BUILD.kind === 'feedtest' && BUILD.feedUrl)
    autoUpdater.setFeedURL({ provider: 'generic', url: BUILD.feedUrl })
  autoUpdater.autoDownload = false
  // Install-on-quit is ours (`before-quit` below): electron-updater's would start the installer
  // with the backend still running (V-2) and swap the AppImage unsafely (V-4).
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('update-available', (info) =>
    setState({
      phase: 'available',
      current: current(),
      version: info.version,
      notes: plainNotes(info.releaseNotes),
      ...(installKind() === 'manual' ? { manualOnly: true } : {})
    })
  )
  autoUpdater.on('update-not-available', () =>
    setState({ phase: 'up-to-date', current: current(), checkedAt: Date.now() })
  )
  autoUpdater.on('download-progress', (p) => {
    const s = getUpdateState()
    if (s.phase === 'downloading' || s.phase === 'available')
      setState({
        phase: 'downloading',
        current: current(),
        version: s.version,
        percent: Math.round(p.percent ?? 0)
      })
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloadedFile = (info as { downloadedFile?: string }).downloadedFile ?? null
    setState({ phase: 'downloaded', current: current(), version: info.version })
  })
  // Without a listener an EventEmitter 'error' would throw; the rejected promise reports it too.
  autoUpdater.on('error', (err) => {
    const s = getUpdateState()
    if (s.phase === 'checking' || s.phase === 'downloading')
      setState({
        phase: 'error',
        current: current(),
        message: describeUpdateError(err, s.phase === 'checking' ? 'check' : 'download')
      })
    else if (s.phase === 'installing') installError = describeUpdateError(err, 'install')
    console.error('[updater]', err)
  })
  updater = autoUpdater
  return autoUpdater
}

/** Ask GitHub Releases for a newer version. Never downloads. */
export async function checkForUpdates(): Promise<UpdateState> {
  const s = getUpdateState()
  if (restartRequired) return s
  const reason = unavailableReason()
  if (reason) return setState({ phase: 'unavailable', current: s.current, reason })
  // A second click while busy, or after the download: nothing to ask.
  if (
    s.phase === 'checking' ||
    s.phase === 'downloading' ||
    s.phase === 'downloaded' ||
    s.phase === 'installing'
  )
    return s
  // A new check is the user acting on an "update did not complete" warning: it has been seen.
  if (s.phase === 'incomplete') removeMarker()
  setState({ phase: 'checking', current: s.current })
  try {
    const u = await loadUpdater()
    const result = await withSystemProxy(u.netSession, () => u.checkForUpdates())
    // The events normally set the answer; this covers an updater that resolved without firing one.
    if (getUpdateState().phase === 'checking') {
      const info = result?.updateInfo
      if (result && info && result.isUpdateAvailable)
        setState({
          phase: 'available',
          current: current(),
          version: info.version,
          notes: plainNotes(info.releaseNotes),
          ...(installKind() === 'manual' ? { manualOnly: true } : {})
        })
      else if (result) setState({ phase: 'up-to-date', current: current(), checkedAt: Date.now() })
      else setState({ phase: 'error', current: current(), message: 'The update check returned no answer.' })
    }
  } catch (err) {
    setState({ phase: 'error', current: current(), message: describeUpdateError(err, 'check') })
  }
  return getUpdateState()
}

/** Download the version the last check found — only on the user's confirmation, never for a deb. */
export async function downloadUpdate(): Promise<UpdateState> {
  const s = getUpdateState()
  if (restartRequired) return s
  if (s.phase !== 'available' || !updater || installKind() === 'manual') return s
  setState({ phase: 'downloading', current: s.current, version: s.version, percent: 0 })
  try {
    const u = updater
    await withSystemProxy(u.netSession, () => u.downloadUpdate())
    const after = getUpdateState()
    if (after.phase === 'downloading')
      setState({ phase: 'downloaded', current: current(), version: after.version })
  } catch (err) {
    setState({ phase: 'error', current: current(), message: describeUpdateError(err, 'download') })
  }
  return getUpdateState()
}

/** How long the page gets to save its canvas and views before the backend stops. */
const SAVE_TIMEOUT_MS = 5000
let saveRequestId = 0

/**
 * Ask the page to write what it holds (canvas layout, pending view writes) and wait for its answer —
 * while the backend still runs (V-2). Without a window, or after the
 * timeout, the install goes on: a lost layout move is not worth an install that never happens.
 */
function saveRendererState(): Promise<void> {
  const win = deps.getWindow()
  if (!win || win.isDestroyed()) return Promise.resolve()
  const id = ++saveRequestId
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      ipcMain.removeListener('updates:saved', onSaved)
      resolve()
    }
    const onSaved = (_e: unknown, answered: unknown): void => {
      if (answered === id) done()
    }
    const timer = setTimeout(done, SAVE_TIMEOUT_MS)
    ipcMain.on('updates:saved', onSaved)
    win.webContents.send('updates:save-now', id)
  })
}

function letQuit(): void {
  quitThrough = true
  app.quit()
}

/**
 * Stop the backend, write the marker, start the installer (or swap the AppImage), quit.
 * `restart`: the button — the new version starts afterwards. `quit`: the app is closing anyway — a
 * silent install, nothing restarts, and running work does not hold the install back.
 */
async function installNow(mode: 'restart' | 'quit'): Promise<UpdateState> {
  const s = getUpdateState()
  const kind = installKind()
  if (s.phase !== 'downloaded' || !updater || installing || kind === 'manual') {
    if (mode === 'quit') letQuit()
    return s
  }
  installing = true
  installError = null
  quitDeferred = false
  const version = s.version
  setState({ phase: 'installing', current: current(), version })

  const marker: Marker = { version, from: current(), at: Date.now(), kind }
  const appImage = kind === 'appimage' ? process.env.APPIMAGE : undefined
  if (appImage) marker.prev = join(dirname(appImage), `.${basename(appImage)}.prev`)

  /** Nobody will see a state any more: the app is closing (quit path, or a quit held back meanwhile). */
  const closing = (): boolean => mode === 'quit' || quitDeferred
  /** The backend is gone: the app cannot go on without a restart. When it is closing, it just quits. */
  const fail = (message: string): UpdateState => {
    installing = false
    if (closing()) {
      // Nobody is there to read the error: leave the marker, so the next start reports that the
      // update did not complete — whether preparation or installer failed.
      try {
        writeFileSync(markerPath(), JSON.stringify(marker))
      } catch (err) {
        console.error('[updater] could not write the update marker', err)
      }
      letQuit()
      return getUpdateState()
    }
    restartRequired = true
    return setState({ phase: 'error', current: current(), message, restart: true })
  }

  let prepared: PrepareInstallResult
  try {
    await saveRendererState()
    prepared = await deps.prepareInstall({ force: mode === 'quit' })
  } catch (err) {
    // Whatever threw, the backend may already be on its way out: restart (or quit) is the safe exit.
    return fail(describeUpdateError(err, 'install'))
  }
  if (!prepared.ok) {
    // Refused while the backend still runs (work in progress): back to "ready", with the reason —
    // unless the window has been closed meanwhile, then the held-back quit goes through.
    if (!prepared.stopped && !closing()) {
      installing = false
      return setState({ phase: 'downloaded', current: current(), version, note: prepared.message })
    }
    return fail(prepared.message)
  }

  // The marker goes down before anything is attempted. On the quit path it stays even when the
  // attempt fails, so the next start can say the update did not complete (nobody is there to read
  // an error now). On the restart path a failure is shown at once and the marker is removed.
  try {
    writeFileSync(markerPath(), JSON.stringify(marker))
    if (kind === 'nsis') {
      // `install` lives on BaseUpdater (NsisUpdater's parent); the exported type is the AppUpdater base.
      const nsis = updater as unknown as { install: (isSilent: boolean, isForceRunAfter: boolean) => boolean }
      if (!nsis.install(mode === 'quit', mode === 'restart'))
        throw new Error(installError ?? 'the installer could not be started')
      // `true` only means a spawn was attempted; a failure to launch arrives through 'error'.
      await new Promise((resolve) => setTimeout(resolve, launchGraceMs))
      if (installError) throw new Error(installError)
    } else {
      if (!appImage) throw new Error('this is not an AppImage run')
      if (!downloadedFile || !existsSync(downloadedFile)) throw new Error('the downloaded file is missing')
      swapAppImage(downloadedFile, appImage)
      if (mode === 'restart') app.relaunch({ execPath: appImage, args: [] })
    }
  } catch (err) {
    // Shown at once only when someone is there to see it; otherwise the marker reports it next start.
    if (!closing()) removeMarker()
    const message = err instanceof Error && err.message === installError ? installError : null
    return fail(message ?? describeUpdateError(err, 'install'))
  }
  letQuit()
  return getUpdateState()
}

/** Quit and install the downloaded update, then start the new version. */
export function installUpdate(): Promise<UpdateState> {
  return installNow('restart')
}

/** Forget the downloaded update: nothing installs on quit. The file stays in the updater's cache. */
export function discardUpdate(): UpdateState {
  const s = getUpdateState()
  if (restartRequired) return s
  if (s.phase !== 'downloaded' && s.phase !== 'error' && s.phase !== 'incomplete') return s
  if (s.phase === 'incomplete') removeMarker()
  downloadedFile = null
  return setState({ phase: 'idle', current: current() })
}

/** After a failed install the backend is gone; this brings the whole app back. */
export async function relaunchApp(): Promise<UpdateState> {
  const s = getUpdateState()
  if (!restartRequired) return s
  // The new instance must not meet the old backend's instance lock. If the old one cannot be
  // confirmed gone, the app still closes, but does not start itself again into a refusal.
  const gone = (await deps.waitForBackendExit?.()) ?? true
  if (!gone) {
    letQuit()
    return s
  }
  // An AppImage relaunches its file: Electron's own path lies inside the mount that vanishes on exit.
  const appImage = installKind() === 'appimage' ? process.env.APPIMAGE : undefined
  app.relaunch(appImage ? { execPath: appImage, args: [] } : undefined)
  letQuit()
  return s
}

export function registerUpdaterIpc(d: Deps): void {
  deps = d
  if (app.isPackaged) removeStagingIdFile()
  ipcMain.handle('updates:state', () => getUpdateState())
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:download', () => downloadUpdate())
  ipcMain.handle('updates:install', () => installUpdate())
  ipcMain.handle('updates:discard', () => discardUpdate())
  ipcMain.handle('updates:relaunch', () => relaunchApp())
  // Install-on-quit, done here instead of by electron-updater (see `loadUpdater`).
  app.on('before-quit', (event) => {
    if (quitThrough) return
    // An install is under way (backend stopping, installer starting): only the install may end the
    // app now. A second quit — the window closed meanwhile — would kill the backend mid-stop and
    // exit before the installer starts.
    if (installing) {
      event.preventDefault()
      quitDeferred = true
      return
    }
    if (getUpdateState().phase !== 'downloaded' || installKind() === 'manual') return
    event.preventDefault()
    void installNow('quit')
  })
}
