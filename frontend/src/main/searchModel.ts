import { app, dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import type { Splash } from './splash'

/**
 * The local search model (bge-m3, ~2.3 GB) is not in the installer, and it is fetched only after the
 * user agreed (privacy rule: no download without a user action). Until then the backend loads it
 * strictly from the local cache and never contacts huggingface.co.
 *
 * Two buttons, no "Later": without the model search does not work, and PrismLCA without search is
 * not a PrismLCA we start. The download runs in the backend; this side asks, then shows its progress
 * on the splash.
 */

type ApiRequest = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>

interface SearchModelState {
  state: 'ready' | 'missing' | 'downloading' | 'error'
  bytes_done: number
  bytes_total: number
  error: string | null
}

const STATE_PATH = '/api/v1/system/search-model'
const DOWNLOAD_PATH = '/api/v1/system/search-model/download'
/** The splash's progress window for the download: between "Waiting for the LCA engine…" and "Loading interface…". */
const PCT_FROM = 55
const PCT_TO = 85
/** Consecutive failed polls after which the backend counts as gone. */
const MAX_POLL_FAILURES = 10

export const CONSENT_MESSAGE =
  'PrismLCA searches databases with a language model that runs on this computer. It is not part of ' +
  'the installer: the first start downloads it once (about 2.3 GB) from huggingface.co. Sent are your IP ' +
  'address and the download library’s user agent (its own, Python’s and PyTorch’s version) — nothing ' +
  'about you or your workspaces. Without the model PrismLCA cannot run.'

async function readState(apiRequest: ApiRequest, method: 'GET' | 'POST'): Promise<SearchModelState> {
  const path = method === 'GET' ? STATE_PATH : DOWNLOAD_PATH
  const r = await apiRequest(method, path)
  if (r.status !== 200 || typeof r.body !== 'object' || r.body === null) {
    throw new Error(`The local engine answered ${r.status} to ${method} ${path}.`)
  }
  return r.body as SearchModelState
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1)
}

async function ask(parent: BrowserWindow | undefined, options: MessageBoxOptions): Promise<number> {
  const r = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  return r.response
}

function quit(): false {
  // app.quit(), not app.exit(): exit skips the quit events, and the 'quit' handler is what kills the
  // backend child process.
  app.quit()
  return false
}

/**
 * Make sure the search model is on disk before the main window opens.
 *
 * Returns true when start-up may go on, false when the user chose Quit (the app is then quitting and
 * the caller must stop). A backend that cannot answer the question at all does not block the start —
 * that is logged, and search reports its own error later.
 */
export async function ensureSearchModel(
  apiRequest: ApiRequest,
  splash: Splash | null,
  opts: { intervalMs?: number } = {}
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? 1000
  let st: SearchModelState
  try {
    st = await readState(apiRequest, 'GET')
  } catch (e) {
    console.log('[prism] search model state unavailable:', e instanceof Error ? e.message : String(e))
    return true
  }
  if (st.state === 'ready') return true
  // Headless self-check: no one to ask, and a smoke run must never start a 2 GB download.
  if (process.env.PRISM_SMOKE) return true

  const parent = splash?.win
  if (st.state !== 'downloading') {
    const choice = await ask(parent, {
      type: 'question',
      title: 'Search model needed',
      message: 'Search model needed',
      detail: CONSENT_MESSAGE,
      buttons: [`Download (${gb(st.bytes_total || 2.3e9)} GB)`, 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (choice !== 0) return quit()
  }

  for (;;) {
    const outcome = await download(apiRequest, splash, intervalMs)
    if (outcome === null) return true
    const choice = await ask(parent, {
      type: 'error',
      title: 'Download failed',
      message: 'Download failed',
      detail: `The search model could not be downloaded:\n${outcome}`,
      buttons: ['Retry', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (choice !== 0) return quit()
  }
}

/** Start (or join) the download and poll until it ends. Returns null on success, the error text otherwise. */
async function download(
  apiRequest: ApiRequest,
  splash: Splash | null,
  intervalMs: number
): Promise<string | null> {
  let st: SearchModelState
  try {
    st = await readState(apiRequest, 'POST')
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  let failures = 0
  for (;;) {
    if (st.state === 'ready') return null
    if (st.state === 'error') return st.error || 'Unknown error.'
    const total = st.bytes_total > 0 ? st.bytes_total : 1
    const share = Math.max(0, Math.min(1, st.bytes_done / total))
    splash?.setStatus(
      `Downloading search model… ${gb(st.bytes_done)} of ${gb(st.bytes_total)} GB`,
      Math.round(PCT_FROM + (PCT_TO - PCT_FROM) * share)
    )
    await new Promise((r) => setTimeout(r, intervalMs))
    try {
      // 'missing' mid-download means the backend lost the thread (restarted?) — ask it again.
      st = await readState(apiRequest, st.state === 'missing' ? 'POST' : 'GET')
      failures = 0
    } catch (e) {
      if (++failures >= MAX_POLL_FAILURES) {
        return `Lost contact with the local engine: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
}
