/**
 * Waiting for the Model view to have drawn its canvas — for the requests that need what is on screen
 * (centring a process, a screenshot) after they opened the view themselves.
 */

/** How long a request waits before it acts anyway. A model opened for the first time loads its graph on
 *  the way; main gives up on a UI action after 30 s. */
const WITHIN_MS = 10_000
const EVERY_MS = 50

const frame = (): Promise<void> =>
  new Promise((resolve) =>
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => resolve())
      : setTimeout(resolve, 16)
  )

/**
 * Resolves true once `isDrawn` holds and two frames have passed — measured is not yet painted, and the
 * fit React Flow makes when it mounts lands in between. False when `within` ms pass first.
 */
export async function canvasDrawn(isDrawn: () => boolean, within = WITHIN_MS): Promise<boolean> {
  const until = Date.now() + within
  while (!isDrawn()) {
    if (Date.now() >= until) return false
    await new Promise((resolve) => setTimeout(resolve, EVERY_MS))
  }
  await frame()
  await frame()
  return true
}
