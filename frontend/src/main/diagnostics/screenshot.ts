/**
 * The documentation/screenshot harness — diagnostics tooling, not app behaviour.
 *
 * PRISM_SHOT=<file.png> captures the app window to a PNG and quits; PRISM_SHOT_SCRIPT drives the UI
 * into a state worth photographing first; PRISM_SHOT_SIZE pins an exact content size;
 * PRISM_SHOT_SPLASH captures the splash card; PRISM_SMOKE is the headless start-and-exit self-check
 * (its exit decision stays in the startup flow, which owns the status). All of this used to live
 * inline in `app.whenReady()` in main/index.ts — ~160 lines of tooling wrapped around the twenty
 * that actually start the app.
 */
import { app, BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Splash } from '../splash'

/** PRISM_SHOT_SIZE ("1920x1080") pins an exact CONTENT size for documentation screenshots
 *  (and blocks the WM from maximizing), so shots come out at a known office resolution. */
export function shotContentSize(): { width: number; height: number } | null {
  const m = (process.env.PRISM_SHOT_SIZE || '').match(/^(\d+)x(\d+)$/)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

/** A documentation/screenshot instance renders off-screen and never needs hardware acceleration — and
 *  asking for it is a way to lose the run: on a machine already running another Electron instance the GPU
 *  process failed to launch five times and Chromium then aborts the whole app ("GPU process isn't usable.
 *  Goodbye."), which killed a screenshot run four chapters in. Software rendering is slower and cannot
 *  take the app down with it. Must be called before `whenReady`.
 *
 *  Not on Linux since the move to Electron 44: there software rendering is the run that
 *  dies. On Wayland the software GPU process no longer starts in its sandbox ("GPU process launch
 *  failed: error_code=1002", then the abort above), and without the sandbox the capture still fails
 *  with UnknownVizError; measured on Fedora with Electron 43 and 44, while Electron 33 and X11 were
 *  fine. A visible window rendered by the real GPU captures cleanly, so Linux keeps it. */
export function disableGpuForDiagnostics(): void {
  if ((process.env.PRISM_SHOT || process.env.PRISM_SMOKE) && process.platform !== 'linux') {
    app.disableHardwareAcceleration()
  }
}

/** Diagnostic (like PRISM_SHOT): capture the splash card to a PNG shortly after it appears. */
export function captureSplashShot(splash: Splash | null): void {
  if (!process.env.PRISM_SHOT_SPLASH || !splash) return
  const target = process.env.PRISM_SHOT_SPLASH
  setTimeout(() => {
    void splash.win.webContents
      .capturePage()
      .then((img) => {
        writeFileSync(target, img.toPNG())
        console.log('[prism] splash screenshot written:', target)
      })
      .catch((err) => console.error('[prism] splash screenshot failed:', err))
  }, 1500)
}

/**
 * Capture the app window to a PNG (only the window, not the desktop) and quit.
 *
 * PRISM_SHOT_SCRIPT may point at a JS file executed in the renderer first, to drive the UI into a
 * state worth photographing. PRISM_SHOT_DELAY (ms) is a **deadline, not a wait**: the capture happens
 * as soon as the script sets `window.__prismShotReady = true`, and the deadline is only the fallback
 * for a script that never gets there. It used to be a fixed sleep, so a page that was ready in twenty
 * seconds still sat there until the timer expired — minutes of watching a finished screen.
 */
export function runShotHarness(): void {
  if (!process.env.PRISM_SHOT) return
  const deadline = Number(process.env.PRISM_SHOT_DELAY) || 8000
  const shotSize = shotContentSize()
  const started = Date.now()
  let captured = false

  const capture = async (reason: string): Promise<void> => {
    if (captured) return
    captured = true
    try {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        // Re-assert the shot size (the WM may have tiled/maximized on show).
        if (shotSize && !win.isDestroyed()) {
          win.unmaximize?.()
          win.setContentSize(shotSize.width, shotSize.height)
          await new Promise((r) => setTimeout(r, 300))
        }
        const img = await win.webContents.capturePage()
        writeFileSync(process.env.PRISM_SHOT as string, img.toPNG())
        console.log(
          `[prism] screenshot written after ${Math.round((Date.now() - started) / 1000)}s (${reason}):`,
          process.env.PRISM_SHOT
        )
      }
    } catch (err) {
      console.error('[prism] screenshot failed:', err)
    }
    app.quit()
  }

  if (process.env.PRISM_SHOT_SCRIPT) {
    setTimeout(() => {
      const win = BrowserWindow.getAllWindows()[0]
      const src = readFileSync(process.env.PRISM_SHOT_SCRIPT as string, 'utf-8')
      void win?.webContents
        .executeJavaScript(src)
        .catch((err) => console.error('[prism] shot script failed:', err))
    }, 6000)

    // Poll for the script's own "ready" flag. A script that sets it gets photographed the moment it
    // is done; one that forgets falls back to the deadline, so old scripts keep working.
    const poll = setInterval(() => {
      if (captured || Date.now() - started > deadline) {
        clearInterval(poll)
        return
      }
      const win = BrowserWindow.getAllWindows()[0]
      void win?.webContents
        .executeJavaScript(
          // Also drain `__prismShotLog`: a shot script has no other way to report back, and a
          // screenshot is a poor debugger — the renderer's console does not reach this terminal.
          '(() => { const n = window.__prismShotLog ?? null; window.__prismShotLog = null;' +
            ' return [window.__prismShotReady === true, n] })()'
        )
        .then(([ready, note]: [boolean, string | null]) => {
          if (note) console.log('[prism] shot script:', note)
          if (ready) {
            clearInterval(poll)
            void capture('script ready')
          }
        })
        .catch(() => undefined) // a navigating renderer rejects; try again next tick
    }, 500)
  }

  setTimeout(() => void capture('deadline'), deadline)
}
