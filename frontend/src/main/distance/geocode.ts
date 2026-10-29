/**
 * Place → coordinates, through the geocoder chosen in Settings — never by the model.
 *
 * openrouteservice (Pelias on OpenStreetMap / OpenAddresses; free with the ORS key) or Mapbox
 * Geocoding v6 with `permanent=true` — the only Mapbox variant whose results may be stored, and
 * the reason it is hard-wired: a temporary geocode in a saved model would breach Mapbox's terms.
 * A "lat, lon" input skips the geocoder altogether.
 *
 * Results are cached for the session by provider + country + normalised text: a batch that names
 * the same factory ten times costs one request, and the ledger only counts what actually went out.
 */
import { ORS_FREE_PLAN } from '../../shared/distanceDefaults'
import { DistanceHttpError, fetchJson, RateGate, type FetchJsonOpts } from './http'
import { describeOrsAuth, ORS_QUOTA_SENTENCE } from './route'
import type { GeocodeProvider, Place } from './types'

export const ORS_GEOCODE_URL = 'https://api.heigit.org/pelias/v1/search'
export const ORS_AUTOCOMPLETE_URL = 'https://api.heigit.org/pelias/v1/autocomplete'
export const MAPBOX_GEOCODE_URL = 'https://api.mapbox.com/search/geocode/v6/forward'

/** Mapbox's own default rate limit is far higher; 300/min is a courtesy bound, not their figure. */
export const gates = {
  orsGeocode: new RateGate(ORS_FREE_PLAN.geocodePerMinute, 4),
  mapboxGeocode: new RateGate(300, 4)
}

const LATLON = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/

/** "49.41, 8.68" → a Place without asking anyone. Null when the text is not a coordinate pair. */
export function parseLatLon(text: string): Place | null {
  const m = LATLON.exec(text)
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { text, resolved: `${lat}, ${lon}`, lat, lon, via: 'input' }
}

const cache = new Map<string, Place>()
/** Lookups in flight, by the same key: a batch that names one factory ten times starts all ten at
 *  once, before the first answer is cached — ten requests where the cache promised one.
 *  The second caller waits for the first instead. */
const pending = new Map<string, Promise<Place>>()
const cacheKey = (p: GeocodeProvider, country: string | undefined, text: string): string =>
  `${p}|${(country ?? '').toLowerCase()}|${text.trim().toLowerCase().replace(/\s+/g, ' ')}`

/** Test seam. */
export function resetGeocodeCache(): void {
  cache.clear()
  pending.clear()
  countryCache.clear()
}

/** Whether resolving this text costs a request: false for a coordinate pair or a cached place. */
export function needsGeocoding(
  text: string,
  provider: GeocodeProvider,
  country: string | undefined
): boolean {
  if (parseLatLon(text)) return false
  const clean = text.trim()
  return !!clean && !cache.has(cacheKey(provider, country, clean))
}

/** An ISO-3166 code as `boundary.country` takes it — alpha-2 from a caller, alpha-3 from Pelias' own
 *  country layer, which carries `country_a` ("CHN") and no two-letter code. */
const country2 = (c?: string): string | undefined => {
  const v = (c ?? '').trim()
  return /^[A-Za-z]{2,3}$/.test(v) ? v.toUpperCase() : undefined
}

/** Five candidates, not one: the first is Pelias' guess, and a region named in the text decides
 *  between namesakes only if the others are in the answer (V405, `pickCandidate`). */
export const ORS_CANDIDATES = 5

export function orsGeocodeUrl(text: string, country?: string): string {
  const u = new URL(ORS_GEOCODE_URL)
  u.searchParams.set('text', text)
  u.searchParams.set('size', String(ORS_CANDIDATES))
  const c = country2(country)
  if (c) u.searchParams.set('boundary.country', c)
  return u.toString()
}

/**
 * The country a free-text place names at its end — "Ningbo Port, China", "Bornheim (Pfalz), Germany",
 * "Landau, Deutschland" — as the geocoder would need it: the last comma-separated part, letters only.
 * Null for a single token, a trailing postcode or a region code; those stay unbound as before.
 */
