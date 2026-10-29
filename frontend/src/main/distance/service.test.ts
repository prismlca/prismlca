/**
 * The orchestration, with the network faked: geocoder choice and fallback, per-pair failures,
 * named skips at the caps, the sea call to the backend, and the attribution every answer carries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TRANSPORT, type TransportSettings } from '../../shared/distanceDefaults'

const userData = mkdtempSync(join(tmpdir(), 'prism-distance-service-'))
vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const { computeDistances, distancesAvailable, effectiveGeocoder } = await import('./service')
const { resetGeocodeCache } = await import('./geocode')
const { resetDistanceUsageCache, flushDistanceUsage } = await import('./usage')
const { TurnBudget } = await import('./types')

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** A geocoder that knows three places, and a router that measures 480 km between any two. */
function fakeFetch(): ReturnType<typeof vi.fn> {
  const places: Record<string, [number, number, string]> = {
    heidelberg: [8.69, 49.41, 'Heidelberg, Germany'],
    hamburg: [9.99, 53.55, 'Hamburg, Germany'],
    shanghai: [121.47, 31.23, 'Shanghai, China']
  }
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.startsWith('/pelias')) {
      const q = (url.searchParams.get('text') ?? '').toLowerCase()
      const p = places[q]
      return json({
        features: p
          ? [{ geometry: { coordinates: [p[0], p[1]] }, properties: { label: p[2], country_a: 'DEU' } }]
          : []
      })
    }
    if (url.pathname.startsWith('/search/geocode/v6')) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const p = places[q]
      return json({
        features: p ? [{ geometry: { coordinates: [p[0], p[1]] }, properties: { full_address: p[2] } }] : []
      })
    }
    if (url.pathname.includes('/directions/driving-hgv')) {
      expect((init?.headers as Record<string, string>).Authorization).toBe('ors-key')
      return json({ routes: [{ summary: { distance: 480_000 } }] }, 200, { 'x-ratelimit-remaining': '39' })
    }
    return json({ error: 'unexpected ' + url.toString() }, 500)
  })
}

// Access legs off for the general tests: they pin geocoding, caps and the main legs place to place.
// The access legs (default ON in the product) have their own describe block at the end.
const settings: TransportSettings = { ...DEFAULT_TRANSPORT, accessLegs: false }
const keys = { ors: 'ors-key', mapbox: 'pk.x' }
const noBackend = async (): Promise<{ status: number; body: unknown }> => ({ status: 500, body: null })

beforeEach(async () => {
  resetGeocodeCache()
  await flushDistanceUsage()
  resetDistanceUsageCache()
})

describe('geocoder choice', () => {
  it('follows the setting and nothing else: without the chosen key there is none, never the other', () => {
    expect(effectiveGeocoder(settings, keys)).toBe('ors')
    expect(effectiveGeocoder({ ...settings, geocoder: 'mapbox' }, keys)).toBe('mapbox')
    // Place names go only to the service the user picked — a stored key of the other one is not a licence.
    expect(effectiveGeocoder({ ...settings, geocoder: 'mapbox' }, { ors: 'k', mapbox: null })).toBeNull()
    expect(effectiveGeocoder(settings, { ors: null, mapbox: 'pk' })).toBeNull()
    expect(distancesAvailable(settings, { ors: null, mapbox: 'pk' })).toBe(false)
    expect(effectiveGeocoder(settings, { ors: null, mapbox: null })).toBeNull()
    expect(distancesAvailable(settings, { ors: null, mapbox: null })).toBe(false)
  })

  it('says what the chosen geocoder lacks, and offers the other only when its key is there', async () => {
    const run = (geocoder: 'ors' | 'mapbox', k: { ors: string | null; mapbox: string | null }) =>
      computeDistances('air', [{ from: 'Berlin', to: 'Paris' }], {
        settings: { ...settings, geocoder },
        keys: k,
        backend: async () => ({ status: 200, body: { matches: [] } })
      })
    await expect(run('ors', { ors: null, mapbox: 'pk' })).rejects.toThrow(
      /no openrouteservice key yet — the user can add it there, or choose Mapbox, whose key is already stored/
    )
    await expect(run('mapbox', { ors: null, mapbox: null })).rejects.toThrow(
      /no Mapbox token yet — the user can add it there\.$/
    )
  })
})

