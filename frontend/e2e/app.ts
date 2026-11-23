/**
 * Starting the real app for an end-to-end test: the built main process, preload and renderer (`out/`),
 * the Python backend it spawns from source, and nothing of the person running the tests — every
 * directory the app writes to is a fresh one under the system's temp folder, and no PRISM_* setting or
 * provider key of the calling environment reaches the app. The search index embeds with the offline
 * `hashing` backend, so no model is needed and nothing is downloaded (`searchModel: 'app'` keeps the app's
 * own model, for data that was indexed with it).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { installCommitCounter, reactRegistered } from './idle'
import { endAll, leftovers, listed, processTree, type ProcessInfo } from './processes'

export const FRONTEND = resolve(__dirname, '..')
export const FIXTURES = resolve(FRONTEND, '..', 'backend', 'tests', 'fixtures')

/** The directories one simulated installation writes to; kept across restarts within a test. */
export interface Install {
  root: string
  data: string
  userData: string
  downloads: string
}

export function freshInstall(): Install {
  return installIn(mkdtempSync(join(tmpdir(), 'prism-e2e-')))
}

/** The folders of one simulated installation under `root`. */
export function installIn(root: string): Install {
  return {
    root,
    data: join(root, 'data'),
    userData: join(root, 'user-data'),
    downloads: join(root, 'downloads')
  }
}

export function removeInstall(install: Install): void {
  // The backend may still hold a SQLite handle for a moment on Windows; a leftover temp folder is harmless
  // and must not turn a passed test into a failed one.
  try {
    rmSync(install.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
  } catch (e) {
    console.warn(`left ${install.root} behind: ${String(e)}`)
  }
}

/** Settings and keys of the calling environment that must not reach the app. The key names are those
 *  main/secrets.ts reads (ENV_VAR), Google's under both spellings. */
const NOT_PASSED_ON =
  /^(PRISM_|BRIGHTWAY|ELECTRON_RENDERER_URL|OPENROUTER|ANTHROPIC|OPENAI|GOOGLE|GEMINI|ORS_|MAPBOX)/

/** The calling environment without anything that would configure the app or its backend. */
export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || NOT_PASSED_ON.test(k)) continue
    env[k] = v
  }
  return env
}

export interface RunningApp {
  app: ElectronApplication
  page: Page
  /** The main process's and backend's output, for the report of a failed test. */
  output: string[]
  /** Errors the renderer logged; a test ends by asserting there were none. */
  rendererErrors: string[]
  /** quit() has been called: the window is gone or going, and a second quit has nothing to end. */
  stopped: boolean
}

export interface LaunchOptions {
  /**
   * How the search index embeds text. `hashing` (the default) is offline and needs no model — right for
   * an install that starts empty. `app` leaves the choice to the backend, as an installed app does: data
   * copied from a real installation was indexed with the app's search model, and hashing vectors would
   * be compared against it.
   */
  searchModel?: 'hashing' | 'app'
  /**
   * Where safeStorage keeps the key that encrypts stored provider keys. `test` (the default) is what
   * Playwright sets for every app it starts: a fixed password on Linux, a mock keychain on macOS — never
   * the person's keyring. `system` takes Playwright's switches out again (systemKeyStore.cjs), so the app
   * can read keys a person's app stored; only for an instance that was given those keys on request.
   */
  keyStore?: 'test' | 'system'
}