export function countryToken(text: string): string | null {
  const parts = text
    .split(',')
    .map((s) => s.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (parts.length < 2) return null
  const last = parts[parts.length - 1]
  if (last.length < 3 || /\d/.test(last)) return null
  return last
}

/** One Pelias layer set only, inside a country: the region a hint names ("Pfalz" → Rheinland-Pfalz)
 *  — a feature with a gid; the same call served the country layer before it. */
export function orsLayerUrl(text: string, layers: string, country: string | undefined): string {
  const u = new URL(ORS_GEOCODE_URL)
  u.searchParams.set('text', text)
  u.searchParams.set('size', '1')
  u.searchParams.set('layers', layers)
  const c = country2(country)
  if (c) u.searchParams.set('boundary.country', c)
  return u.toString()
}

/** Country layer only: "China" → the country feature, never a street named after it. */
export function orsCountryUrl(token: string): string {
  const u = new URL(ORS_GEOCODE_URL)
  u.searchParams.set('text', token)
  u.searchParams.set('size', '1')
  u.searchParams.set('layers', 'country')
  return u.toString()
}

/** What in the text points at ONE of several namesakes: the parts in brackets ("Bornheim (Pfalz)") and
 *  the parts between the first comma and the country ("Yuyao, Zhejiang, China" → "Zhejiang"). */
export function regionHints(text: string, countryTok: string | null): string[] {
  const hints: string[] = []
  for (const m of text.matchAll(/\(([^)]+)\)/g)) hints.push(m[1].trim())
  const parts = text
    .replace(/\([^)]*\)/g, ' ')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const inner = countryTok ? parts.slice(1, -1) : parts.slice(1)
  for (const part of inner) if (!/\d/.test(part) && part.length >= 3) hints.push(part)
  return hints.map((h) => h.toLowerCase()).filter((h, i, a) => a.indexOf(h) === i)
}

/** Layers that are places; a street or an address is never what a transport leg starts from. */
const PLACE_LAYERS = new Set([
  'locality',
  'localadmin',
  'borough',
  'neighbourhood',
  'venue',
  'postalcode',
  'county',
  'region',
  'macroregion'
])

/**
 * The candidate the text means (V405). Pelias' first answer for "Bornheim (Pfalz), Germany" was the
 * Bornheim in North Rhine-Westphalia and for "Ningbo Port, China" a street called Ningbo Road; the
 * right ones were in the list, one place down. Scored, not re-queried: a region named in the text
 * (Pfalz → Rheinland-Pfalz, matched by the gid the geocoder gave the word) comes first, a place beats
 * a street, and Pelias' own order breaks ties. Postcodes are not read: this Pelias carries none for
 * Germany (measured, "76879" → nothing on every layer), so a postcode decides nothing here. Null when the
 * only answers are the country itself although the text named more than a country — that is "not found", not a hit.
 */
export interface Disambiguation {
  /** Region words in the text, lower-cased, and the gids Pelias resolved them to ("Pfalz" → the gid of
   *  Rheinland-Pfalz) — the gid match is language-free; the word match is the cheap second chance. */
  hints: string[]
  hintGids: string[]
  specific: boolean
}

const GID_FIELDS = ['region_gid', 'macroregion_gid', 'county_gid', 'localadmin_gid', 'locality_gid']

export function pickCandidate(features: GeoFeature[], d: Disambiguation): GeoFeature | null {
  let best: { f: GeoFeature; score: number } | null = null
  features.forEach((f, i) => {
    const p = f.properties ?? {}
    if (d.specific && p.layer === 'country') return
    let score = 0
    if (d.hintGids.length && GID_FIELDS.some((k) => d.hintGids.includes(String(p[k] ?? '')))) score += 4
    const fields = ['region', 'county', 'localadmin', 'locality', 'name', 'macroregion', 'label']
      .map((k) => String(p[k] ?? '').toLowerCase())
      .join(' | ')
    for (const h of d.hints) if (h && fields.includes(h)) score += 4
    if (PLACE_LAYERS.has(String(p.layer ?? ''))) score += 1
    score -= i * 0.01 // Pelias' order, as the tie-break
    if (!best || score > best.score) best = { f, score }
  })
  return best ? (best as { f: GeoFeature }).f : null
}

