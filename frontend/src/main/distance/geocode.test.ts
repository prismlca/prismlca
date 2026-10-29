import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  countryToken,
  geocode,
  mapboxGeocodeUrl,
  orsCountryUrl,
  pickCandidate,
  regionHints,
  type Disambiguation,
  orsAutocompleteUrl,
  orsGeocodeUrl,
  parseLatLon,
  resetGeocodeCache,
  suggest
} from './geocode'

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

const orsHit = {
  features: [
    {
      geometry: { coordinates: [8.69, 49.41] },
      properties: { label: 'Heidelberg, BW, Germany', country_a: 'DEU', country_code: 'DE' }
    }
  ]
}
const mapboxHit = {
  features: [
    {
      geometry: { coordinates: [-71.11, 42.37] },
      properties: {
        full_address: 'Cambridge, Massachusetts, United States',
        context: { country: { country_code: 'us' } }
      }
    }
  ]
}

beforeEach(() => resetGeocodeCache())

describe('coordinate input', () => {
  it('reads "lat, lon" without asking anyone', () => {
    expect(parseLatLon('49.41, 8.68')).toMatchObject({ lat: 49.41, lon: 8.68, via: 'input' })
    expect(parseLatLon('-33.9,151.2')).toMatchObject({ lat: -33.9, lon: 151.2 })
  })
  it('refuses out-of-range or non-numeric text', () => {
    expect(parseLatLon('95, 10')).toBeNull()
    expect(parseLatLon('Heidelberg')).toBeNull()
    expect(parseLatLon('8.68')).toBeNull()
  })
})

describe('request shapes', () => {
  it('ORS: text, size=1, optional country bias', () => {
    const u = new URL(orsGeocodeUrl('Cambridge', 'gb'))
    expect(u.origin + u.pathname).toBe('https://api.heigit.org/pelias/v1/search')
    expect(u.searchParams.get('text')).toBe('Cambridge')
    expect(u.searchParams.get('size')).toBe('5')
    expect(u.searchParams.get('boundary.country')).toBe('GB')
    expect(new URL(orsGeocodeUrl('Cambridge')).searchParams.has('boundary.country')).toBe(false)
  })
  it('Mapbox: permanent=true is hard-wired, token in the query, country lower-case', () => {
    const u = new URL(mapboxGeocodeUrl('Cambridge', 'GB', 'pk.test'))
    expect(u.origin + u.pathname).toBe('https://api.mapbox.com/search/geocode/v6/forward')
    expect(u.searchParams.get('permanent')).toBe('true')
    expect(u.searchParams.get('limit')).toBe('1')
    expect(u.searchParams.get('country')).toBe('gb')
    expect(u.searchParams.get('access_token')).toBe('pk.test')
  })
})