/** Starts the app on `install` and returns once its main window (not the splash) has loaded. */
export async function launch(
  install: Install,
  { searchModel = 'hashing', keyStore = 'test' }: LaunchOptions = {}
): Promise<RunningApp> {
  const app = await _electron.launch({
    cwd: FRONTEND,
    args: [
      // Node options go before the app's folder; Playwright's loader is required ahead of these.
      ...(keyStore === 'system' ? ['-r', join(FRONTEND, 'e2e', 'systemKeyStore.cjs')] : []),
      FRONTEND,
      `--user-data-dir=${install.userData}`,
      // GitHub's Linux runners have no setuid sandbox helper; the release's start test does the same.
      ...(process.platform === 'linux' ? ['--no-sandbox'] : [])
    ],
    env: {
      ...cleanEnv(),
      // The app keeps its Brightway projects in `brightway` under this; an inherited BRIGHTWAY2_DIR is
      // never followed (backend engine/brightway_dir.py), and cleanEnv() drops it anyway.
      PRISM_DATA_DIR: install.data,
      // Named outright, so a developer's backend/.env (read by the backend from source) cannot point the
      // app at another Brightway folder; it is the folder the app would choose by itself.
      PRISM_BRIGHTWAY_DIR: join(install.data, 'brightway'),
      XDG_CONFIG_HOME: join(install.root, 'config'),
      ...(searchModel === 'hashing' ? { PRISM_EMBEDDING_BACKEND: 'hashing' } : {}),
      PRISM_DOWNLOAD_DIR: install.downloads,
      // The checkout's own provider keys (.secrets/<provider>-key) are the person's, not the test's.
      PRISM_IGNORE_DEV_KEYS: '1',
      // Nor are the keys a developer's backend/.env may give the backend for API embeddings: an empty
      // variable outranks the file. Keys stored in the app's profile still reach the backend — the main
      // process passes them on when it starts it.
      PRISM_OPENROUTER_API_KEY: '',
      PRISM_OPENAI_API_KEY: ''
    },
    timeout: 120_000
  })
  // The counter React reports its commits to (idle.ts). Registered before the main window exists, which opens
  // only once the backend answers — some seconds of margin, not a guarantee; see the check below.
  await app.context().addInitScript(installCommitCounter)
  const output: string[] = []
  const proc = app.process()
  proc.stdout?.on('data', (b: Buffer) => output.push(b.toString()))
  proc.stderr?.on('data', (b: Buffer) => output.push(b.toString()))

  // The splash is a data: URL; the main window loads the renderer from out/renderer/index.html.
  const isMain = (p: Page): boolean => p.url().startsWith('file:')
  const page =
    app.windows().find(isMain) ?? (await app.waitForEvent('window', { predicate: isMain, timeout: 180_000 }))
  const rendererErrors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') rendererErrors.push(m.text())
  })
  page.on('pageerror', (e) => rendererErrors.push(`uncaught: ${e.message}`))
  await page.waitForLoadState('domcontentloaded')
  // The renderer's bundle has run by now, so React has registered with the counter — unless the window loaded
  // before the counter was in place. Then one reload, with the counter there from the start.
  if (!(await reactRegistered(page))) {
    console.warn(
      'launch(): the window loaded before the React commit counter was in place; reloading it once'
    )
    await page.reload()
  }
  return { app, page, output, rendererErrors, stopped: false }
}

/** How long a quit may take. The app gives its backend eight seconds to leave in order, then ends it. */
const QUIT_MS = 60_000
/** How long the processes of a finished quit may take to be gone (Chromium's helpers end a moment late). */
const AFTERMATH_MS = 10_000

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/**
 * Quits the way a person does (the window closes, the app ends its backend) and waits for the process.
 * Fails if the quit does not finish in time, or if anything the app started is still running after it —
 * a backend that outlives the app keeps the data folder locked. Whatever is left over is ended.
 *
 * What counts as the app's: its process and what descends from it, and — unless `byPath` is false —
 * anything whose command line names the install folder. A test owns its throwaway folder outright; a
 * long-lived driven session (scripts/control-prism) does not, since someone may open its files.
 */
export async function quit(
  running: RunningApp,
  install: Install,
  { byPath = true }: { byPath?: boolean } = {}
): Promise<void> {
  if (running.stopped) return
  running.stopped = true
  const proc = running.app.process()
  // A string no command line contains: the path rule then matches nothing.
  const root = byPath ? install.root : '\u0000'
  let snapshot: ProcessInfo[]
  try {
    snapshot = processTree(proc, root)
  } catch (e) {
    // Without a snapshot nothing can be checked after a quit; the app is ended through Node's own hold on
    // it, which cannot reach another process.
    proc.kill('SIGKILL')
    throw e
  }
  const look = leftovers(snapshot, root)
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    running.app.close().then(() => 'closed' as const),
    new Promise<'hung'>((done) => (timer = setTimeout(() => done('hung'), QUIT_MS)))
  ])
  clearTimeout(timer)
  let left = look()
  if (outcome === 'hung') {
    endAll(left)
    const main =
      proc.exitCode === null && proc.signalCode === null
        ? 'is still running'
        : `exited (${proc.exitCode ?? proc.signalCode})`
    throw new Error(
      `The app did not quit within ${QUIT_MS / 1000} s; its main process ${main}. Still running:${listed(left)}`
    )
  }
  for (const until = Date.now() + AFTERMATH_MS; left.length > 0 && Date.now() < until; ) {
    await sleep(500)
    left = look()
  }
  if (left.length > 0) {
    endAll(left)
    throw new Error(`The app quit, but what it started is still running:${listed(left)}`)
  }
}
