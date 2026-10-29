/**
 * The slim bar of a bridge-launched, unclaimed instance: says that
 * this window was opened for an external agent and will close by itself, and how to keep it. Any
 * click in the window claims it (main watches input events); the button is the explicit way.
 */
import { isUnclaimedBridgeLaunch, keepBridgeInstanceOpen, useBridgeState } from '../lib/bridgeState'

export default function BridgeBanner(): JSX.Element | null {
  const state = useBridgeState()
  if (!isUnclaimedBridgeLaunch(state)) return null
  const n = state.idleMinutes
  return (
    <div className="bridge-banner" role="status" aria-live="polite">
      <span>
        Opened for an external agent · closes after {n} idle minute{n === 1 ? '' : 's'} · click anywhere to
        keep it
      </span>
      <button type="button" className="btn sm" onClick={() => void keepBridgeInstanceOpen()}>
        Keep open
      </button>
    </div>
  )
}
