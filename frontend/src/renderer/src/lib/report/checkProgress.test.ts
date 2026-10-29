import { describe, expect, it } from 'vitest'

import { checkProgressText } from './staleness'

/**
 * The foot's line while the freshness check waits for its study (product video, 14.10.2026: five
 * minutes behind a spinner). The count is the backend's; the time left is ours, and it is only said
 * once there is something to extrapolate from.
 */
describe('the check progress line', () => {
  it('names how far, and keeps quiet about time while the first solves are in', () => {
    // The first solve also pays the factorisation — an estimate from it alone would promise far too long.
    expect(checkProgressText({ done: 1, total: 97, elapsed: 14 })).toBe('checking what changed · 1 of 97')
    expect(checkProgressText({ done: 5, total: 97, elapsed: 6 })).toBe('checking what changed · 5 of 97')
  })

  it('extrapolates in whole minutes', () => {
    // 30 s for 10 solves, 87 to go → 261 s → "about 4 min".
    expect(checkProgressText({ done: 10, total: 97, elapsed: 30 })).toBe(
      'checking what changed · 10 of 97 · about 4 min left'
    )
  })

  it('says "under a minute" rather than counting seconds down', () => {
    expect(checkProgressText({ done: 90, total: 97, elapsed: 270 })).toBe(
      'checking what changed · 90 of 97 · under a minute left'
    )
  })

  it('says it is finishing once every solve is in', () => {
    // The build is done, and the check is assembling the snapshot and doing its arithmetic.
    expect(checkProgressText({ done: 97, total: 97, elapsed: 280 })).toBe(
      'checking what changed · 97 of 97 · finishing up'
    )
  })
})
