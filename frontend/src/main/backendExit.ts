/**
 * Ending the backend child process for good: asked first, then made to.
 *
 * On Linux SIGTERM only sets uvicorn's exit flag and waits for the requests in flight, and a
 * computation that never returns to Python never sees the signal at all — so every path that needs
 * the backend gone escalates to SIGKILL after a grace period. On Windows `kill()` is
 * TerminateProcess, final the first time: a write into the Brightway files is cut off wherever it
 * stood, and the `uv run` of a source checkout dies without its Python. So a quit first asks over
 * HTTP (POST /system/shutdown sets the same flag SIGTERM sets), on every platform alike, and a
 * signal follows only when the request goes unanswered or the backend does not leave in time.
 */
import type { ChildProcess } from 'child_process'

/** How long a quitting app gives the backend to leave in order before it is killed. */
export const QUIT_GRACE_MS = 8_000
/** How long the request to leave may go unanswered. The endpoint answers on the event loop at once;
 *  a backend that does not is stuck, and waiting longer would only delay the signal. */
export const ASK_TO_LEAVE_MS = 2_000

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
 * End `child` the way a quit should: `ask` it to leave (resolves whether it agreed), wait up to
 * `graceMs` for it to go, and kill it only if it agreed and stayed. A request that fails, is refused
 * or goes unanswered for ASK_TO_LEAVE_MS falls back to `endProcess` — the signals, as before.
 * Resolves whether the process is confirmed gone.
 */
export async function leaveInOrder(
  child: ChildProcess,
  ask: () => Promise<boolean>,
  graceMs = QUIT_GRACE_MS
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const agreed = await Promise.race([
    ask().catch((err) => {
      console.error('[prism] asking the backend to leave failed:', err)
      return false
    }),
    new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), ASK_TO_LEAVE_MS)))
  ])
  clearTimeout(timer)
  if (!agreed) {
    console.log('[prism] the backend did not agree to leave in time — ending it')
    return endProcess(child, graceMs)
  }
  if (await exitedWithin(child, graceMs)) {
    console.log('[prism] the backend left in order')
    return true
  }
  // It agreed and is still there: busy in work that does not return to Python. SIGTERM would only set
  // the flag it already has, so it is killed right away.
  console.log(`[prism] the backend agreed to leave but was still there after ${graceMs / 1000} s — ending it`)
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
 * `beforeEnd` stops what still talks to the backend (MCP sessions, the keep-awake poll); `askToLeave`
 * sends the request to leave (see leaveInOrder); `quit` runs the quit again once the backend has
 * ended, or could not be confirmed ended. A start that arrived meanwhile is `relaunch`ed, but only
 * after a confirmed end: a new instance would meet the lock.
 */
export function holdQuitForBackend(deps: {
  backend: () => ChildProcess | null
  beforeEnd: () => void
  askToLeave: () => Promise<boolean>
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
    ending = leaveInOrder(child, deps.askToLeave, deps.graceMs ?? QUIT_GRACE_MS)
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
