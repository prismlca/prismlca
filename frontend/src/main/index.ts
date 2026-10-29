import { app, BrowserWindow, Menu, ipcMain, powerSaveBlocker } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { dirname, join } from 'path'
import http from 'http'
import icon from '../../resources/icon.png?asset'
import { registerAi } from './ai'
import { registerCore } from './coreIpc'
import { registerDistanceIpc } from './ipc/distance'
import { registerNewsIpc } from './ipc/news'
import { registerUpdaterIpc } from './updater'
import { registerBuildInfoIpc } from './buildInfo'
import { bundledLegalFilesMissing } from './licence'
import {
  captureSplashShot,
  disableGpuForDiagnostics,
  runShotHarness,
  shotContentSize
} from './diagnostics/screenshot'
import { resolve as resolveKey } from './secrets'
import { getSettings } from './settings'
import { attachSpellcheckMenu, initSpellcheck } from './spellcheck'
import { applyRootDistrust } from './distrustedRoots'
import { disableProxyDiscovery } from './networkProxy'
import { ensureSearchModel } from './searchModel'
import { createSplash, type Splash } from './splash'
import { guardWindow } from './windowGuard'
import { adoptLegacyUserData } from './userDataMigration'
import { runProxyMain } from './mcp/proxyMain'
import { BRIDGE_IDLE_MS, BRIDGE_LAUNCH_FLAG, createIdleQuit, type IdleQuit } from './mcp/idleQuit'
import { createKeepAwake } from './keepAwake'
import { onMainsPower } from './powerSource'
import type { McpControl } from './ipc/mcp'
import type { PrepareInstallResult } from '../shared/updates'

/**
 * Electron main process.
 *
 * Responsibilities:
 *  - spawn the bundled Python/FastAPI backend as a child process,
 *  - read the one-line JSON handshake (host/port/token/version) from its stdout,
 *  - poll /health until ready and verify the backend version matches this shell
 *    (frontend + backend ship as one atomic version — see ADR-005/007),
 *  - expose connection status + info to the renderer over IPC.
 */

interface BackendInfo {
  host: string
  port: number
  token: string
  version: string
}

type AppState =
  | { state: 'starting' }
  | { state: 'ready' }
  | { state: 'version-mismatch'; detail: string }
  | { state: 'error'; detail: string }

let backend: ChildProcess | null = null
let backendInfo: BackendInfo | null = null
let status: AppState = { state: 'starting' }
let mainWindow: BrowserWindow | null = null

const APP_VERSION = app.getVersion()

function backendCommand(): { cmd: string; args: string[]; cwd?: string } {
  if (app.isPackaged) {
    // PyInstaller onedir bundle shipped via electron-builder extraResources -> resources/backend
    const dir = join(process.resourcesPath, 'backend')
    const exe = process.platform === 'win32' ? 'prism-lca-backend.exe' : 'prism-lca-backend'
    return { cmd: join(dir, exe), args: [] }
  }
  // Dev: run the backend from source via uv.
  const backendDir = join(app.getAppPath(), '..', 'backend')
  return { cmd: 'uv', args: ['run', 'prism-lca-backend'], cwd: backendDir }
}

