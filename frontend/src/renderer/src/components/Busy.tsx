/**
 * A busy label whose ellipsis moves — "Writing", "Checking 1 of 2".
 *
 * A single chapter takes minutes and the button said "Writing…" perfectly still for all of them,
 * which is indistinguishable from a click that did not register. The label is passed without
 * its dots; the animation belongs to the `.dots` pseudo-element, so nothing here has to be a string
 * with punctuation baked in.
 */
import { useEffect, useState } from 'react'

export default function Busy({ label }: { label: string }): JSX.Element {
  return (
    <span className="dots" aria-live="polite">
      {label}
    </span>
  )
}

/**
 * A busy label with a spinner and a running clock — "checking what changed · 42 s".
 *
 * For a wait that is long and has no progress to report yet: the freshness check on a report shows it
 * until the study behind it has counted its solves, and the bar takes over from there. The
 * moving dots were too little there — in a line of grey foot text they pass for
 * punctuation. A spinner is seen from across the room, and the seconds say "still going, and this is how
 * long" without pretending to know how far. No bar of its own: there is nothing to measure it against,
 * and a bar that guesses teaches the reader to stop believing it.
 */
export function BusyClock({ label }: { label: string }): JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const tick = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(tick)
  }, [])
  return (
    <span className="busy-clock" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>
        {label} · {seconds}&nbsp;s
      </span>
    </span>
  )
}
