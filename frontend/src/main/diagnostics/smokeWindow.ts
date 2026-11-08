/**
 * The window half of the start-up self-check (PRISM_SMOKE). Once the backend has answered, the real window
 * loads the real renderer through the real preload, and the check passes only when the workbench has
 * rendered and a request made from inside the page has come back through the bridge
 * (renderer → preload → main → backend). The backend half alone let a build with a broken renderer
 * bundle, a missing preload or a dead IPC channel pass as "started".
 */
import type { WebContents } from 'electron'

type Verdict = { state: 'waiting'; shows: string } | { state: 'ready' } | { state: 'failed'; detail: string }

/** Evaluated in the page, only after it has finished loading — before that, `window.prism` cannot exist yet.
 *  The workbench has rendered once it shows its navigation, or — on a fresh install without background
 *  data — the setup card in its place (workbench/SetupGate.tsx); the startup gate (App.tsx) shows neither.
 *  While waiting it reports the page's text, so a run that times out says what was on the screen. */
export const PROBE = `(async () => {
  if (!window.prism || typeof window.prism.api !== 'function')
    return { state: 'failed', detail: 'the preload bridge (window.prism) is missing in the page' }
  if (!document.querySelector('.navitem, .setup-gate')) {
    const text = document.body ? document.body.innerText : ''
    return { state: 'waiting', shows: text.replace(/\\s+/g, ' ').trim().slice(0, 300) }
  }
  const res = await window.prism.api('GET', '/api/v1/system/health')
  return res && res.status === 200
    ? { state: 'ready' }
    : { state: 'failed', detail: 'a request through the bridge answered ' + (res ? res.status : 'nothing') }
})()`

/** At most this many renderer console errors are reported with a failure — enough to see the cause. */
const MAX_CONSOLE_ERRORS = 10

/** Problems found while the window loads, or none once the workbench answered through the bridge. */
export async function checkWindow(
  wc: Pick<WebContents, 'on' | 'isLoading' | 'isDestroyed' | 'executeJavaScript'>,
  timeoutMs = 90_000,
  pollMs = 500
): Promise<string[]> {
  const problems: string[] = []
  const consoleErrors: string[] = []
  wc.on('preload-error', (_e, preloadPath, error) =>
    problems.push(`the preload script ${preloadPath} failed: ${error.message}`)
  )
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) problems.push(`the page did not load (${code} ${description}): ${url}`)
  })
  wc.on('render-process-gone', (_e, details) =>
    problems.push(`the renderer process ended: ${details.reason}`)
  )
  wc.on('console-message', (e) => {
    if (e.level === 'error') consoleErrors.push(e.message)
  })

  const deadline = Date.now() + timeoutMs
  let waitingFor = 'the page to finish loading'
  let shows = ''
  while (problems.length === 0 && Date.now() < deadline) {
    if (!wc.isDestroyed() && !wc.isLoading()) {
      waitingFor = 'the workbench to render'
      // Raced against the deadline: a renderer that hangs, or a bridge request that never returns,
      // would otherwise hold this await — and the check — far past it.
      let timer: ReturnType<typeof setTimeout> | undefined
      const verdict: Verdict = await Promise.race([
        wc
          .executeJavaScript(PROBE)
          .catch((e: unknown) => ({ state: 'failed' as const, detail: `the probe threw: ${String(e)}` })),
        new Promise<Verdict>((r) => {
          timer = setTimeout(
            () =>
              r({
                state: 'failed',
                detail: `the page did not answer the probe within ${timeoutMs / 1000} s`
              }),
            Math.max(deadline - Date.now(), 0)
          )
        })
      ]).finally(() => clearTimeout(timer))
      if (verdict.state === 'ready') return []
      if (verdict.state === 'failed') problems.push(verdict.detail)
      if (verdict.state === 'waiting') shows = verdict.shows
    }
    if (problems.length === 0) await new Promise((r) => setTimeout(r, pollMs))
  }
  if (problems.length === 0)
    problems.push(
      `waited ${Math.round(timeoutMs / 1000)} s for ${waitingFor}` +
        (shows ? `; the page shows: ${shows}` : '')
    )
  return [
    ...problems,
    ...consoleErrors.slice(0, MAX_CONSOLE_ERRORS).map((m) => `renderer console error: ${m}`)
  ]
}
