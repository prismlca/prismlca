import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'prism-distance-usage-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const u = await import('./usage')
const FILE = join(userData, 'distance-usage.json')

beforeEach(() => {
  try {
    rmSync(FILE)
  } catch {
    /* none yet */
  }
  u.resetDistanceUsageCache()
})

describe('the distance ledger', () => {
  it('books calls per day, provider and endpoint with the hand-maintained price', async () => {
    u.recordDistanceCalls('ors', 'geocode', 2)
    u.recordDistanceCalls('ors', 'route', 1)
    u.recordDistanceCalls('mapbox', 'geocode', 4)
    await u.flushDistanceUsage()
    const day = JSON.parse(readFileSync(FILE, 'utf-8'))[u.todayKey()]
    expect(day.ors.geocode).toEqual({ calls: 2, cost: 0 })
    expect(day.ors.route).toEqual({ calls: 1, cost: 0 })
    expect(day.mapbox.geocode.calls).toBe(4)
    expect(day.mapbox.geocode.cost).toBeCloseTo(0.02, 6)
    // The daily cap counts geocodes across providers.
    expect(u.usedToday('geocode')).toBe(6)
    expect(u.usedToday('route')).toBe(1)
  })

  it('keeps every booking under fifty interleaved writes', async () => {
    for (let i = 0; i < 50; i++) u.recordDistanceCalls(i % 2 ? 'ors' : 'mapbox', 'geocode', 1)
    await u.flushDistanceUsage()
    u.resetDistanceUsageCache()
    expect(u.usedToday('geocode')).toBe(50)
  })

  it('reads junk as an empty ledger and drops malformed days', () => {
    expect(u.migrate(null)).toEqual({})
    expect(u.migrate({ 'not-a-day': { ors: { geocode: { calls: 1, cost: 0 } } } })).toEqual({})
    expect(u.migrate({ '2026-09-05': { ors: { geocode: { calls: '3', cost: -1 } } } })).toEqual({
      '2026-09-05': { ors: { geocode: { calls: 3, cost: 0 } } }
    })
  })

  it('todayKey is the local calendar day', () => {
    expect(u.todayKey(new Date(2026, 8, 5, 23, 59))).toBe('2026-09-05')
    expect(u.todayKey(new Date(2026, 0, 1, 0, 1))).toBe('2026-01-01')
  })
})

describe('the daily geocoding figure', () => {
  it('counts typeahead calls together with lookups — both draw on the same plan', async () => {
    u.recordDistanceCalls('ors', 'geocode', 2)
    u.recordDistanceCalls('ors', 'autocomplete', 3)
    await u.flushDistanceUsage()
    expect(u.usedToday('geocode')).toBe(2)
    expect(u.usedGeocodingToday()).toBe(5)
  })
})