function startBackend(): Promise<void> {
  return new Promise((resolve, reject) => {
    const { cmd, args, cwd } = backendCommand()
    // PRISM_PARENT_PID feeds the backend's self-watchdog: if this Electron process dies hard
    // (crash/SIGKILL — the 'quit' handler never runs), the backend notices and exits itself
    // instead of lingering as an orphan next to a future second instance.
    // The backend needs the same provider key for API embeddings (RAG). It travels in the child's
    // environment rather than in a config file the backend reads: the encrypted store belongs to this
    // process, and a plain-text copy on disk would undo it. Precedence — the backend's own
    // PRISM_-prefixed variable wins, then the shell's OPENROUTER_API_KEY, then the store. Passing the
    // shell key on matters: without it the chat would have a key and embeddings would not, from one
    // setting the user entered once. A key entered later is pushed over the API (see main/ai/index.ts).
    const key = process.env.PRISM_OPENROUTER_API_KEY?.trim() ? null : resolveKey('openrouter').key
    // Same rule for the OpenAI key: the backend can run its embeddings against either provider.
    const openaiKey = process.env.PRISM_OPENAI_API_KEY?.trim() ? null : resolveKey('openai').key
    backend = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PRISM_PARENT_PID: String(process.pid),
        ...(key ? { PRISM_OPENROUTER_API_KEY: key } : {}),
        ...(openaiKey ? { PRISM_OPENAI_API_KEY: openaiKey } : {})
      }
    })

    let buffer = ''
    backend.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.event === 'prism-backend-ready') {
            backendInfo = { host: msg.host, port: msg.port, token: msg.token, version: msg.version }
            resolve()
          }
          // A refusal is an answer, and a fast one. Without this the shell sat out the full 60 s
          // and reported "did not report readiness" — true, and no help at all to somebody whose
          // only problem is a second copy of PrismLCA they forgot they had open.
          if (msg.event === 'prism-backend-refused') {
            reject(new Error(String(msg.reason || 'The backend refused to start.')))
          }
        } catch {
          // ordinary (non-JSON) uvicorn log line
        }
      }
    })
    backend.stderr?.on('data', (chunk: Buffer) => console.error('[backend]', chunk.toString().trim()))
    backend.on('exit', (code) => {
      console.error(`[backend] exited with code ${code}`)
      backendInfo = null
    })
    backend.on('error', reject)

    const deadline = setTimeout(
      () => reject(new Error('Backend did not report readiness within 60 s.')),
      60_000
    )
    deadline.unref?.() // don't keep the process alive for a timer that resolve already beat
  })
}

/**
 * A transport failure that happened BEFORE anything was sent, so retrying it cannot repeat an effect.
 *
 * The backend is a local uvicorn and this process pools sockets, so a request issued just as the
 * server closes an idle keep-alive connection dies with ECONNRESET / "socket hang up" without ever
 * reaching a handler. `timeout_keep_alive` on the server side makes that rare; this makes it
 * survivable. Deliberately narrow: only these two codes, only once, and only because the write has
 * demonstrably not happened — anything broader would risk applying an edit twice.
 */
function isPreSendTransportError(e: unknown, method: string): boolean {
  const code = (e as { code?: string } | null)?.code
  const msg = e instanceof Error ? e.message : ''
  const transport = code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/i.test(msg)
  if (!transport) return false
  // A read may always be repeated. A write only when the reset hit a REUSED keep-alive socket: that
  // is the server closing an idle connection under a request it never saw (Node's own documented
  // retry case). A reset on a fresh socket can arrive after the handler ran — retrying it appended
  // a chat message twice.
  if (method === 'GET' || method === 'HEAD') return true
  return (e as { reusedSocket?: boolean }).reusedSocket === true
}

async function apiRequest(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  try {
    return await apiRequestOnce(method, path, body, extraHeaders)
  } catch (e) {
    if (!isPreSendTransportError(e, method)) throw e
    console.log(`[prism] ${method} ${path.split('?')[0]} lost its connection before sending — retrying once`)
    return apiRequestOnce(method, path, body, extraHeaders)
  }
}

