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

/** What the app wires to its quit: the `will-quit` listener, and the state a second start asks. */
export interface QuitHold {
  onWillQuit: (event: { preventDefault: () => void }) => void
  /** The quit is held while the backend is being ended: no new window belongs in this process. */
  holding: () => boolean
  /** A person started the app while it was ending: start it again once the backend is gone. */
  reopenAfterEnd: () => void
}

/**
 * Holds the quit — the app stays up, window-less — until the backend is gone. A backend that outlives
 * the app keeps the data-directory lock, and the next start is refused until someone ends it by hand.
 *
 * `beforeEnd` stops what still talks to the backend (MCP sessions, the keep-awake poll); `quit` runs
 * the quit again once the backend has ended, or could not be confirmed ended. A start that arrived
 * meanwhile is `relaunch`ed, but only after a confirmed end: a new instance would meet the lock.
 */
export function holdQuitForBackend(deps: {
  backend: () => ChildProcess | null
  beforeEnd: () => void
  quit: () => void
  relaunch: () => void
  graceMs?: number
}): QuitHold {
  let ending: Promise<void> | null = null
  let ended = false
  let gone = false
  let reopen = false
  /** A relaunch that fails must not keep the app from quitting. */
  const relaunch = (): void => {
    try {
      deps.relaunch()
    } catch (err) {
      console.error('[prism] relaunch after quitting failed:', err)
    }
  }
  const onWillQuit = (event: { preventDefault: () => void }): void => {
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
      .then((confirmed) => {
        ended = true
        gone = confirmed
        if (reopen && gone) relaunch()
        deps.quit()
      })
  }
  return {
    onWillQuit,
    holding: () => ending !== null,
    reopenAfterEnd: () => {
      if (reopen) return
      reopen = true
      // Arriving after the end, the quit is already under way; the relaunch still takes effect on exit.
      if (ended && gone) relaunch()
    }
  }
}
