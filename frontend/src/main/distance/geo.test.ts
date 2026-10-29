import { describe, expect, it } from 'vitest'
import { geodesicKm, haversineKm } from './geo'

// Frankfurt airport → Shanghai Pudong: every airline route table puts the great circle at ~8 850 km.
const FRA = [50.033, 8.57] as const
const PVG = [31.144, 121.808] as const

describe('geodesic distance', () => {
  it('matches the published great-circle figure for a long-haul air leg', () => {
    const km = geodesicKm(...FRA, ...PVG)
    expect(km).toBeGreaterThan(8_800)
    expect(km).toBeLessThan(8_900)
    // Sphere and ellipsoid agree to half a percent; if not, one of them is broken.
    expect(Math.abs(km - haversineKm(...FRA, ...PVG)) / km).toBeLessThan(0.005)
  })

  it('is zero for the same point and symmetric', () => {
    expect(geodesicKm(49.4, 8.7, 49.4, 8.7)).toBe(0)
    expect(geodesicKm(...FRA, ...PVG)).toBeCloseTo(geodesicKm(...PVG, ...FRA), 6)
  })

  it('falls back rather than throwing for a near-antipodal pair', () => {
    const km = geodesicKm(0, 0, 0.5, 179.7)
    expect(km).toBeGreaterThan(19_000)
    expect(km).toBeLessThan(20_100)
  })

  it('agrees with the Python twin to ten metres (Heidelberg → Hamburg)', () => {
    // backend/tests/test_distances.py pins engine/geodesy.py to the same 469.49 km for this pair.
    expect(geodesicKm(49.41, 8.68, 53.55, 9.99)).toBeCloseTo(469.49, 2)
  })
})