function apiRequestOnce(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    if (!backendInfo) return reject(new Error('Backend is not ready.'))
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = { 'X-Prism-Token': backendInfo.token, ...extraHeaders }
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
    }
    const req = http.request(
      { host: backendInfo.host, port: backendInfo.port, path, method, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          const contentType = String(res.headers['content-type'] ?? '')
          // A binary answer (the XLSX of the Brightway export) must not pass through a JavaScript
          // string: concatenating the chunks decoded them as UTF-8 and replaced every invalid byte,
          // and the renderer could not rebuild the ZIP from that. It travels as
          // base64, marked, and the JSON/text answers keep their shape.
          if (contentType && !/json|text\/|xml|javascript/i.test(contentType)) {
            resolve({
              status: res.statusCode ?? 0,
              body: { binary: true, content_type: contentType, base64: buf.toString('base64') }
            })
            return
          }
          const data = buf.toString('utf8')
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data || '{}') })
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data })
          }
        })
        // A connection cut mid-body raises these on the RESPONSE, not the request; unhandled, the
        // promise neither resolved nor rejected and the IPC call hung.
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('Backend response was cut off.')))
      }
    )
    // Without a socket timeout, a backend that accepts the connection but never responds would
    // leave the renderer's promise pending forever (stuck spinners). 10 min covers the longest
    // legitimate calculations.
    req.setTimeout(600_000, () => req.destroy(new Error('Backend request timed out.')))
    req.on('error', (e) => {
      // Whether the socket was a pooled one, for the retry decision above.
      ;(e as { reusedSocket?: boolean }).reusedSocket = req.reusedSocket
      reject(e)
    })
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await apiRequest('GET', '/api/v1/system/health')
      if (r.status === 200) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Backend health check did not turn green.')
}

/**
 * Who started this process — a person (double-click, launcher), the MCP bridge on behalf of an
 * external agent, or a diagnostic (PRISM_SHOT/PRISM_SMOKE). It travels with the single-instance
 * handoff too: a losing SECOND start claims the running window only when a person made it, never
 * when another bridge or a screenshot did.
 */
type LaunchedBy = 'human' | 'bridge' | 'diagnostic'
const launchedBy: LaunchedBy =
  process.env.PRISM_SHOT || process.env.PRISM_SMOKE
    ? 'diagnostic'
    : process.argv.includes(BRIDGE_LAUNCH_FLAG)
      ? 'bridge'
      : 'human'

// Started by the MCP bridge rather than a person? Then the app quits once the clients fall silent,
// unless somebody claims the window (mcp/idleQuit.ts — the invisible instance that held the project
// lock for hours). Module scope: the window claims it, the start arms it; `quit` is
// wired in startApp, where the MCP control and the backend child are known.
let idle: IdleQuit = createIdleQuit({ idleMs: BRIDGE_IDLE_MS, quit: () => app.quit() })

/** What the renderer's banner shows (preload `prism.bridge`). */
function bridgeState(): { launchedBy: LaunchedBy; claimed: boolean; idleMinutes: number } {
  return { launchedBy, claimed: idle.state() === 'claimed', idleMinutes: Math.round(BRIDGE_IDLE_MS / 60000) }
}
function sendBridgeState(): void {
  const wc = mainWindow?.webContents
  if (wc && !wc.isDestroyed()) wc.send('prism:bridge', bridgeState())
}

/**
 * Leave in order: no new MCP sessions, the backend asked to exit and WAITED for (bounded), then the
 * app. `app.quit()` alone killed the child without waiting, and the data-directory lock stayed
 * held until Python actually exited — a relaunch right after could still fail.
 */
async function quitGracefully(mcp: McpControl): Promise<void> {
  mcp.shutdownNow()
  const child = backend
  if (child && child.exitCode === null && !child.killed) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill()
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 8000))])
  }
  app.quit()
}

/** End `child` for good: SIGTERM, and if it is still there after 5 s, SIGKILL (on Linux SIGTERM only
 *  sets uvicorn's exit flag again and waits for the drain; on Windows kill() is final anyway).
 *  Resolves whether the process is confirmed gone. */
async function endProcess(child: ChildProcess): Promise<boolean> {
  child.kill()
  if (await exitedWithin(child, 5_000)) return true
  child.kill('SIGKILL')
  return exitedWithin(child, 5_000)
}