const countryCache = new Map<string, string | null>()

/**
 * The ISO code of the country a text names at its end, from the geocoder itself (V405) — so no list
 * of country names in any language has to be kept here: Pelias knows "China", "Deutschland" and
 * "Allemagne" alike. One small request per distinct token, cached for the session; null when the
 * token is no country (a region, a district), which leaves the search unbound as before.
 */
async function countryOf(token: string, key: string, deps: GeocodeDeps): Promise<string | null> {
  const k = token.toLowerCase()
  if (countryCache.has(k)) return countryCache.get(k) ?? null
  let code: string | null = null
  try {
    code = await gates.orsGeocode.run(async () => {
      if (deps.refused?.()) return null
      const { data } = await fetchJson<{ features?: GeoFeature[] }>(
        orsCountryUrl(token),
        { method: 'GET', headers: { Authorization: key, Accept: 'application/json' } },
        {
          ...deps.fetchOpts,
          describeError: describe('openrouteservice'),
          onAttempt: () => deps.onCall?.('ors'),
          signal: deps.signal
        }
      )
      const props = data?.features?.[0]?.properties ?? {}
      if (props.layer !== 'country') return null
      const alpha3 =
        typeof props.country_a === 'string' && /^[A-Za-z]{3}$/.test(props.country_a)
          ? props.country_a.toUpperCase()
          : null
      return orsCountry(props) ?? alpha3
    })
  } catch (e) {
    code = null // a failed country lookup costs nothing but the binding
    console.log(
      `[prism-distance] country lookup for "${token}" failed: ${e instanceof Error ? e.message : e}`
    )
  }
  // One line per distinct token: the binding is what decides where a place can land (V405).
  console.log(`[prism-distance] country "${token}" → ${code ?? 'none (not a country)'}`)
  countryCache.set(k, code)
  return code
}

export function orsAutocompleteUrl(text: string, country?: string): string {
  const u = new URL(ORS_AUTOCOMPLETE_URL)
  u.searchParams.set('text', text)
  u.searchParams.set('size', '5')
  const c = country2(country)
  if (c) u.searchParams.set('boundary.country', c)
  return u.toString()
}

export function mapboxGeocodeUrl(text: string, country: string | undefined, token: string): string {
  const u = new URL(MAPBOX_GEOCODE_URL)
  u.searchParams.set('q', text)
  u.searchParams.set('limit', '1')
  u.searchParams.set('permanent', 'true')
  const c = country2(country)
  if (c) u.searchParams.set('country', c.toLowerCase())
  u.searchParams.set('access_token', token)
  return u.toString()
}

const describe =
  (who: string) =>
  (status: number, body: unknown): string | undefined => {
    const msg =
      body && typeof body === 'object'
        ? String(
            (body as { error?: unknown; message?: unknown }).error ??
              (body as { message?: unknown }).message ??
              ''
          )
        : ''
    if (who === 'openrouteservice') {
      const auth = describeOrsAuth(status)
      if (auth) return auth
    }
    if (status === 401 || status === 403)
      return `${who} rejected the key (HTTP ${status}${msg ? `: ${msg}` : ''}).`
    if (status === 429) return `${who} rate limit reached (HTTP 429). Try again in a minute.`
    return msg ? `${who}: ${msg}` : undefined
  }

/** Pelias gives `country_code` (alpha-2) and `country_a` (alpha-3). Only the alpha-2 is reported; the
 *  first run sliced "CHN" to "CH" and put Shenzhen in Switzerland. */
function orsCountry(props: Record<string, unknown>): string | undefined {
  const cc = props.country_code
  if (typeof cc === 'string' && /^[A-Za-z]{2}$/.test(cc)) return cc.toUpperCase()
  return undefined
}

interface GeoFeature {
  geometry?: { coordinates?: number[] }
  properties?: Record<string, unknown>
}

export interface GeocodeDeps {
  fetchOpts?: FetchJsonOpts
  /** Called once per request that actually went out — retries included — not for cache hits or
   *  coordinate input. */
  onCall?: (provider: GeocodeProvider) => void
  /** The run's stop. */
  signal?: AbortSignal
  /** openrouteservice only, asked once the gate admits the call: the day's quota is known to be
   *  gone, send nothing. Same shape as RouteDeps. */
  refused?: () => boolean
  /** Told of an HTTP 403 inside the gate, before its slot is handed on. */
  onRefused?: () => void
}

