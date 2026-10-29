import { describe, expect, it } from 'vitest'
import { etaLabel, etaSeconds } from './indexEta'

describe('index build time left', () => {
  const start = { database: 'ecoinvent-3.12-cutoff', at: 0, count: 0 }

  it('waits for enough progress before it promises a time', () => {
    expect(etaSeconds(start, { at: 10_000, count: 500 }, 26_533)).toBeNull() // under 20 s
    expect(etaSeconds(start, { at: 60_000, count: 100 }, 26_533)).toBeNull() // under 1 %
    expect(etaLabel(null)).toBe('estimating…')
  })

  it('extrapolates the rate seen so far to what is left', () => {
    // 2 653 activities in 10 minutes: the other 23 880 take 90 minutes more.
    expect(etaSeconds(start, { at: 600_000, count: 2653 }, 26_533)).toBeCloseTo(5400, -1)
    expect(etaLabel(5400)).toBe('about 1 h 30 min left')
    expect(etaLabel(65 * 60)).toBe('about 1 h 05 min left')
    expect(etaLabel(12 * 60)).toBe('about 12 min left')
    expect(etaLabel(40)).toBe('less than a minute left')
  })
})