/** Resolves true when `child` has exited within `ms`. */
function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * Before an update replaces the program files, the backend has to be gone (V-2):
 * on Windows a running `prism-lca-backend.exe` locks its files and the installer fails,
 * and `child.kill()` there is TerminateProcess — a write into the Brightway SQLite files cut off
 * wherever it stood. So the backend is asked to leave in order (POST /system/shutdown sets uvicorn's
 * `should_exit`), refuses while a calculation or import runs unless the user is quitting anyway
 * (`force`), and only a backend that does not leave in time is killed.
 */
async function stopBackendForUpdate(
  mcp: McpControl,
  opts: { force: boolean }
): Promise<PrepareInstallResult> {
  const child = backend
  if (!child || child.exitCode !== null || child.signalCode !== null) return { ok: true }
  const ask = async (): Promise<{ accepted: boolean; reasons: string[] }> => {
    // Its own short deadline: a backend that accepts the connection but never answers would otherwise
    // hold the install (and a quit with a downloaded update) for apiRequest's ten minutes.
    const { status, body } = await Promise.race([
      apiRequest('POST', '/api/v1/system/shutdown', { force: opts.force }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('the shutdown request got no answer within 10 s')), 10_000)
      )
    ])
    const answer = body as { accepted?: boolean; reasons?: string[] } | null
    if (status !== 200 || typeof answer?.accepted !== 'boolean') throw new Error(`HTTP ${status}`)
    return { accepted: answer.accepted, reasons: answer.reasons ?? [] }
  }
  let answer: { accepted: boolean; reasons: string[] }
  try {
    answer = await ask()
    // A request being answered right now is usually gone a moment later (a poll, a view write);
    // a calculation job or an import is not, so only the former is worth a few short retries.
    for (let i = 0; i < 3 && !answer.accepted && answer.reasons.every((r) => /request/.test(r)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      answer = await ask()
    }
  } catch (err) {
    console.error('[prism] shutdown request before the update failed:', err)
    // No answer is not a "no": the backend may have accepted after the deadline and be on its way
    // out. Nothing is installed, and the app restarts, which is right
    // whether the backend left or not.
    return {
      ok: false,
      stopped: true,
      message:
        "PrismLCA's background service did not answer in time, so the update was not installed. Restart PrismLCA and try again."
    }
  }
  if (!answer.accepted) {
    const why = answer.reasons.join(', ') || 'work is still running'
    return {
      ok: false,
      stopped: false,
      message: `PrismLCA is still busy (${why}). Install the update once that has finished.`
    }
  }
  mcp.shutdownNow()
  if (await exitedWithin(child, 30_000)) return { ok: true }
  // It accepted but did not leave: something in it is stuck. It is ended so the app can restart
  // cleanly, but the update is NOT installed after a forced end (V-2).
  await endProcess(child)
  return {
    ok: false,
    stopped: true,
    message:
      'PrismLCA could not stop its background service in time, so the update was not installed. Restart PrismLCA and try again.'
  }
}

/**
 * Before the app relaunches after a failed install: the old backend must be gone, or the new one finds
 * the instance lock still held. Asked to stop (forced — the app restarts either way), given a minute
 * to drain what it is doing, then ended.
 */
async function waitForBackendExit(): Promise<boolean> {
  const child = backend
  if (!child || child.exitCode !== null || child.signalCode !== null) return true
  try {
    await Promise.race([
      apiRequest('POST', '/api/v1/system/shutdown', { force: true }),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ])
  } catch {
    /* already leaving, or not answering — the wait below decides */
  }
  if (await exitedWithin(child, 60_000)) return true
  return endProcess(child)
}

/** Is anything still computing that a quit would destroy? Running calculation jobs live in the
 *  backend's memory only (calc_jobs.py); an unanswering backend counts as "nothing". */
async function nothingRunning(): Promise<boolean> {
  try {
    const { status, body } = await apiRequest('GET', '/api/v1/calc/jobs/running')
    if (status === 0 || status >= 400) return true
    return !((body as { running?: number } | null)?.running ?? 0)
  } catch {
    return true
  }
}

let loadFailed = false