/**
 * Resolve one place. Throws `DistanceHttpError` with a sentence for the user; a place the geocoder
 * does not know is a 404-shaped error ("no match"), not an exception the caller has to parse.
 */
export async function geocode(
  text: string,
  provider: GeocodeProvider,
  key: string,
  country: string | undefined,
  deps: GeocodeDeps = {}
): Promise<Place> {
  const direct = parseLatLon(text)
  if (direct) return direct
  const clean = text.trim()
  if (!clean) throw new DistanceHttpError('Empty place name.', 400)
  const k = cacheKey(provider, country, clean)
  const hit = cache.get(k)
  if (hit) return { ...hit, text }
  const running = pending.get(k)
  if (running) return { ...(await running), text }

  const resolving = resolvePlace(clean, text, provider, key, country, deps)
  pending.set(k, resolving)
  try {
    const place = await resolving
    cache.set(k, place)
    return place
  } finally {
    pending.delete(k)
  }
}

async function resolvePlace(
  clean: string,
  text: string,
  provider: GeocodeProvider,
  key: string,
  country: string | undefined,
  deps: GeocodeDeps
): Promise<Place> {
  // Where the search may look (V405). The caller's code wins; else the country the text names at its
  // end, resolved first. "Ningbo Port, China" used to come back as a street in Barcelona and
  // "Bornheim (Pfalz), Germany" as the Bornheim in North Rhine-Westphalia — both plausible-looking,
  // both wrong, both silent. Bound to CN or DE the first cannot happen, the region word settles the
  // second (pickCandidate); a place that does not exist inside the bound is an error that says so.
  const given = country2(country)
  // The trailing country word is read either way — a given code only saves the lookup, and the word
  // must not be mistaken for a region hint below.
  const token = countryToken(clean)
  const derived = !given && token && provider === 'ors' ? await countryOf(token, key, deps) : null
  const bound = given ?? derived ?? undefined
  const boundBy: Place['bound_by'] = given ? 'given' : derived ? 'text' : undefined
  const binding = bound ? { bound, bound_by: boundBy } : {}
  const place =
    provider === 'mapbox'
      ? await gates.mapboxGeocode.run(async () => {
          const { data } = await fetchJson<{ features?: GeoFeature[] }>(
            mapboxGeocodeUrl(clean, bound, key),
            { method: 'GET' },
            {
              ...deps.fetchOpts,
              describeError: describe('Mapbox'),
              onAttempt: () => deps.onCall?.('mapbox'),
              signal: deps.signal
            }
          )
          const f = data?.features?.[0]
          const [lon, lat] = f?.geometry?.coordinates ?? []
          if (!f || typeof lat !== 'number' || typeof lon !== 'number')
            throw new DistanceHttpError(`Mapbox found no place for "${clean}".`, 404, 'no_match')
          const props = f.properties ?? {}
          const ctx = (props.context as { country?: { country_code?: string } } | undefined)?.country
          return {
            text,
            resolved: String(props.full_address ?? props.name ?? props.place_formatted ?? clean),
            lat,
            lon,
            country: ctx?.country_code?.toUpperCase(),
            ...binding,
            via: 'mapbox' as const
          }
        })
      : await gates.orsGeocode.run(async () => {
          if (deps.refused?.()) throw new DistanceHttpError(ORS_QUOTA_SENTENCE, 403)
          const orsGet = (url: string): Promise<{ data: { features?: GeoFeature[] } }> =>
            fetchJson<{ features?: GeoFeature[] }>(
              url,
              { method: 'GET', headers: { Authorization: key, Accept: 'application/json' } },
              {
                ...deps.fetchOpts,
                describeError: describe('openrouteservice'),
                onAttempt: () => deps.onCall?.('ors'),
                signal: deps.signal
              }
            ).catch((e: unknown) => {
              if (e instanceof DistanceHttpError && e.status === 403) deps.onRefused?.()
              throw e
            })
          const hints = regionHints(clean, token)
          // More than a country was named when anything stands before the country token.
          const specific = !!token && clean.split(',').length > 1
          // The region hint goes to the geocoder too, as a one-feature lookup inside the bound: Pelias
          // names its regions in English ("Rhineland-Palatinate"), so "Pfalz" is matched by gid, not by word.
          const feature = async (text: string, layers: string): Promise<GeoFeature | null> => {
            const found = (await orsGet(orsLayerUrl(text, layers, bound))).data?.features?.[0] ?? null
            const q = found?.properties ?? {}
            console.log(
              `[prism-distance] lookup "${text}" (${layers}) → ${found ? `${q.layer}:${q.label} @${found.geometry?.coordinates}` : 'nothing'}`
            )
            return found
          }
          const hintGids: string[] = []
          for (const h of hints) {
            const r = await feature(h, 'region,macroregion,county,localadmin').catch(() => null)
            const gid = r?.properties?.gid
            if (typeof gid === 'string') hintGids.push(gid)
          }
          const disambiguation: Disambiguation = { hints, hintGids, specific }
          const read = (data: { features?: GeoFeature[] } | undefined): Place | null => {
            const f = pickCandidate(data?.features ?? [], disambiguation)
            const [lon, lat] = f?.geometry?.coordinates ?? []
            if (!f || typeof lat !== 'number' || typeof lon !== 'number') return null
            const props = f.properties ?? {}
            return {
              text,
              resolved: String(props.label ?? props.name ?? clean),
              lat,
              lon,
              country: orsCountry(props),
              ...binding,
              via: 'ors' as const
            }
          }
          const found = read((await orsGet(orsGeocodeUrl(clean, bound))).data)
          if (found) return found
          const where = bound
            ? ` in ${bound}${boundBy === 'text' ? ' (the country read from the end of the text — pass from_country/to_country or "lat, lon" if that is wrong)' : ''}`
            : ''
          throw new DistanceHttpError(
            `openrouteservice found no place for "${clean}"${where}.`,
            404,
            'no_match'
          )
        })
  return place
}

