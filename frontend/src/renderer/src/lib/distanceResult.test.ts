import { describe, expect, it } from 'vitest'
import { resultView } from './distanceResult'
import type { DistanceBatch, DistancePairResult } from './distance'

/**
 * The flight that made the panel unreadable: Stuttgart → Boston, three figures
 * among seven paragraphs, and the assistant's parameter names in a hint meant for a person.
 */
const NEAREST =
  'Nearest major terminal by straight line — freight often uses a bigger one further away; name it with from_terminal / to_terminal if the study knows it.'
const ROAD_ADJ = 'routed distance × 1.05 (GLEC v3.2 / ISO 14083: +5 % planned → actual)'
const flight: DistancePairResult = {
  from: { text: 'Stuttgart, Germany', resolved: 'Stuttgart, BW, Germany' },
  to: { text: 'Boston, USA', resolved: 'Boston, MA, USA' },
  km: 6107.3,
  raw_km: 6012.3,
  adjustment: 'great-circle distance + 95 km for this flight leg (GLEC v3.2 / EN 16258)',
  access: {
    from: {
      terminal: 'Stuttgart Airport (STR, DE)',
      code: 'STR',
      chosen: 'nearest',
      straight_km: 8,
      km: 9.8,
      raw_km: 9.4,
      adjustment: ROAD_ADJ,
      note: NEAREST
    },
    to: {
      terminal: 'Boston Logan International Airport (BOS, US)',
      code: 'BOS',
      chosen: 'nearest',
      straight_km: 4,
      km: 6.3,
      raw_km: 6,
      adjustment: ROAD_ADJ,
      note: NEAREST
    }
  }
}
const batch = {
  mode: 'air',
  attribution: 'Great-circle distance (WGS84) · …',
  results: [flight]
} as unknown as DistanceBatch

describe('resultView — a flight with road legs', () => {
  const v = resultView('air', flight, batch)

  it('is three rows in travel order, each with its own number', () => {
    expect(v.legs.map((l) => [l.label, l.path, l.km])).toEqual([
      ['Road to the airport', 'Stuttgart, BW, Germany → STR', 9.8],
      ['Flight', 'Stuttgart Airport (STR, DE) → Boston Logan International Airport (BOS, US)', 6107.3],
      ['Road from the airport', 'BOS → Boston, MA, USA', 6.3]
    ])
    expect(v.legs.every((l) => l.warnings.length === 0)).toBe(true)
  })

  it('says once what to do, in words for the person at the panel', () => {
    expect(v.hints[0]).toMatch(/^Three separate legs/)
    expect(v.hints.filter((h) => /nearest major ones/.test(h))).toHaveLength(1)
    expect(v.hints.join(' ')).not.toMatch(/from_terminal|to_terminal/)
  })

  it('folds the derivation away, for every leg', () => {
    expect(v.details).toEqual([
      'Flight: 6012.3 km before adjustment — great-circle distance + 95 km for this flight leg (GLEC v3.2 / EN 16258).',
      `Road to the airport: 9.4 km before adjustment — ${ROAD_ADJ}.`,
      `Road from the airport: 6 km before adjustment — ${ROAD_ADJ}.`
    ])
  })
})

describe('resultView — what stays visible', () => {
  it('keeps a ferry crossing and an unmeasured leg on their rows', () => {
    const road = resultView(
      'road',
      { from: { text: 'A' }, to: { text: 'B' }, km: 300, crossing: { km: 41.8, note: '' } },
      { attribution: '' } as unknown as DistanceBatch
    )
    expect(road.legs[0].warnings[0]).toMatch(/^Plus 41.8 km on a ferry/)
    const air = resultView(
      'air',
      {
        ...flight,
        access: { from: { ...flight.access!.from!, km: undefined, error: 'No road route found.' } }
      },
      batch
    )
    expect(air.legs[0]).toMatchObject({ km: null, error: 'No road route found.' })
  })

  it('shows the batch caveats as notices', () => {
    const v = resultView('rail', { from: { text: 'A' }, to: { text: 'B' }, km: 10 }, {
      rail_caveat: 'Rail distance is the great-circle distance times a circuity factor.'
    } as unknown as DistanceBatch)
    expect(v.notices).toEqual(['Rail distance is the great-circle distance times a circuity factor.'])
  })
})
