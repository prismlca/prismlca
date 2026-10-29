/**
 * Reopen the welcome tour.
 *
 * Its own module rather than another export of WelcomeTour.tsx: a file that exports both a component
 * and a plain function loses React Fast Refresh, and the dev server says so on every edit
 * ("restartWelcomeTour export is incompatible"). Overview is the only caller.
 */
import { getAS, setAS } from '../lib/appSettings'

/** Clear the seen flag so the tour's own effect lets it in again. Only Finish sets it back, so a
 *  second showing has to be clicked through exactly like the first. */
export function restartWelcomeTour(): void {
  if (getAS().welcomeTourDone) setAS({ welcomeTourDone: false })
}