describe('geocode()', () => {
  it('ORS: echoes the resolved label and country, sends the key as Authorization, counts the call', async () => {
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('ors-key')
      return json(orsHit)
    })
    const calls: string[] = []
    const p = await geocode('Heidelberg', 'ors', 'ors-key', undefined, {
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch },
      onCall: (prov) => calls.push(prov)
    })
    expect(p).toMatchObject({
      text: 'Heidelberg',
      resolved: 'Heidelberg, BW, Germany',
      lat: 49.41,
      lon: 8.69,
      country: 'DE',
      via: 'ors'
    })
    expect(calls).toEqual(['ors'])
  })

  it('Mapbox: full address and country from the context', async () => {
    const fetchImpl = vi.fn(async () => json(mapboxHit))
    const p = await geocode('Cambridge', 'mapbox', 'pk.x', 'us', {
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(p).toMatchObject({
      resolved: 'Cambridge, Massachusetts, United States',
      country: 'US',
      via: 'mapbox'
    })
  })

  it('caches by provider + country + normalised text, so a repeated place costs one request', async () => {
    const fetchImpl = vi.fn(async () => json(orsHit))
    const calls: string[] = []
    const deps = {
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch },
      onCall: (p: string) => calls.push(p)
    }
    await geocode('Heidelberg', 'ors', 'k', undefined, deps)
    await geocode('  heidelberg ', 'ors', 'k', undefined, deps)
    await geocode('Heidelberg', 'ors', 'k', 'DE', deps) // a different bias is a different question
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(2)
  })

  it('a coordinate pair never reaches the network', async () => {
    const fetchImpl = vi.fn()
    const p = await geocode('49.41, 8.68', 'ors', 'k', undefined, { fetchOpts: { fetchImpl } })
    expect(p.via).toBe('input')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('no match is a named 404, not a crash', async () => {
    const fetchImpl = vi.fn(async () => json({ features: [] }))
    await expect(
      geocode('Nowhereville', 'ors', 'k', undefined, {
        fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
      })
    ).rejects.toMatchObject({
      status: 404,
      code: 'no_match'
    })
  })
})

describe('suggest() — the panel typeahead', () => {
  const hits = {
    features: [
      {
        geometry: { coordinates: [8.69, 49.41] },
        properties: { label: 'Heidelberg, BW, Germany', country_a: 'DEU', country_code: 'DE' }
      },
      { geometry: { coordinates: [8.69, 49.41] }, properties: { label: 'Heidelberg, BW, Germany' } },
      {
        geometry: { coordinates: [-80.1, 40.4] },
        properties: { label: 'Heidelberg, PA, USA', country_a: 'USA', country_code: 'US' }
      }
    ]
  }
  it('uses the autocomplete endpoint with size 5 and a country bias', () => {
    const u = new URL(orsAutocompleteUrl('Heidel', 'de'))
    expect(u.origin + u.pathname).toBe('https://api.heigit.org/pelias/v1/autocomplete')
    expect(u.searchParams.get('size')).toBe('5')
    expect(u.searchParams.get('boundary.country')).toBe('DE')
  })
  it('asks nothing for short text or a coordinate pair, and counts the call it does make', async () => {
    const fetchImpl = vi.fn(async () => json(hits))
    const calls: string[] = []
    const deps = {
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch },
      onCall: (p: string) => calls.push(p)
    }
    expect(await suggest('He', 'k', undefined, deps)).toEqual([])
    expect(await suggest('49.4, 8.7', 'k', undefined, deps)).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
    const out = await suggest('Heidel', 'k', undefined, deps)
    expect(calls).toEqual(['ors'])
    // De-duplicated by label, country from the code.
    expect(out).toEqual([
      { label: 'Heidelberg, BW, Germany', lat: 49.41, lon: 8.69, country: 'DE' },
      { label: 'Heidelberg, PA, USA', lat: 40.4, lon: -80.1, country: 'US' }
    ])
  })
  it('never throws — a failed request is an empty list', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }))
    expect(
      await suggest('Heidel', 'k', undefined, {
        fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
      })
    ).toEqual([])
  })

  it('never slices an alpha-3 country code into a wrong alpha-2 (CHN is not CH)', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        features: [
          {
            geometry: { coordinates: [113.93, 22.55] },
            properties: { label: 'Shenzhen, GD, China', country_a: 'CHN' }
          }
        ]
      })
    )
    const p = await geocode('Shenzhen', 'ors', 'k', undefined, {
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(p.country).toBeUndefined()
  })
})

describe('in-flight dedupe', () => {
  it('geocodes a place once even when asked twice at the same time', async () => {
    const fetchImpl = vi.fn(async () => json(orsHit))
    const deps = { fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch } }
    const [a, b] = await Promise.all([
      geocode('Heidelberg', 'ors', 'k', undefined, deps),
      geocode('heidelberg', 'ors', 'k', undefined, deps)
    ])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(a.lat).toBe(49.41)
    expect(b).toMatchObject({ lat: 49.41, text: 'heidelberg' })
  })
})

