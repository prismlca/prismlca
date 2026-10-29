/**
 * How this window was started, and whether a person has taken it over.
 *
 * The MCP bridge may launch PrismLCA for an external agent. Such an instance is "unclaimed" until a
 * person clicks, types or scrolls in it; unclaimed and idle for `idleMinutes`, main quits it. The
 * renderer only shows that state — the decision and the claim detection are main's.
 *
 * The bridge API is read optionally: an older preload or a test fixture without it means "a person
 * started this", so nothing is shown and nothing crashes.
 */
import { useEffect, useState } from 'react'

export interface BridgeState {
  launchedBy: 'human' | 'bridge' | 'diagnostic'
  claimed: boolean
  idleMinutes: number
}

interface BridgeApi {
  state?: () => Promise<BridgeState>
  onState?: (cb: (s: BridgeState) => void) => () => void
  keepOpen?: () => Promise<void>
}

const api = (): BridgeApi | undefined =>
  (window as unknown as { prism?: { bridge?: BridgeApi } }).prism?.bridge

/** The person claims the instance; main answers with a state carrying `claimed: true`. */
export const keepBridgeInstanceOpen = (): Promise<void> => api()?.keepOpen?.() ?? Promise.resolve()

/** True while the banner and the drawer line should say "this closes on its own". */
export const isUnclaimedBridgeLaunch = (s: BridgeState | null): s is BridgeState =>
  s !== null && s.launchedBy === 'bridge' && !s.claimed

/** The live state: read once on mount, then follow main's pushes. `null` until known. */
export function useBridgeState(): BridgeState | null {
  const [state, setState] = useState<BridgeState | null>(null)
  useEffect(() => {
    const b = api()
    let alive = true
    // A push may overtake the initial read; once one has arrived, the read must not overwrite it.
    let pushed = false
    const off = b?.onState?.((s) => {
      pushed = true
      if (alive) setState(s)
    })
    void b
      ?.state?.()
      .then((s) => {
        if (alive && !pushed && s) setState(s)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      off?.()
    }
  }, [])
  return state
}
