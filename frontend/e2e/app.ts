/**
 * Starting the real app for an end-to-end test: the built main process, preload and renderer (`out/`),
 * the Python backend it spawns from source, and nothing of the person running the tests — every
 * directory the app writes to is a fresh one under the system's temp folder, and no PRISM_* setting or
 * provider key of the calling environment reaches the app. The search index embeds with the offline
 * `hashing` backend, so no model is needed and nothing is downloaded.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'

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
  const root = mkdtempSync(join(tmpdir(), 'prism-e2e-'))
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

/** The calling environment without anything that would configure the app or its backend. */
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v === undefined ||
      /^(PRISM_|BRIGHTWAY|ELECTRON_RENDERER_URL|OPENROUTER|ANTHROPIC|OPENAI|GOOGLE)/.test(k)
    )
      continue
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
}

/** Starts the app on `install` and returns once its main window (not the splash) has loaded. */
export async function launch(install: Install): Promise<RunningApp> {
  const app = await _electron.launch({
    cwd: FRONTEND,
    args: [
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
      XDG_CONFIG_HOME: join(install.root, 'config'),
      PRISM_EMBEDDING_BACKEND: 'hashing',
      PRISM_DOWNLOAD_DIR: install.downloads
    },
    timeout: 120_000
  })
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
  return { app, page, output, rendererErrors }
}

/** Quits the way a person does (the window closes, the app ends its backend) and waits for the process. */
export async function quit(running: RunningApp): Promise<void> {
  await running.app.close()
}
