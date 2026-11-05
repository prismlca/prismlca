/**
 * Ending the backend child process for good: asked first, then made to.
 *
 * On Linux SIGTERM only sets uvicorn's exit flag and waits for the requests in flight, and a
 * computation that never returns to Python never sees the signal at all — so every path that needs
 * the backend gone escalates to SIGKILL after a grace period. On Windows `kill()` is
 * TerminateProcess, final the first time.
 */
import type { ChildProcess } from 'child_process'

/** How long a quitting app gives the backend to leave in order before it is killed. */
export const QUIT_GRACE_MS = 8_000

/** A started process that has not exited yet. One that never spawned has no pid and never exits. */
export function isRunning(child: ChildProcess | null): child is ChildProcess {
  return !!child && child.pid !== undefined && child.exitCode === null && child.signalCode === null
}

/** Resolves true when `child` has exited within `ms`. */
export function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/** End `child` for good: SIGTERM, and if it is still there after `graceMs`, SIGKILL.
 *  Resolves whether the process is confirmed gone. */
export async function endProcess(child: ChildProcess, graceMs = 5_000): Promise<boolean> {
  child.kill()
  if (await exitedWithin(child, graceMs)) return true
  child.kill('SIGKILL')
  return exitedWithin(child, 5_000)
}

/**
 * The app's `will-quit` listener: the app stays up, window-less, until the backend is gone. A backend
 * that outlives the app keeps the data-directory lock, and the next start is refused until someone
 * ends it by hand.
 *
 * `beforeEnd` stops what still talks to the backend (MCP sessions, the keep-awake poll); `quit` runs
 * the quit again once the backend has ended, or could not be confirmed ended.
 */
export function holdQuitForBackend(deps: {
  backend: () => ChildProcess | null
  beforeEnd: () => void
  quit: () => void
  graceMs?: number
}): (event: { preventDefault: () => void }) => void {
  let ending: Promise<void> | null = null
  let ended = false
  return (event) => {
    if (ended) return
    if (ending) {
      event.preventDefault()
      return
    }
    const child = deps.backend()
    if (!isRunning(child)) return
    event.preventDefault()
    try {
      deps.beforeEnd()
    } catch (err) {
      console.error('[prism] before ending the backend:', err) // the backend still has to go
    }
    ending = endProcess(child, deps.graceMs ?? QUIT_GRACE_MS)
      .catch(() => false)
      .then(() => {
        ended = true
        deps.quit()
      })
  }
}