export interface Suggestion {
  label: string
  lat: number
  lon: number
  country?: string
}

/** The minimum the panel types before a suggestion request goes out — fewer letters match everything. */
export const SUGGEST_MIN_CHARS = 3

/**
 * Typeahead over openrouteservice's Pelias autocomplete — the panel's suggestions while typing, ORS
 * only (Mapbox charges per request and it is not offered there). Same rate gate and the same
 * daily plan as the lookups; the panel debounces (300 ms) before it ever gets here. Never throws: a
 * failed suggestion is an empty list, the user simply types on.
 */
export async function suggest(
  text: string,
  key: string,
  country: string | undefined,
  deps: GeocodeDeps = {}
): Promise<Suggestion[]> {
  const clean = text.trim()
  if (clean.length < SUGGEST_MIN_CHARS || parseLatLon(clean)) return []
  // The same binding as a lookup (V405): the panel resolves its places through these suggestions, so
  // without it "Ningbo Port, China" was offered as a street in Barcelona before the lookup ever ran.
  const token = country2(country) ? null : countryToken(clean)
  const bound = country2(country) ?? (token ? ((await countryOf(token, key, deps)) ?? undefined) : undefined)
  try {
    return await gates.orsGeocode.run(async () => {
      deps.onCall?.('ors')
      const { data } = await fetchJson<{ features?: GeoFeature[] }>(
        orsAutocompleteUrl(clean, bound),
        { method: 'GET', headers: { Authorization: key, Accept: 'application/json' } },
        { ...deps.fetchOpts, timeoutMs: 6_000, describeError: describe('openrouteservice') }
      )
      const out: Suggestion[] = []
      for (const f of data?.features ?? []) {
        const [lon, lat] = f.geometry?.coordinates ?? []
        const props = f.properties ?? {}
        if (typeof lat !== 'number' || typeof lon !== 'number') continue
        const label = String(props.label ?? props.name ?? '').trim()
        if (!label || out.some((o) => o.label === label)) continue
        out.push({
          label,
          lat,
          lon,
          country: orsCountry(props)
        })
      }
      return out
    })
  } catch {
    return []
  }
}