describe('country binding (V405)', () => {
  const countryHit = (code: string, name: string) =>
    json({
      features: [
        {
          geometry: { coordinates: [104, 35] },
          properties: { label: name, name, layer: 'country', country_a: code }
        }
      ]
    })
  const hitAt = (label: string, cc: string) =>
    json({
      features: [{ geometry: { coordinates: [121.55, 29.87] }, properties: { label, country_code: cc } }]
    })

  it('reads the country a text names at its end, and nothing else', () => {
    expect(countryToken('Ningbo Port, China')).toBe('China')
    expect(countryToken('Bornheim (Pfalz), Germany')).toBe('Germany')
    expect(countryToken('Landau in der Pfalz')).toBeNull()
    expect(countryToken('Hamburg, 20095')).toBeNull()
    expect(orsCountryUrl('China')).toContain('layers=country')
  })

  it('reads the region hints of the text', () => {
    expect(regionHints('Bornheim (Pfalz), Germany', 'Germany')).toEqual(['pfalz'])
    expect(regionHints('Yuyao, Zhejiang, China', 'China')).toEqual(['zhejiang'])
    expect(regionHints('Hamburg, Germany', 'Germany')).toEqual([])
  })

  it('picks the namesake the text means: the region first, then a place over a street', () => {
    const f = (layer: string, props: Record<string, unknown>, at: [number, number] = [1, 1]) => ({
      geometry: { coordinates: at },
      properties: { layer, ...props }
    })
    const d = (o: Partial<Disambiguation>): Disambiguation => ({
      hints: [],
      hintGids: [],
      specific: true,
      ...o
    })
    const nrw = f(
      'locality',
      { label: 'Bornheim, NW, Germany', region: 'North Rhine-Westphalia', region_gid: 'wof:nw' },
      [6.92, 50.78]
    )
    const rp = f(
      'locality',
      { label: 'Bornheim, RP, Germany', region: 'Rhineland-Palatinate', region_gid: 'wof:rp' },
      [8.1, 49.2]
    )
    // "Pfalz" matches no English region name — the gid Pelias gave for the hint does.
    expect(pickCandidate([nrw, rp], d({ hints: ['pfalz'], hintGids: ['wof:rp'] }))).toBe(rp)
    expect(pickCandidate([nrw, rp], d({}))).toBe(nrw) // nothing to go on: Pelias' order
    const street = f('street', { label: 'Ningbo Road, JS, China', name: 'Ningbo Road' })
    const city = f('locality', { label: 'Ningbo, ZJ, China', name: 'Ningbo' })
    expect(pickCandidate([street, city], d({}))).toBe(city)
    // Only the country came back for "Nowhere, China": not a hit.
    expect(pickCandidate([f('country', { label: 'China', name: 'China' })], d({}))).toBeNull()
    expect(
      pickCandidate([f('country', { label: 'China', name: 'China' })], d({ specific: false }))
    ).not.toBeNull()
  })

  it('resolves the country first and confines the search to it — "Ningbo Port, China" stays in China', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      urls.push(String(u))
      return urls.length === 1 ? countryHit('CHN', 'China') : hitAt('Ningbo Port, Zhejiang, China', 'CN')
    })
    const p = await geocode('Ningbo Port, China', 'ors', 'k', undefined, {
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(new URL(urls[0]).searchParams.get('layers')).toBe('country')
    expect(new URL(urls[1]).searchParams.get('boundary.country')).toBe('CHN')
    expect(p).toMatchObject({ bound: 'CHN', bound_by: 'text', country: 'CN' })
  })

  it('"Bornheim (Pfalz), Germany": the region word is resolved to a gid and decides', async () => {
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      const q = new URL(String(u)).searchParams
      if (q.get('layers') === 'country') return countryHit('DEU', 'Germany')
      if (q.get('layers')?.startsWith('region'))
        return json({
          features: [
            {
              geometry: { coordinates: [7.3, 49.9] },
              properties: { layer: 'region', gid: 'wof:rp', label: 'Rhineland-Palatinate' }
            }
          ]
        })
      return json({
        features: [
          {
            geometry: { coordinates: [6.92, 50.78] },
            properties: { layer: 'locality', label: 'Bornheim, NW, Germany', region_gid: 'wof:nw' }
          },
          {
            geometry: { coordinates: [8.1, 49.2] },
            properties: { layer: 'locality', label: 'Bornheim, RP, Germany', region_gid: 'wof:rp' }
          }
        ]
      })
    })
    const p = await geocode('Bornheim (Pfalz), Germany', 'ors', 'k', undefined, {
      fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
    })
    expect(p.resolved).toBe('Bornheim, RP, Germany')
  })

  it('a given code wins over the text, a text without a country stays unbound, a miss names the bound', async () => {
    const urls: string[] = []
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      urls.push(String(u))
      return json({ features: [] })
    })
    await expect(
      geocode('Nowhere, China', 'ors', 'k', 'DE', {
        fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
      })
    ).rejects.toThrow(/no place for "Nowhere, China" in DE\./)
    expect(urls).toHaveLength(1) // no country lookup when a code was given
    expect(new URL(urls[0]).searchParams.get('boundary.country')).toBe('DE')
    urls.length = 0
    await expect(
      geocode('Heidelberg', 'ors', 'k', undefined, {
        fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
      })
    ).rejects.toThrow(/no place for "Heidelberg"\./)
    expect(new URL(urls[0]).searchParams.has('boundary.country')).toBe(false)
  })

  it('a bound read from the text is named in the error, with the way out', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => (n++ === 0 ? countryHit('CHN', 'China') : json({ features: [] })))
    await expect(
      geocode('Nowhere, China', 'ors', 'k', undefined, {
        fetchOpts: { fetchImpl: fetchImpl as unknown as typeof fetch }
      })
    ).rejects.toThrow(/in CHN \(the country read from the end of the text/)
  })
})