function createWindow(splash?: Splash | null): void {
  // No File/Edit/View/Window/Help menu — PrismLCA drives everything from its own UI.
  Menu.setApplicationMenu(null)
  const shotSize = shotContentSize()
  const win = new BrowserWindow({
    width: shotSize ? shotSize.width : 1280,
    height: shotSize ? shotSize.height : 820,
    useContentSize: !!shotSize,
    resizable: !shotSize,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#131c24',
    icon, // PrismLCA app icon (taskbar / window); Windows + Linux use this, macOS uses the bundle icon
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  win.once('ready-to-show', () => {
    if (shotSize) win.setContentSize(shotSize.width, shotSize.height)
    // In screenshot mode, park the window far off-screen so a stray click can't land in it
    // while a capture is running (capturePage renders regardless of on-screen position).
    if (process.env.PRISM_SHOT) win.setPosition(-9000, 0)
    // Let the splash rest at 100% for a moment before handing over to the main window.
    // One second, not two: long enough to read "Ready.", short enough not to feel like a wait.
    if (splash) {
      splash.setStatus('Ready.', 100)
      setTimeout(() => {
        win.show()
        splash?.close()
      }, 1000)
    } else {
      win.show()
    }
  })
  mainWindow = win
  attachSpellcheckMenu(win)
  // No second window and no navigation away from the app; web links go to the browser (windowGuard.ts).
  guardWindow(win.webContents)
  // A person at the window: a click, a key, a scroll. Focus alone would not do — a new window gets
  // it from the compositor without anyone asking (Wayland), which is why the claim is an INPUT.
  // Keys come through `before-input-event` (normalised `keyDown`; the raw stream delivers
  // `rawKeyDown`, which an earlier version missed). The banner's
  // "Keep open" button is the explicit way, for anyone this heuristic misses.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown') idle.claim()
  })
  win.webContents.on('input-event', (_e, input) => {
    const t = String((input as { type?: string }).type)
    if (t === 'mouseDown' || t === 'mouseWheel' || t.startsWith('touch') || t.startsWith('gesture'))
      idle.claim()
  })
  win.webContents.on('did-fail-load', () => {
    loadFailed = true
  })
  win.webContents.on('did-finish-load', () => {
    loadFailed = false
    sendBridgeState()
  })

  // What actually became of a file the app handed to the browser. The renderer used to announce
  // "Saved <name>.pdf (438 kB)" the instant it called `<a download>.click()` — before any save
  // dialog was answered, and regardless of the answer. In one session that message appeared
  // three times while no file of that name existed anywhere; the bytes sat in ~/Downloads under a
  // Chromium temp name (V157). Only the download itself knows, so only the download may say so.
  const onWillDownload = (_event: Electron.Event, item: Electron.DownloadItem): void => {
    // Test harness only: with PRISM_DOWNLOAD_DIR set, files land there under their own name and no
    // save dialog opens — a native dialog cannot be answered from a driven session. Unset in normal use, so
    // the user keeps choosing where a file goes.
    const testDir = process.env['PRISM_DOWNLOAD_DIR']
    if (testDir) item.setSavePath(join(testDir, item.getFilename()))
    item.once('done', (_e, state) => {
      if (win.isDestroyed()) return
      win.webContents.send('prism:download', {
        filename: item.getFilename(),
        path: state === 'completed' ? item.getSavePath() : '',
        bytes: item.getReceivedBytes(),
        state // 'completed' | 'cancelled' | 'interrupted'
      })
    })
  }
  const ses = win.webContents.session
  ses.on('will-download', onWillDownload)
  win.on('closed', () => {
    // The session outlives the window (macOS: close, reopen from the dock); the listener must not
    // leak.
    ses.removeListener('will-download', onWillDownload)
    if (mainWindow === win) mainWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function startApp(): void {
  // One instance of the app per machine: a second start (the user's double-click, or the MCP bridge
  // starting the app while the user does the same) hands over to the running one and leaves. Also
  // what makes "the bridge launched the app" safe — whoever wins the lock owns the backend.
  if (!app.requestSingleInstanceLock({ launchedBy })) {
    app.quit()
    return
  }
  app.on('second-instance', (_e, _argv, _cwd, additionalData) => {
    const by = ((additionalData as { launchedBy?: string } | undefined)?.launchedBy ?? 'human') as LaunchedBy
    // Only a PERSON's second start means anything here: another bridge losing the lock is just the
    // handoff (proxyMain.ts polls for the endpoint), a screenshot run must not claim the service.
    if (by !== 'human') return
    idle.claim()
    const win = mainWindow
    if (!win) {
      // No window to show (a renderer that never loaded, macOS after closing it): make one.
      createWindow()
      return
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    if (loadFailed) win.reload()
  })

  idle = createIdleQuit({
    idleMs: BRIDGE_IDLE_MS,
    quit: () => void quitGracefully(mcp),
    canQuit: nothingRunning,
    onChange: () => sendBridgeState(),
    log: (m) => console.log(`[prism] ${m}`)
  })
  ipcMain.handle('prism:bridgeState', () => bridgeState())
  ipcMain.handle('prism:bridgeKeepOpen', () => {
    idle.claim()
    return bridgeState()
  })

  registerCore({ apiRequest, getStatus: () => status })
  // Transport distances: its own namespace beside the core surface, not under registerAi — the keys
  // and the ledger are not an AI concern, and the panel works with the assistant switched off.
  registerDistanceIpc({ apiRequest })
  // The start page's news feed. Asked for only when the user allowed it (see NewsCard).
  registerNewsIpc()
  const { mcp, chat, work } = registerAi({
    apiRequest,
    getWindow: () => mainWindow,
    onMcpActivity: () => idle.activity(),
    onMcpBusy: (d) => (d > 0 ? idle.begin() : idle.end())
  })
  // No idle sleep while an import, an index build or a run is going (keepAwake.ts).
  const keepAwake = createKeepAwake({
    hold: () => powerSaveBlocker.start('prevent-app-suspension'),
    release: (id) => powerSaveBlocker.stop(id),
    enabled: () => getSettings().keepAwake,
    onMains: onMainsPower,
    backendWork: async () => {
      const { status, body } = await apiRequest('GET', '/api/v1/system/busy')
      if (status !== 200) throw new Error(`HTTP ${status}`)
      return (body as { long_work?: string[] } | null)?.long_work ?? []
    },
    mainWork: work,
    log: (m) => console.log(`[prism] ${m}`)
  })
  // The update check — only on a click in Settings → About, never on its own (main/updater.ts). An
  // install first stops the backend in order (V-2), which needs the MCP control to close sessions.
  registerBuildInfoIpc()
  registerUpdaterIpc({
    getWindow: () => mainWindow,
    prepareInstall: (opts) => stopBackendForUpdate(mcp, opts),
    waitForBackendExit
  })

  // Screenshot/smoke diagnostics (see diagnostics/screenshot.ts). Must run before `whenReady`.
  disableGpuForDiagnostics()

  // The rename to "PrismLCA" moved the packaged app's settings folder; adopt the old
  // one's files once (see userDataMigration.ts). Before whenReady, so settings/secrets read the copies.
  if (app.isPackaged) {
    const userData = app.getPath('userData')
    const adopted = adoptLegacyUserData(userData, join(dirname(userData), 'Prism LCA'))
    if (adopted.length)
      console.log(`[prism] adopted ${adopted.length} file(s) from the former "Prism LCA" folder`)
  }

  app.whenReady().then(async () => {
    // Before any request: drop root certificates with compromised intermediates (see distrustedRoots.ts).
    applyRootDistrust()
    // Offline spell checking (bundled dictionaries) before ANY window exists. Chromium starts its
    // dictionary download with the first window of the session; set up only before the main window,
    // the splash had already fetched the system language's dictionary from Google's CDN on every
    // fresh profile (seen on Windows and Linux).
    initSpellcheck()
    // Splash card while the local engine boots (skipped headless). Splash failures must never
    // block the app — worst case we boot without one, like before.
    let splash: Splash | null = null
    if (!process.env.PRISM_SMOKE) {
      splash = await createSplash(APP_VERSION).catch(() => null)
      captureSplashShot(splash)
    }

    try {
      splash?.setStatus('Starting local engine…', 12)
      await startBackend()
      splash?.setStatus('Waiting for the LCA engine…', 55)
      await waitForHealth()
      if (backendInfo && backendInfo.version !== APP_VERSION) {
        status = {
          state: 'version-mismatch',
          detail: `Frontend ${APP_VERSION} does not match backend ${backendInfo.version}.`
        }
      } else {
        status = { state: 'ready' }
      }
    } catch (e) {
      status = { state: 'error', detail: e instanceof Error ? e.message : String(e) }
    }

    console.log(
      '[prism] startup status:',
      JSON.stringify(status),
      backendInfo ? `(backend v${backendInfo.version})` : ''
    )

    // Headless self-check: start the backend, verify readiness, then exit without a window.
    if (process.env.PRISM_SMOKE) {
      const missing = bundledLegalFilesMissing()
      if (missing.length) console.error(`[prism] smoke: bundled legal files missing: ${missing.join(', ')}`)
      app.exit(status.state === 'ready' && missing.length === 0 ? 0 : 1)
      return
    }

    // Before the search model: its download is long work too.
    if (status.state === 'ready') keepAwake.start()
    // The search model is downloaded only with the user's consent, and PrismLCA does not start without it.
    if (status.state === 'ready' && !(await ensureSearchModel(apiRequest, splash))) return

    splash?.setStatus('Loading interface…', 85)
    createWindow(splash)
    // External agents (MCP) may connect once the engine answers AND the window has loaded — only if
    // the user switched it on. Measured live: a client that connected
    // between listen and load had its first `get_state` swallowed by the renderer's navigation.
    if (status.state === 'ready') {
      const wc = mainWindow?.webContents
      if (wc && wc.isLoading()) wc.once('did-finish-load', () => void mcp.startIfEnabled())
      else void mcp.startIfEnabled()
      // Runs the record still calls "running" died with the last process: say so before any chat loads.
      void chat.onBackendReady()
    }
    // Armed on every bridge launch, whatever the backend said: an instance that failed to start
    // has even less reason to stay.
    if (launchedBy === 'bridge') idle.arm()

    // Diagnostic: PRISM_SHOT captures the app window to a PNG and quits (see diagnostics/screenshot.ts).
    runShotHarness()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('quit', () => {
    keepAwake.stop()
    mcp.shutdownNow()
    backend?.kill()
  })
}

// Before `ready`, for the bridge too: no session looks for a proxy on its own (networkProxy.ts).
disableProxyDiscovery()

/**
 * `PrismLCA --mcp-proxy` is not the app: it is the stdio bridge an external MCP client spawns
 * (main/mcp/proxyMain.ts). No window, no backend, no single-instance lock — it finds the running
 * app through the endpoint file, or starts one. Decided before any of the wiring above runs, so
 * nothing of the app's startup (IPC registration, the lock, stdout logging) touches the protocol
 * stream the client is listening on.
 */
if (process.argv.includes('--mcp-proxy')) {
  // The bridge never shows a window, and the client that spawns it may hand it no display at all
  // (Codex passes MCP servers a reduced environment). The headless platform that makes this work
  // has to be on the command line — see bridgeLaunchCommand; appending it here is too late for
  // Chromium's platform choice. Only the GPU can still be switched off from here.
  app.disableHardwareAcceleration()
  void runProxyMain().catch((e) => {
    process.stderr.write(`[prism-mcp-bridge] failed: ${e instanceof Error ? e.message : String(e)}\n`)
    app.exit(1)
  })
} else {
  startApp()
}
