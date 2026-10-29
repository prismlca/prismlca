import { describe, expect, it } from 'vitest'
import { DEFAULT_TRANSPORT, type TransportSettings } from '../../shared/distanceDefaults'
import { adjust } from './glec'

const on: TransportSettings = { ...DEFAULT_TRANSPORT }
const off: TransportSettings = {
  ...DEFAULT_TRANSPORT,
  glec: { road: false, air: false, rail: false, sea: false }
}

describe('GLEC adjustments', () => {
  it('road: +5 % when on, untouched when off', () => {
    expect(adjust('road', 500, on)).toMatchObject({ km: 525, raw_km: 500 })
    expect(adjust('road', 500, on).adjustment).toContain('1.05')
    expect(adjust('road', 500, off)).toEqual({ km: 500, raw_km: 500, adjustment: null })
  })

  it('air: +95 km additive, not a factor', () => {
    expect(adjust('air', 8850, on)).toMatchObject({ km: 8945, raw_km: 8850 })
    expect(adjust('air', 100, on).km).toBe(195)
    expect(adjust('air', 100, off)).toEqual({ km: 100, raw_km: 100, adjustment: null })
  })

  it('rail: the settings factor when on, bare great-circle (and says so) when off', () => {
    expect(adjust('rail', 1000, on)).toMatchObject({ km: 1200, raw_km: 1000 })
    expect(adjust('rail', 1000, { ...on, railFactor: 1.3 }).km).toBe(1300)
    const bare = adjust('rail', 1000, off)
    expect(bare.km).toBe(1000)
    expect(bare.adjustment).toMatch(/no circuity factor/)
  })

  it('sea: × 1.15 on the sailed km when on (GLEC v3.2), untouched when off, 0 stays 0', () => {
    expect(adjust('sea', 10000, on)).toMatchObject({ km: 11500, raw_km: 10000 })
    expect(adjust('sea', 10000, on).adjustment).toContain('1.15')
    expect(adjust('sea', 19613.7, off)).toEqual({ km: 19613.7, raw_km: 19613.7, adjustment: null })
    expect(adjust('sea', 0, on)).toEqual({ km: 0, raw_km: 0, adjustment: null })
  })

  it('road with a ferry/shuttle crossing: the crossing leaves km and gets no road factor', () => {
    // London → Paris: 472.3 km routed, 41.6 km of it on the Channel Tunnel shuttle (measured 29.09.2026).
    const r = adjust('road', 472.3, on, 41.6)
    expect(r.raw_km).toBe(472.3)
    expect(r.km).toBe(Math.round((472.3 - 41.6) * 1.05 * 10) / 10)
    expect(r.adjustment).toMatch(/road part .*41\.6 km crossing.*1\.05/)
    const bare = adjust('road', 472.3, off, 41.6)
    expect(bare.km).toBe(430.7)
    expect(bare.adjustment).toMatch(/road part only/)
  })

  it('rounds to one decimal', () => {
    expect(adjust('road', 123.456, on).raw_km).toBe(123.5)
    expect(adjust('road', 123.456, on).km).toBe(129.6)
  })
})
