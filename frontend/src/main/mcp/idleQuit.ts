/**
 * Why a PrismLCA that the MCP bridge started may quit on its own.
 *
 * The bridge launches the app detached and the app outlives the bridge — on purpose, so a window
 * the user is working in does not vanish when the client disconnects. But a client like Codex keeps
 * one bridge per thread alive for as long as its own server lives, and a code-review run that never
 * touched a tool once left an invisible PrismLCA with a 2 GB backend holding the project lock for hours;
 * a later start by hand then failed without a word.
 *
 * So an app that (1) was started by the bridge, (2) has never been CLAIMED by a person — no mouse
 * click, key press or scroll in its window, no second start by hand — and (3) has seen no MCP
 * activity for `idleMs` quits. The bridge notices the closed session and starts the app again on the
 * next call; that is what its `disconnected` state is for. A claimed app never quits on its own,
 * whatever the clients do: once a person has touched it, it is theirs.
 *
 * Electron-free, so the rule is testable with fake timers; index.ts wires it to `app.quit()`.
 */

/** The argument the bridge adds when IT starts the app (proxyMain.ts); never set by a user's launcher. */
export const BRIDGE_LAUNCH_FLAG = '--launched-by-bridge'

/** Ten minutes: long enough for a client's pause between calls, short enough that a forgotten
 *  review instance does not sit on the lock through a working day. */
export const BRIDGE_IDLE_MS = 10 * 60 * 1000

export type IdleQuitState = 'off' | 'armed' | 'claimed'

export interface IdleQuit {
  /** Start counting (bridge-launched app, backend ready). No effect once claimed. */
  arm: () => void
  /** Something happened over MCP: a session opened, a call finished. Restarts the clock. */
  activity: () => void
  /**
   * Work in flight: a tool call admitted, a question card waiting on a person. While any is open the
   * clock does not run — "no new call for ten minutes" is not idle while a 15-minute `ask_user`
   * waits. `end` restarts the clock once the last one closes.
   */
  begin: () => void
  end: () => void
  /** A person took the app over. Final: it never quits on its own again. */
  claim: () => void
  state: () => IdleQuitState
}

export function createIdleQuit(deps: {
  idleMs: number
  quit: () => void
  /** Asked when the clock runs out: false = something still matters (a running calculation job) —
   *  the clock starts over instead. Absent = always allowed. */
  canQuit?: () => Promise<boolean>
  /** The state moved (armed, claimed) — the renderer's banner listens. */
  onChange?: (state: IdleQuitState) => void
  log?: (msg: string) => void
}): IdleQuit {
  let state: IdleQuitState = 'off'
  let busy = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const clear = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const schedule = (): void => {
    clear()
    if (state !== 'armed' || busy > 0) return
    timer = setTimeout(() => {
      timer = null
      if (state !== 'armed' || busy > 0) return
      if (!deps.canQuit) {
        deps.log?.(
          `bridge-launched and idle for ${Math.round(deps.idleMs / 60000)} min without a user — quitting; ` +
            'the bridge starts PrismLCA again on the next call.'
        )
        deps.quit()
        return
      }
      void deps.canQuit().then(
        (ok) => {
          if (state !== 'armed' || busy > 0) return
          if (!ok) {
            deps.log?.('idle, but work is still running (a calculation job) — checking again later.')
            schedule()
            return
          }
          deps.log?.(
            `bridge-launched and idle for ${Math.round(deps.idleMs / 60000)} min without a user — quitting; ` +
              'the bridge starts PrismLCA again on the next call.'
          )
          deps.quit()
        },
        () => schedule() // the question itself failed: not a reason to quit, try again later
      )
    }, deps.idleMs)
    // Never keep the process alive on this timer's account alone.
    ;(timer as { unref?: () => void }).unref?.()
  }
  return {
    arm: () => {
      if (state !== 'off') return
      state = 'armed'
      deps.onChange?.(state)
      deps.log?.(
        `started by the MCP bridge — quits after ${Math.round(deps.idleMs / 60000)} min without MCP activity unless a user takes over.`
      )
      schedule()
    },
    activity: () => {
      if (state === 'armed') schedule()
    },
    begin: () => {
      busy++
      clear()
    },
    end: () => {
      busy = Math.max(0, busy - 1)
      if (busy === 0) schedule()
    },
    claim: () => {
      if (state === 'claimed') return
      const was = state
      state = 'claimed'
      clear()
      deps.onChange?.(state)
      if (was === 'armed') deps.log?.('a user took over the window — it stays open.')
    },
    state: () => state
  }
}