describe('computeDistances', () => {
  it('road: geocodes both ends, routes, applies +5 %, attributes routing and geocoding', async () => {
    const fetchImpl = fakeFetch()
    const turn = new TurnBudget(30)
    const out = await computeDistances('road', [{ from: 'Heidelberg', to: 'Hamburg' }], {
      settings,
      keys,
      turn,
      backend: noBackend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(out.mode).toBe('road')
    expect(out.geocoder).toBe('ors')
    expect(out.results[0]).toMatchObject({ raw_km: 480, km: 504 })
    expect(out.results[0].from).toMatchObject({ resolved: 'Heidelberg, Germany' })
    expect(out.attribution).toContain('openrouteservice.org by HeiGIT')
    expect(out.attribution).toContain('OpenStreetMap contributors')
    expect(out.attribution).toContain('Geocoding: openrouteservice')
    expect(turn.used).toBe(3)
    expect(out.quota).toMatchObject({ turn_used: 3, turn_limit: 30, day_geocode_used: 2, day_route_used: 1 })
  })

  it('air and rail: no routing call, rail carries the caveat and the factor', async () => {
    const fetchImpl = fakeFetch()
    const air = await computeDistances('air', [{ from: 'Heidelberg', to: 'Shanghai' }], {
      settings,
      keys: { ors: 'ors-key', mapbox: null },
      backend: noBackend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(air.results[0].raw_km).toBeGreaterThan(8_700)
    expect(air.results[0].km).toBeCloseTo((air.results[0].raw_km ?? 0) + 95, 1)
    expect(air.rail_caveat).toBeUndefined()
    const rail = await computeDistances('rail', [{ from: 'Heidelberg', to: 'Hamburg' }], {
      settings,
      keys,
      backend: noBackend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(rail.rail_caveat).toMatch(/rail infrastructure/)
    expect(rail.results[0].km).toBeCloseTo((rail.results[0].raw_km ?? 0) * 1.2, 0)
    const routed = fetchImpl.mock.calls.filter((c) => String(c[0]).includes('directions'))
    expect(routed).toHaveLength(0)
  })

  it('sea: sends coordinates to the backend and keeps the snap distances apart from the km', async () => {
    const fetchImpl = fakeFetch()
    const backend = vi.fn(async (_m: string, path: string, body?: unknown) => {
      // Neither end names a port, so the catalogue answers "none" and both go to the geocoder.
      if (path === '/api/v1/distances/places/resolve')
        return {
          status: 200,
          body: {
            items: [
              { match: null, error: null },
              { match: null, error: null }
            ]
          }
        }
      expect(path).toBe('/api/v1/distances/sea')
      expect((body as { legs: unknown[] }).legs).toHaveLength(1)
      return {
        status: 200,
        body: {
          legs: [{ km: 19613.7, from_snap_km: 33.1, to_snap_km: 2.2, passages: ['suez'], error: null }]
        }
      }
    })
    const out = await computeDistances('sea', [{ from: 'Shanghai', to: 'Hamburg' }], {
      settings,
      keys,
      backend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    // GLEC v3.2 sea factor on the sailed km only; the snap offsets stay as measured.
    expect(out.results[0]).toMatchObject({
      km: 22555.8,
      raw_km: 19613.7,
      sea: { from_snap_km: 33.1, to_snap_km: 2.2, passages: ['suez'] }
    })
    expect(out.results[0].adjustment).toMatch(/1\.15/)
    expect(out.method).toMatch(/^sea v/)
    expect(out.results[0].note).toMatch(/NOT included/)
    // The passages that were sailed, not a generic canal: a Santos → Hamburg leg must not read "via Suez".
    expect(out.results[0].note).toMatch(/via suez/)
    expect(out.results[0].note).toMatch(/via="cape"/)
    expect(out.attribution).toContain('searoute')
  })

  it('road: a ferry/shuttle crossing is taken out of km and reported as its own leg', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/directions/driving-hgv'))
        // London → Paris as openrouteservice answered it (Channel Tunnel shuttle = 10).
        return json({
          routes: [
            {
              summary: { distance: 472319.2 },
              extras: {
                waycategory: {
                  summary: [
                    { value: 3, distance: 243119.0 },
                    { value: 1, distance: 128470.4 },
                    { value: 0, distance: 56290.8 },
                    { value: 10, distance: 41605.3 },
                    { value: 2, distance: 2674.6 },
                    { value: 8, distance: 159.1 }
                  ]
                }
              }
            }
          ]
        })
      return json({ error: 'unexpected' }, 500)
    })
    const out = await computeDistances('road', [{ from: '51.5072, -0.1276', to: '48.8566, 2.3522' }], {
      settings,
      keys,
      backend: noBackend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    const r = out.results[0]
    expect(r.crossings).toBe('present')
    expect(r.crossing?.km).toBe(41.8)
    expect(r.crossing?.note).toMatch(/ferry or a vehicle shuttle train .*NOT in km/)
    expect(r.raw_km).toBe(472.3)
    expect(r.km).toBe(Math.round((472.3192 - 41.7644) * 1.05 * 10) / 10)
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body))
    expect(body.extra_info).toEqual(['waycategory'])
  })

  it('road: a route whose crossing check cannot be made says so — never "no ferry"', async () => {
    const out = await computeDistances('road', [{ from: 'Heidelberg', to: 'Hamburg' }], {
      settings,
      keys,
      backend: noBackend,
      fetchOpts: { fetchImpl: fakeFetch() as unknown as typeof fetch }
    })
    expect(out.results[0].crossings).toBe('unresolved')
    expect(out.results[0].note).toMatch(/could not be checked for ferry/)
    expect(out.results[0].crossing).toBeUndefined()
  })

  it('the same point twice is 0 km without a request — and air does not get its 95 km', async () => {
    const fetchImpl = fakeFetch()
    for (const mode of ['road', 'air'] as const) {
      const out = await computeDistances(mode, [{ from: '53.55, 9.99', to: '53.55, 9.99' }], {
        settings,
        keys,
        backend: noBackend,
        fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
      })
      expect(out.results[0]).toMatchObject({ km: 0, raw_km: 0, adjustment: null })
      expect(out.results[0].note).toMatch(/same point/)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('road: 0 km between two different places is an error, not "no transport"', async () => {
    const fetchImpl = vi.fn(async () => json({ routes: [{ summary: { distance: 0 } }] }))
    const out = await computeDistances('road', [{ from: '53.55, 9.99', to: '53.56, 9.99' }], {
      settings,
      keys,
      backend: noBackend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(out.results[0].km).toBeUndefined()
    expect(out.results[0].error).toMatch(/0 km between two different places/)
  })

  it("road: after one HTTP 403 (the day's quota) no further request goes out", async () => {
    const fetchImpl = vi.fn(async () => json({ error: 'Daily quota reached or API key unauthorized' }, 403))
    const pairs = Array.from({ length: 6 }, (_, i) => ({ from: `53.5${i}, 9.99`, to: '48.86, 2.35' }))
    const out = await computeDistances('road', pairs, {
      settings,
      keys,
      backend: noBackend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    for (const r of out.results) expect(r.error).toMatch(/today's quota is used up, or the key is not valid/)
    // Four run at once through the gate; none of the rest is sent once the first refusal is in.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('a refused geocode does not stop an already-located pair from being routed', async () => {
    // Geocoding and routing are two allowances.
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname.startsWith('/pelias')) return json({ error: 'Daily quota reached' }, 403)
      return json({ routes: [{ summary: { distance: 480_000 } }] })
    })
    const out = await computeDistances(
      'road',
      [
        { from: 'Heidelberg', to: 'Hamburg' },
        { from: '53.55, 9.99', to: '48.86, 2.35' }
      ],
      { settings, keys, backend: noBackend, fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch } }
    )
    expect(out.results[0].error).toMatch(/quota/)
    expect(out.results[1].raw_km).toBe(480)
  })

  it('air: "Ham" and "HAM" are two places — the catalogue key keeps the case', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        features: [{ geometry: { coordinates: [-0.3, 51.44] }, properties: { label: 'Ham, London, UK' } }]
      })
    )
    const backend = vi.fn(async (_m: string, _p: string, body?: unknown) => {
      const items = (body as { items: Array<{ text: string }> }).items
      return {
        status: 200,
        body: {
          items: items.map((i) =>
            i.text === 'HAM'
              ? {
                  match: {
                    code: 'HAM',
                    label: 'Hamburg Airport (HAM, DE)',
                    lat: 53.63,
                    lon: 9.99,
                    country: 'DE'
                  },
                  error: null
                }
              : { match: null, error: null }
          )
        }
      }
    })
    const out = await computeDistances('air', [{ from: 'Ham', to: 'HAM' }], {
      settings,
      keys,
      backend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(out.results[0].from).toMatchObject({ resolved: 'Ham, London, UK' })
    expect(out.results[0].to).toMatchObject({ via: 'catalogue' })
    expect(out.results[0].raw_km).toBeGreaterThan(600)
  })

  it('air: an unreachable catalogue fails terminal names instead of geocoding them', async () => {
    const fetchImpl = fakeFetch()
    const down = async (): Promise<{ status: number; body: unknown }> => ({ status: 503, body: null })
    const out = await computeDistances(
      'air',
      [
        { from: 'Hamburg', to: 'London airport' },
        { from: 'Hamburg', to: 'Heidelberg' }
      ],
      { settings, keys, backend: down, fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch } }
    )
    expect(out.results[0].error).toMatch(/airport list could not be read/)
    // A plain place is unaffected.
    expect(out.results[1].km).toBeGreaterThan(0)
  })

  it('air: a catalogued "HAM" does not make a later "Ham" look already paid for', async () => {
    const backend = async (
      _m: string,
      _p: string,
      body?: unknown
    ): Promise<{ status: number; body: unknown }> => ({
      status: 200,
      body: {
        items: (body as { items: Array<{ text: string }> }).items.map((i) =>
          i.text === 'HAM'
            ? {
                match: {
                  code: 'HAM',
                  label: 'Hamburg Airport (HAM, DE)',
                  lat: 53.63,
                  lon: 9.99,
                  country: 'DE'
                },
                error: null
              }
            : { match: null, error: null }
        )
      }
    })
    const fetchImpl = fakeFetch()
    const turn = new TurnBudget(0)
    const out = await computeDistances(
      'air',
      [
        { from: 'HAM', to: '48.86, 2.35' },
        { from: 'Ham', to: '48.86, 2.35' }
      ],
      { settings, keys, turn, backend, fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch } }
    )
    // No calls allowed this turn: the catalogued pair runs, the one needing a geocode is skipped.
    expect(out.results).toHaveLength(1)
    expect(out.skipped?.[0]).toMatchObject({ from: 'Ham' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('air: an IATA code resolves from the airport catalogue without a geocoding call', async () => {
    const fetchImpl = fakeFetch()
    const backend = vi.fn(async (_m: string, path: string, body?: unknown) => {
      expect(path).toBe('/api/v1/distances/places/resolve')
      expect(body).toMatchObject({ kind: 'airport' })
      return {
        status: 200,
        body: {
          items: [
            {
              match: {
                code: 'FRA',
                label: 'Frankfurt Main Airport (FRA, DE)',
                lat: 50.02671,
                lon: 8.55835,
                country: 'DE'
              },
              error: null
            },
            { match: null, error: null },
            { match: null, error: '"London airport" matches several airports: … Pass the code instead.' }
          ]
        }
      }
    })
    const out = await computeDistances(
      'air',
      [
        { from: 'FRA', to: 'Shanghai' },
        { from: 'FRA', to: 'London airport' }
      ],
      { settings, keys, backend, fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch } }
    )
    expect(out.results[0].from).toMatchObject({
      via: 'catalogue',
      resolved: 'Frankfurt Main Airport (FRA, DE)'
    })
    expect(out.results[0].km).toBeGreaterThan(8000)
    expect(out.results[1].error).toMatch(/Pass the code/)
    // Only Shanghai went to the geocoder.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(out.attribution).toContain('OurAirports')
  })

  it('an unknown place fails its own pair only', async () => {
    const fetchImpl = fakeFetch()
    const out = await computeDistances(
      'air',
      [
        { from: 'Atlantis', to: 'Hamburg' },
        { from: 'Heidelberg', to: 'Hamburg' }
      ],
      {
        settings,
        keys,
        backend: noBackend,
        fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
      }
    )
    expect(out.results[0].error).toMatch(/found no place for "Atlantis"/)
    expect(out.results[0].km).toBeUndefined()
    expect(out.results[1].km).toBeGreaterThan(400)
  })

  it('names the pairs the per-turn budget could not afford instead of dropping them', async () => {
    const fetchImpl = fakeFetch()
    const out = await computeDistances(
      'road',
      [
        { from: 'Heidelberg', to: 'Hamburg' },
        { from: 'Hamburg', to: 'Heidelberg' },
        { from: 'Heidelberg', to: 'Shanghai' }
      ],
      {
        settings,
        keys,
        // Costs are what the pairs really need: 3 for the first pair, 1 for the
        // second (both places already planned), 2 for the third — six would fit all three.
        turn: new TurnBudget(5),
        backend: noBackend,
        fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
      }
    )
    expect(out.results).toHaveLength(2)
    expect(out.skipped).toEqual([
      { from: 'Heidelberg', to: 'Shanghai', reason: 'per-turn limit of 5 API calls reached' }
    ])
  })

  it('the daily caps stop the batch too, and say why', async () => {
    const fetchImpl = fakeFetch()
    // Relative to what earlier tests already booked in this ledger: room for exactly one more pair.
    const { usedToday } = await import('./usage')
    const limit = usedToday('geocode') + 2
    const tight: TransportSettings = { ...settings, dailyCalls: { geocode: limit, route: 2000 } }
    const out = await computeDistances(
      'air',
      [
        { from: 'Heidelberg', to: 'Hamburg' },
        { from: 'Hamburg', to: 'Shanghai' }
      ],
      {
        settings: tight,
        keys,
        backend: noBackend,
        fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
      }
    )
    expect(out.results).toHaveLength(1)
    expect(out.skipped?.[0].reason).toMatch(new RegExp(`daily geocoding limit of ${limit}`))
  })

  it('refuses road without an ORS key, and everything without any key, in one sentence each', async () => {
    await expect(
      computeDistances('road', [{ from: 'a', to: 'b' }], {
        settings,
        keys: { ors: null, mapbox: 'pk' },
        backend: noBackend
      })
    ).rejects.toThrow(/Road routing needs an openrouteservice key/)
    await expect(
      computeDistances('air', [{ from: 'a', to: 'b' }], {
        settings,
        keys: { ors: null, mapbox: null },
        backend: noBackend
      })
    ).rejects.toThrow(/has no openrouteservice key yet — the user can add it there\.$/)
    await expect(
      computeDistances('teleport', [{ from: 'a', to: 'b' }], { settings, keys, backend: noBackend })
    ).rejects.toThrow(/Unknown mode "teleport"/)
    await expect(computeDistances('air', [], { settings, keys, backend: noBackend })).rejects.toThrow(
      /at least one pair/
    )
  })

  it('Mapbox geocoding is attributed and billed', async () => {
    const fetchImpl = fakeFetch()
    const out = await computeDistances('air', [{ from: 'Heidelberg', to: 'Hamburg' }], {
      settings: { ...settings, geocoder: 'mapbox' },
      keys,
      backend: noBackend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(out.geocoder).toBe('mapbox')
    expect(out.attribution).toContain('Geocoding: Mapbox (© Mapbox)')
    await flushDistanceUsage()
    const { getDistanceUsage, todayKey } = await import('./usage')
    expect(getDistanceUsage()[todayKey()]?.mapbox?.geocode?.cost).toBeCloseTo(0.01, 6)
  })

  it('names a stringified pairs array instead of just counting zero pairs (V324)', async () => {
    await expect(
      computeDistances('road', 'Binh Duong, VietnamCat Lai port, Vietnam', {
        settings,
        keys,
        backend: noBackend
      })
    ).rejects.toThrow(/arrived as ONE string/)
  })

  it('names an {"item": …}-wrapped pairs array (V327)', async () => {
    await expect(
      computeDistances(
        'road',
        { item: [{ from: 'Hamburg', to: 'Prague' }] },
        { settings, keys, backend: noBackend }
      )
    ).rejects.toThrow(/arrived as an OBJECT/)
  })
})

describe('quota honesty', () => {
  it('a coordinate pair costs no geocoding budget at all', async () => {
    const fetchImpl = fakeFetch()
    const turn = new TurnBudget(0)
    const out = await computeDistances('air', [{ from: '53.55, 9.99', to: '48.86, 2.35' }], {
      settings,
      keys,
      turn,
      backend: noBackend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(out.skipped).toBeUndefined()
    expect(out.results[0].raw_km).toBeGreaterThan(700)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(turn.used).toBe(0)
  })

  it('two batches in flight share one turn budget instead of both spending it', async () => {
    const fetchImpl = fakeFetch()
    const turn = new TurnBudget(2)
    const opts = {
      settings,
      keys,
      turn,
      backend: noBackend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    }
    const [a, b] = await Promise.all([
      computeDistances('air', [{ from: 'Heidelberg', to: 'Hamburg' }], opts),
      computeDistances('air', [{ from: 'Shanghai', to: 'Hamburg' }], opts)
    ])
    expect((a.skipped?.length ?? 0) + (b.skipped?.length ?? 0)).toBe(1)
    expect(turn.used).toBeLessThanOrEqual(2)
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(2)
  })
})

describe('access legs to and from the terminals (default on)', () => {
  const on: TransportSettings = { ...DEFAULT_TRANSPORT }
  const FRA = {
    code: 'FRA',
    label: 'Frankfurt Main Airport (FRA, DE)',
    lat: 50.02671,
    lon: 8.55835,
    country: 'DE'
  }
  const PVG = {
    code: 'PVG',
    label: 'Shanghai Pudong International Airport (PVG, CN)',
    lat: 31.1434,
    lon: 121.805,
    country: 'CN'
  }

  /** Catalogue: nothing named, nearest = FRA for Heidelberg, PVG for Shanghai. */
  const backend = vi.fn(async (_m: string, path: string, body?: unknown) => {
    if (path === '/api/v1/distances/places/resolve') {
      const items = (body as { items: Array<{ text: string }> }).items
      return {
        status: 200,
        body: {
          items: items.map((i) =>
            i.text === 'PVG' ? { match: PVG, error: null } : { match: null, error: null }
          )
        }
      }
    }
    if (path === '/api/v1/distances/places/nearest') {
      const pts = (body as { points: Array<{ lat: number }> }).points
      return { status: 200, body: { items: pts.map((p) => ({ terminal: p.lat > 40 ? FRA : PVG, km: 50 })) } }
    }
    return { status: 500, body: null }
  })

  function router(km: number): ReturnType<typeof vi.fn> {
    const geo = fakeFetch()
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.includes('/directions/driving-hgv'))
        return json({
          routes: [
            {
              summary: { distance: km * 1000 },
              extras: { waycategory: { summary: [{ value: 0, distance: km * 1000 }] } }
            }
          ]
        })
      return (geo as unknown as typeof fetch)(input, init)
    })
  }

  it('air: the flight runs airport to airport; the road legs come apart, ×1.05, terminal end bounded', async () => {
    const fetchImpl = router(80)
    const turn = new TurnBudget(30)
    const out = await computeDistances('air', [{ from: 'Heidelberg', to: 'Shanghai' }], {
      settings: on,
      keys,
      turn,
      backend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    const r = out.results[0]
    // Main leg FRA → PVG: great circle + 95 km, not Heidelberg → Shanghai.
    expect(r.raw_km).toBeGreaterThan(8800)
    expect(r.raw_km).toBeLessThan(8900)
    expect(r.access?.from).toMatchObject({ code: 'FRA', chosen: 'nearest', km: 84, raw_km: 80 })
    expect(r.access?.from?.note).toMatch(/Nearest major terminal/)
    expect(r.access?.to).toMatchObject({ code: 'PVG', km: 84 })
    expect(out.attribution).toMatch(/Access legs: Routing © openrouteservice/)
    // The terminal end of each road request snaps within 2 km, the place end without a bound.
    const bodies = fetchImpl.mock.calls
      .filter((c) => String(c[0]).includes('directions'))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)).radiuses)
    expect(bodies).toContainEqual([-1, 2000])
    expect(bodies).toContainEqual([2000, -1])
  })

  it('a place named as the terminal has no leg; a named terminal overrides the nearest', async () => {
    const fetchImpl = router(80)
    const out = await computeDistances('air', [{ from: 'Heidelberg', to: 'PVG', from_terminal: 'PVG' }], {
      settings: on,
      keys,
      backend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    const r = out.results[0]
    expect(r.access?.to).toBeUndefined()
    expect(r.access?.from).toMatchObject({ code: 'PVG', chosen: 'given' })
    // Both ends at PVG: no flight at all.
    expect(r).toMatchObject({ km: 0, adjustment: null })
    expect(r.note).toMatch(/no flight/)
  })

  it('a routed access leg under 1 km is set to 0 before any adjustment', async () => {
    const fetchImpl = router(0.6)
    const out = await computeDistances('air', [{ from: 'Heidelberg', to: 'PVG' }], {
      settings: on,
      keys,
      backend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(out.results[0].access?.from).toMatchObject({ km: 0, raw_km: 0.6, adjustment: null })
    expect(out.results[0].access?.from?.note).toMatch(/under 1 km, set to 0/)
  })

  it('a terminal with no lorry road within 2 km fails its leg, not the flight', async () => {
    const geo = fakeFetch()
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('directions')
        ? json({ error: { code: 2010, message: 'Could not find routable point' } }, 404)
        : (geo as unknown as typeof fetch)(input, init)
    )
    const out = await computeDistances('air', [{ from: 'Heidelberg', to: 'PVG' }], {
      settings: on,
      keys,
      backend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(out.results[0].km).toBeGreaterThan(8800)
    expect(out.results[0].access?.from?.error).toMatch(/No lorry road within 2000 m of Frankfurt/)
  })

  it('without a road key the old place-to-place figure stands and says why', async () => {
    const out = await computeDistances('air', [{ from: 'Heidelberg', to: 'Shanghai' }], {
      // Mapbox picked: with only its token, nothing else may geocode.
      settings: { ...on, geocoder: 'mapbox' },
      keys: { ors: null, mapbox: 'pk.x' },
      backend,
      fetchOpts: { fetchImpl: fakeFetch() as unknown as typeof fetch }
    })
    expect(out.results[0].access).toBeUndefined()
    expect(out.access_note).toMatch(/need an openrouteservice key/)
  })

  it('sea: the voyage runs port to port from the chosen ports', async () => {
    const HAM = { code: 'DEHAM', label: 'Hamburg (DEHAM, DE)', lat: 53.5, lon: 9.95, country: 'DE' }
    const SHA = { code: 'CNSHA', label: 'Shanghai (CNSHA, CN)', lat: 31.4, lon: 121.5, country: 'CN' }
    let sent: unknown = null
    const seaBackend = vi.fn(async (_m: string, path: string, body?: unknown) => {
      if (path === '/api/v1/distances/places/resolve')
        return {
          status: 200,
          body: { items: (body as { items: unknown[] }).items.map(() => ({ match: null, error: null })) }
        }
      if (path === '/api/v1/distances/places/nearest')
        return {
          status: 200,
          body: {
            items: (body as { points: Array<{ lat: number }> }).points.map((p) => ({
              terminal: p.lat > 40 ? HAM : SHA,
              km: 400
            }))
          }
        }
      sent = body
      return {
        status: 200,
        body: { legs: [{ km: 20000, from_snap_km: 1, to_snap_km: 2, passages: ['suez'], error: null }] }
      }
    })
    const out = await computeDistances('sea', [{ from: 'Heidelberg', to: 'Shanghai' }], {
      settings: on,
      keys,
      backend: seaBackend,
      fetchOpts: { fetchImpl: router(450) as unknown as typeof fetch }
    })
    expect((sent as { legs: Array<{ from: { lat: number } }> }).legs[0].from.lat).toBe(53.5)
    expect(out.results[0]).toMatchObject({ raw_km: 20000, km: 23000 })
    expect(out.results[0].access?.from).toMatchObject({ code: 'DEHAM', km: 472.5 })
  })

  it('a terminal-to-terminal pair reserves no road call; a failed nearest lookup spares it', async () => {
    // Regression: FRA → PVG was skipped on an empty road budget, and a 503 from the
    // nearest lookup for ANOTHER pair discarded it.
    const both = vi.fn(async (_m: string, path: string, body?: unknown) => {
      if (path === '/api/v1/distances/places/resolve') {
        const items = (body as { items: Array<{ text: string }> }).items
        return {
          status: 200,
          body: {
            items: items.map((i) =>
              i.text === 'FRA'
                ? { match: FRA, error: null }
                : i.text === 'PVG'
                  ? { match: PVG, error: null }
                  : { match: null, error: null }
            )
          }
        }
      }
      return { status: 503, body: null } // nearest is down
    })
    const turn = new TurnBudget(0)
    const out = await computeDistances(
      'air',
      [
        { from: 'FRA', to: 'PVG' },
        { from: '49.41, 8.69', to: 'PVG' }
      ],
      {
        settings: on,
        keys,
        turn,
        backend: both,
        fetchOpts: { fetchImpl: router(80) as unknown as typeof fetch }
      }
    )
    expect(out.results[0].km).toBeGreaterThan(8800)
    expect(out.results[0].access).toBeUndefined()
    // The coordinate pair needs one road leg the empty budget cannot pay for.
    expect(out.skipped?.[0]).toMatchObject({ from: '49.41, 8.69' })

    const out2 = await computeDistances(
      'air',
      [
        { from: 'FRA', to: 'PVG' },
        { from: '49.41, 8.69', to: 'PVG' }
      ],
      { settings: on, keys, backend: both, fetchOpts: { fetchImpl: router(80) as unknown as typeof fetch } }
    )
    expect(out2.results[0].km).toBeGreaterThan(8800)
    expect(out2.results[1].error).toMatch(/airport list could not be read/)
  })

  it('sea: a port far from the shipping-lane network says the gap is in no leg', async () => {
    const seaBackend = vi.fn(async (_m: string, path: string, body?: unknown) => {
      if (path === '/api/v1/distances/places/resolve')
        return {
          status: 200,
          body: { items: (body as { items: unknown[] }).items.map(() => ({ match: null, error: null })) }
        }
      if (path === '/api/v1/distances/places/nearest')
        return {
          status: 200,
          body: {
            items: (body as { points: Array<{ lat: number }> }).points.map((p) => ({
              terminal: p.lat > 40 ? FRA : PVG,
              km: 5
            }))
          }
        }
      return {
        status: 200,
        body: { legs: [{ km: 240, from_snap_km: 534.7, to_snap_km: 2, passages: [], error: null }] }
      }
    })
    const out = await computeDistances('sea', [{ from: 'Heidelberg', to: 'Shanghai' }], {
      settings: on,
      keys,
      backend: seaBackend,
      fetchOpts: { fetchImpl: router(20) as unknown as typeof fetch }
    })
    expect(out.results[0].note).toMatch(/535 km from the shipping-lane network .* in no leg/)
  })

  it('a named terminal moves the main leg even with access legs off or without a road key', async () => {
    // Regression: from_terminal was ignored there, and the voyage ran from Munich.
    let sent: unknown = null
    const HAM = { code: 'DEHAM', label: 'Hamburg (DEHAM, DE)', lat: 53.5, lon: 9.95, country: 'DE' }
    const seaBackend = vi.fn(async (_m: string, path: string, body?: unknown) => {
      if (path === '/api/v1/distances/places/resolve') {
        const items = (body as { items: Array<{ text: string }> }).items
        return {
          status: 200,
          body: {
            items: items.map((i) =>
              i.text === 'DEHAM' ? { match: HAM, error: null } : { match: null, error: null }
            )
          }
        }
      }
      sent = body
      return {
        status: 200,
        body: { legs: [{ km: 20000, from_snap_km: 1, to_snap_km: 2, passages: [], error: null }] }
      }
    })
    for (const variant of [
      { settings: { ...on, accessLegs: false }, keys },
      { settings: { ...on, geocoder: 'mapbox' as const }, keys: { ors: null, mapbox: 'pk.x' } }
    ]) {
      sent = null
      const out = await computeDistances(
        'sea',
        [{ from: 'Heidelberg', to: 'Shanghai', from_terminal: 'DEHAM' }],
        {
          ...variant,
          backend: seaBackend,
          fetchOpts: { fetchImpl: fakeFetch() as unknown as typeof fetch }
        }
      )
      expect((sent as { legs: Array<{ from: { lat: number } }> }).legs[0].from.lat).toBe(53.5)
      expect(out.results[0].access).toBeUndefined()
      expect(out.results[0].note).toMatch(/named terminal \(Hamburg \(DEHAM, DE\)\)/)
    }
  })

  it('a coordinate lying ON a catalogue entry is that terminal, not the nearest major one', async () => {
    // Portland, Maine's own coordinates must not become Boston.
    const MAINE = {
      code: 'USPWM',
      label: 'Portland (Me) (USPWM, US)',
      lat: 43.664904,
      lon: -70.245695,
      country: 'US'
    }
    const BOSTON = { code: 'USBOS', label: 'Boston (USBOS, US)', lat: 42.35, lon: -71.05, country: 'US' }
    let sent: unknown = null
    const seaBackend = vi.fn(async (_m: string, path: string, body?: unknown) => {
      if (path === '/api/v1/distances/places/nearest')
        return {
          status: 200,
          body: {
            items: (body as { points: Array<{ lat: number }> }).points.map((p) =>
              p.lat > 43 ? { terminal: BOSTON, km: 160, at: MAINE } : { terminal: PVG, km: 5, at: null }
            )
          }
        }
      if (path === '/api/v1/distances/places/resolve')
        return {
          status: 200,
          body: { items: (body as { items: unknown[] }).items.map(() => ({ match: null, error: null })) }
        }
      sent = body
      return {
        status: 200,
        body: { legs: [{ km: 20000, from_snap_km: 1, to_snap_km: 2, passages: [], error: null }] }
      }
    })
    const out = await computeDistances('sea', [{ from: '43.664904, -70.245695', to: 'Shanghai' }], {
      settings: on,
      keys,
      backend: seaBackend,
      fetchOpts: { fetchImpl: router(20) as unknown as typeof fetch }
    })
    expect((sent as { legs: Array<{ from: { lat: number } }> }).legs[0].from.lat).toBe(43.664904)
    expect(out.results[0].access?.from).toBeUndefined()
  })

  it('coordinates lying on terminals cost no road budget', async () => {
    const onTerminals = vi.fn(async (_m: string, path: string, body?: unknown) => {
      if (path === '/api/v1/distances/places/resolve') {
        const items = (body as { items: Array<{ text: string }> }).items
        return {
          status: 200,
          body: {
            items: items.map((i) =>
              i.text.startsWith('50.02')
                ? { match: FRA, error: null }
                : i.text.startsWith('31.14')
                  ? { match: PVG, error: null }
                  : { match: null, error: null }
            )
          }
        }
      }
      return { status: 500, body: null }
    })
    const out = await computeDistances('air', [{ from: '50.02671, 8.55835', to: '31.1434, 121.805' }], {
      settings: on,
      keys,
      turn: new TurnBudget(0),
      backend: onTerminals,
      fetchOpts: { fetchImpl: router(80) as unknown as typeof fetch }
    })
    expect(out.skipped).toBeUndefined()
    expect(out.results[0].km).toBeGreaterThan(8800)
    expect(out.results[0].access).toBeUndefined()
  })

  it('the budget reserves the two road legs per pair', async () => {
    const fetchImpl = router(80)
    const turn = new TurnBudget(3) // two geocodes + one leg: not enough for two legs
    const out = await computeDistances('air', [{ from: 'Heidelberg', to: 'Shanghai' }], {
      settings: on,
      keys,
      turn,
      backend,
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(out.results).toHaveLength(0)
    expect(out.skipped?.[0].reason).toMatch(/per-turn limit/)
  })
})
