/**
 * One entry point for both callers — the assistant's `distances` tool and the Distances panel:
 * geocode, then route / sail / measure, then adjust, then say where it all came from.
 *
 * Caps are checked here and their effect is always NAMED: a pair the turn or day budget could not
 * afford appears under `skipped` with the reason, never vanishes (the research tool's doctrine).
 * Failures are per pair — one unknown address does not cost the other nine their answer.
 */
import {
  ATTRIBUTION_CATALOGUE,
  ATTRIBUTION_GEOCODER,
  ATTRIBUTION_ROUTING,
  ATTRIBUTION_SEA,
  DISTANCE_METHOD,
  MAX_PAIRS_PER_CALL,
  SEA_GAP_WARN_KM,
  RAIL_CAVEAT,
  TRANSPORT_MODES,
  type TransportMode,
  type TransportSettings
} from '../../shared/distanceDefaults'
import { geocode, type GeocodeDeps, needsGeocoding, countryToken } from './geocode'
import { geodesicKm } from './geo'
import { pickTerminals, routeAccessLeg } from './access'
import { adjust } from './glec'
import { DistanceHttpError, type FetchJsonOpts } from './http'
import { roadKm } from './route'
import type {
  DistanceBatch,
  GeocodeProvider,
  PairInput,
  PairResult,
  Place,
  QuotaState,
  TurnBudget
} from './types'
import { recordDistanceCalls, usedGeocodingToday, usedToday } from './usage'

export interface DistanceKeys {
  ors: string | null
  mapbox: string | null
}

export interface ComputeOpts {
  settings: TransportSettings
  keys: DistanceKeys
  /** The turn's call budget; absent for the panel, which has no per-turn cap. */
  turn?: TurnBudget
  /** The backend transport for the sea endpoint. */
  backend: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>
  fetchOpts?: FetchJsonOpts
  /** The run's stop: geocoding and routing still waiting in a gate give up. */
  signal?: AbortSignal
}

/**
 * Which geocoder will answer: the chosen one if its key exists, else none — never the other one. Place
 * names go to the service the user picked and to no other (PRIVACY.md says exactly that); a fallback to
 * a stored Mapbox token sent addresses to a US service while the card said openrouteservice.
 */
export function effectiveGeocoder(settings: TransportSettings, keys: DistanceKeys): GeocodeProvider | null {
  const chosen: GeocodeProvider = settings.geocoder === 'mapbox' ? 'mapbox' : 'ors'
  return keys[chosen] ? chosen : null
}

/** True when any mode can run at all — the switch that hides the tool and disables the panel. */
export const distancesAvailable = (settings: TransportSettings, keys: DistanceKeys): boolean =>
  effectiveGeocoder(settings, keys) !== null

const isMode = (v: unknown): v is TransportMode => TRANSPORT_MODES.includes(v as TransportMode)

/** One place end for the geocoder's dedupe — case-folded, as the geocode cache folds it. */
const endKey = (text: string, country?: string): string =>
  `${(country ?? '').toLowerCase()}|${text.trim().toLowerCase()}`

/** One place end for the catalogue — case KEPT: "HAM" is Hamburg Airport, "Ham" is a place, and a
 *  folded key made both ends of "Ham → HAM" the airport and the leg 0 km. */
const catKey = (text: string, country?: string): string => `${country2(country) ?? ''}|${text.trim()}`

interface CatalogueItem {
  match: { code: string; label: string; lat: number; lon: number; country: string } | null
  error: string | null
}

/**
 * Air and sea: ask the bundled airport / port list first (backend, local, free). A code ("FRA",
 * "DEHAM") or a named terminal ("Shanghai Pudong Airport", "Port of Rotterdam") resolves there and
 * costs no geocoding call; a name several terminals share is an error that lists them; anything else
 * goes to the geocoder as before. A failing backend only means "no catalogue" — never a lost pair.
 */
async function resolveCatalogue(
  mode: TransportMode,
  pairs: PairInput[],
  backend: ComputeOpts['backend']
): Promise<{ places: Map<string, Place | Error>; used: boolean; failed: boolean }> {
  const places = new Map<string, Place | Error>()
  // Air and sea ask their catalogue for every place. A road or rail leg asks it only for a text that
  // names a terminal: "Ningbo Port, China" went to the geocoder, which knows no such venue and offered
  // five streets called Ningbo Road — the port the catalogue has stood a province away (V405). The
  // port's coordinates are where the lorry leg starts, so the catalogue answers for it here too.
  const kinds: Array<{ kind: 'airport' | 'port'; wanted: (text: string) => boolean }> =
    mode === 'air'
      ? [{ kind: 'airport', wanted: () => true }]
      : mode === 'sea'
        ? [{ kind: 'port', wanted: () => true }]
        : [
            { kind: 'port', wanted: (t) => asksForTerminal('sea', t) },
            { kind: 'airport', wanted: (t) => asksForTerminal('air', t) }
          ]
  let used = false
  for (const { kind, wanted } of kinds) {
    const ends = new Map<string, { text: string; country?: string }>()
    // Coordinates too: one lying ON a terminal is that terminal, and knowing it here keeps its road
    // leg out of the budget below.
    for (const p of pairs)
      for (const [text, country] of [
        [p.from, p.from_country],
        [p.to, p.to_country]
      ] as const)
        if (wanted(text) && !places.has(catKey(text, country)))
          // The catalogue reads "Ningbo Port" and "Port of Ningbo", not "Ningbo Port, China": the
          // country word a free-text place ends with is for the geocoder (V405), not for the list.
          ends.set(catKey(text, country), { text: withoutCountryWord(text), country: country2(country) })
    if (!ends.size) continue
    const list = [...ends.entries()]
    try {
      const res = await backend('POST', '/api/v1/distances/places/resolve', {
        kind,
        items: list.map(([, v]) => ({
          text: v.text.slice(0, 200),
          ...(v.country ? { country: v.country } : {})
        }))
      })
      const items = (res.body as { items?: CatalogueItem[] } | null)?.items
      // One answer per question, in order — anything else cannot be matched up and is ignored whole.
      if (res.status !== 200 || !Array.isArray(items) || items.length !== list.length)
        return { places, used, failed: true }
      list.forEach(([k, v], i) => {
        const it = items[i]
        if (it?.error) places.set(k, new Error(it.error))
        else if (it?.match) {
          used = true
          places.set(k, {
            text: v.text,
            resolved: it.match.label,
            lat: it.match.lat,
            lon: it.match.lon,
            country: it.match.country,
            via: 'catalogue'
          })
        }
      })
    } catch {
      return { places, used, failed: true }
    }
  }
  return { places, used, failed: false }
}

/**
 * Whether a text asks for a terminal — the same test the backend makes (engine/transport_catalogue.py):
 * a code, a panel label carrying one, or an airport/port word. Needed for the one case the backend
 * cannot answer: when the catalogue is unreachable, such a text must fail, not go to the geocoder,
 * whose first hit for "London airport" was London, Ontario.
 */
const TERMINAL_TEXT = {
  air: [
    /^[A-Z]{3,4}$/,
    /\([A-Z]{3,4}[,)]/,
    /\b(airports?|international|intl|airfield|aerodrome|flughafen|a[eé]roport|aeropuerto|aeroporto|luchthaven|lotnisko)\b/i
  ],
  sea: [
    /^[A-Z]{2}\s?[A-Z0-9]{3}$/,
    /\([A-Z]{2}\s?[A-Z0-9]{3}[,)]/,
    /\b(ports?|harbou?r|hafen|seaport|porto|puerto|haven|havn|hamn|terminal|container)\b/i
  ]
} as const
const asksForTerminal = (mode: 'air' | 'sea', text: string): boolean =>
  TERMINAL_TEXT[mode].some((re) => re.test(text.trim()))

const country2 = (c?: string): string | undefined => {
  const v = (c ?? '').trim()
  return /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : undefined
}

/** "Ningbo Port, China" → "Ningbo Port"; a text that names no country at its end is returned as typed. */
const withoutCountryWord = (text: string): string => {
  const t = text.trim()
  return countryToken(t) ? t.slice(0, t.lastIndexOf(',')).trim() : t
}

const samePoint = (a: Place, b: Place): boolean => a.lat === b.lat && a.lon === b.lon

const SAME_PLACE_NOTE = 'Origin and destination are the same point — no transport, 0 km.'

const CROSSING_NOTE =
  'On a ferry or a vehicle shuttle train (openrouteservice cannot tell which) — NOT in km. Check the route and model it as its own sea or rail leg.'

const UNRESOLVED_NOTE =
  'The route could not be checked for ferry or shuttle-train crossings — km may include one. Check the route before using it.'

interface SeaLegOut {
  km: number | null
  from_snap_km: number | null
  to_snap_km: number | null
  passages: string[]
  via?: string
  error: string | null
}

export async function computeDistances(
  modeRaw: unknown,
  pairsRaw: unknown,
  opts: ComputeOpts
): Promise<DistanceBatch> {
  if (!isMode(modeRaw))
    throw new Error(
      `Unknown mode "${String(modeRaw ?? '')}". Expected one of: ${TRANSPORT_MODES.join(' | ')}.`
    )
  const mode = modeRaw
  const pairs = normalisePairs(pairsRaw)
  const catalogue = await resolveCatalogue(mode, pairs, opts.backend)
  // Road first: it needs openrouteservice whichever geocoder is chosen, so "choose the other geocoder"
  // would be the wrong advice for it.
  if (mode === 'road' && !opts.keys.ors)
    throw new Error(
      'Road routing needs an openrouteservice key — add one under Settings → Transport distances.'
    )
  const geocoder = effectiveGeocoder(opts.settings, opts.keys)
  if (!geocoder) {
    // Only the chosen geocoder is ever asked (see effectiveGeocoder); name what it lacks, and the other
    // one only when switching to it would work.
    const mapbox = opts.settings.geocoder === 'mapbox'
    const other = mapbox ? (opts.keys.ors ? 'openrouteservice' : null) : opts.keys.mapbox ? 'Mapbox' : null
    throw new Error(
      `The geocoder chosen under Settings → Transport distances has no ${mapbox ? 'Mapbox token' : 'openrouteservice key'} yet — the user can add it there${other ? `, or choose ${other}, whose key is already stored` : ''}.`
    )
  }

  const geocodeKey = geocoder === 'mapbox' ? opts.keys.mapbox! : opts.keys.ors!
  // Air and sea deliver the road to and from the terminals as legs of their own (default on); that
  // needs the road router. Without its key the old place-to-place figure stands, and says why.
  const accessWanted = (mode === 'air' || mode === 'sea') && opts.settings.accessLegs
  const accessOn = accessWanted && !!opts.keys.ors
  // Road calls an access leg can cost: one per end that is not itself a catalogue terminal — a
  // terminal-to-terminal pair ("FRA → PVG") costs none.
  const accessRoutesFor = (p: PairInput): number =>
    accessOn
      ? [catKey(p.from, p.from_country), catKey(p.to, p.to_country)].filter((k) => {
          const hit = catalogue.places.get(k)
          return !hit || hit instanceof Error
        }).length
      : 0
  const dailyGeocodeLimit = opts.settings.dailyCalls.geocode
  const dailyRouteLimit = opts.settings.dailyCalls.route

  // Affordability is decided per pair, in order, against what the pair will really cost: a
  // coordinate input or a cached place costs no geocoding call. Charging every pair two calls
  // refused "53.55, 9.99 → 48.86, 2.35" — pure arithmetic — once the day's geocoding was used up.
  const skipped: DistanceBatch['skipped'] = []
  const todo: PairInput[] = []
  let reserved = 0
  let geocodesPlanned = 0
  let routesPlanned = 0
  const geocodedToday = usedGeocodingToday()
  const routedToday = usedToday('route')
  const planned = new Set<string>()
  for (const p of pairs) {
    // Within this batch a place is geocoded once (geocode.ts dedupes the calls in flight), so the
    // second pair naming it costs nothing.
    const ends = [
      [p.from, p.from_country],
      [p.to, p.to_country]
    ] as const
    let geocodes = 0
    for (const [text, country] of ends) {
      const k = endKey(text, country)
      if (
        !catalogue.places.has(catKey(text, country)) &&
        needsGeocoding(text, geocoder, country) &&
        !planned.has(k)
      )
        geocodes += 1
    }
    const routes = (mode === 'road' ? 1 : 0) + accessRoutesFor(p)
    const needPerPair = geocodes + routes
    if (opts.turn && opts.turn.remaining - reserved < needPerPair) {
      skipped.push({
        from: p.from,
        to: p.to,
        reason: `per-turn limit of ${opts.turn.limit} API calls reached`
      })
      continue
    }
    if (dailyGeocodeLimit > 0 && geocodedToday + geocodesPlanned + geocodes > dailyGeocodeLimit) {
      skipped.push({
        from: p.from,
        to: p.to,
        reason: `daily geocoding limit of ${dailyGeocodeLimit} calls reached`
      })
      continue
    }
    if (routes > 0 && dailyRouteLimit > 0 && routedToday + routesPlanned + routes > dailyRouteLimit) {
      skipped.push({
        from: p.from,
        to: p.to,
        reason: `daily routing limit of ${dailyRouteLimit} calls reached`
      })
      continue
    }
    todo.push(p)
    // Only ends that really go to the geocoder: "HAM" answered by the catalogue must not make a
    // later "Ham" look already paid for — the fold would merge them.
    for (const [text, country] of ends)
      if (!catalogue.places.has(catKey(text, country))) planned.add(endKey(text, country))
    reserved += needPerPair
    geocodesPlanned += geocodes
    routesPlanned += routes
  }

  // Reserved on the SHARED budget now, not charged call by call later: two distance tools in one
  // round (they are parallel-safe) both passed the check above against the same remaining count and
  // together spent twice what was left. What the reservation does not use —
  // a retry counts, a failed leg's second call does not happen — is handed back at the end.
  opts.turn?.take(reserved)
  let spent = 0
  const geoDeps: GeocodeDeps = {
    fetchOpts: opts.fetchOpts,
    signal: opts.signal,
    onCall: (prov) => {
      spent += 1
      recordDistanceCalls(prov, 'geocode', 1)
    }
  }
  const onRouteCall = (): void => {
    spent += 1
    recordDistanceCalls('ors', 'route', 1)
  }
  // The first HTTP 403 from openrouteservice most likely means the day's quota is gone (or the key
  // is): every further request TO THAT ENDPOINT would be refused the same way, so none is sent.
  // Geocoding and routing are two allowances — a refused geocode must not stop a pair whose places
  // are already known from being routed. 429 (per minute) is not this:
  // fetchJson has already retried it once.
  let geocodeRefused = false
  let routeRefused = false
  if (geocoder === 'ors') {
    geoDeps.refused = () => geocodeRefused
    geoDeps.onRefused = () => {
      geocodeRefused = true
    }
  }
  const place = async (text: string, country: string | undefined): Promise<Place | Error> => {
    const hit = catalogue.places.get(catKey(text, country))
    if (hit) return hit instanceof Error ? hit : { ...hit, text }
    if (catalogue.failed && (mode === 'air' || mode === 'sea') && asksForTerminal(mode, text))
      return new Error(
        `The ${mode === 'air' ? 'airport' : 'port'} list could not be read, so "${text.trim()}" was not checked against it — try again, or pass the place as "lat, lon".`
      )
    try {
      return await geocode(text, geocoder, geocodeKey, country, geoDeps)
    } catch (e) {
      return e as Error
    }
  }

  // Geocode everything first (the gates pace the requests), so the sea legs can go to the backend
  // in one request and the road legs can start as soon as both ends of a pair are known.
  const places = await Promise.all(
    todo.map(async (p): Promise<{ from: Place | Error; to: Place | Error }> => {
      const [from, to] = await Promise.all([place(p.from, p.from_country), place(p.to, p.to_country)])
      return { from, to }
    })
  )

  const results: PairResult[] = todo.map((p, i) => {
    const { from, to } = places[i]
    if (from instanceof Error || to instanceof Error) {
      const parts = [
        from instanceof Error ? `from: ${from.message}` : '',
        to instanceof Error ? `to: ${to.message}` : ''
      ]
      return {
        from: from instanceof Error ? { text: p.from } : from,
        to: to instanceof Error ? { text: p.to } : to,
        error: parts.filter(Boolean).join(' ')
      }
    }
    return { from, to }
  })

  // The same point twice is no transport: 0 km, no request, no adjustment (an air "leg" would
  // otherwise get its 95 km). Two DIFFERENT points never come back as 0 — see the road and sea arms.
  for (const r of results) {
    if (r.error || !samePoint(r.from as Place, r.to as Place)) continue
    Object.assign(r, { km: 0, raw_km: 0, adjustment: null, note: SAME_PLACE_NOTE })
  }
  const ready = results.map((r, i) => ({ r, i })).filter(({ r }) => !r.error && r.km === undefined)

  // Where each main leg starts and ends: the places themselves, or — with access legs — their
  // terminals. A pair whose terminal cannot be chosen fails on its own.
  const mainEnds = new Map<PairResult, { f: Place; t: Place }>()
  for (const { r } of ready) mainEnds.set(r, { f: r.from as Place, t: r.to as Place })
  const named = ready.some(({ i }) => todo[i].from_terminal || todo[i].to_terminal)
  if ((mode === 'air' || mode === 'sea') && ready.length && (accessOn || named)) {
    const picks = await pickTerminals(
      mode === 'air' ? 'airport' : 'port',
      ready.map(({ r, i }) => ({ r, p: todo[i] })),
      opts.backend,
      !accessOn
    )
    for (const { r } of ready) {
      const pick = picks.get(r)
      if (!pick || pick instanceof Error) {
        r.error = pick instanceof Error ? pick.message : 'no terminal could be chosen'
        mainEnds.delete(r)
        continue
      }
      mainEnds.set(r, { f: pick.from.place, t: pick.to.place })
      const access: NonNullable<PairResult['access']> = {}
      if (pick.from.leg) access.from = pick.from.leg
      if (pick.to.leg) access.to = pick.to.leg
      if (!accessOn) {
        // Named terminals move the main leg; the road to them is not computed here — say so.
        const moved = [access.from?.terminal, access.to?.terminal].filter(Boolean)
        if (moved.length)
          r.note = `Main leg from/to the named terminal (${moved.join(', ')}); the road legs to it are not computed${accessWanted ? ' (no openrouteservice key)' : ' (access legs are switched off)'}.`
        continue
      }
      if (access.from || access.to) r.access = access
    }
  }
  // The terminals as chosen, kept for the access legs even where the main leg drops out below.
  const terminals = new Map(mainEnds)
  // Both places served by the same terminal: no flight or voyage — 0, no adjustment, legs still due.
  for (const [r, e] of mainEnds)
    if (samePoint(e.f, e.t)) {
      Object.assign(r, {
        km: 0,
        raw_km: 0,
        adjustment: null,
        note: `Both places use ${e.f.resolved} — no ${mode === 'air' ? 'flight' : 'sea leg'}, 0 km.`
      })
      mainEnds.delete(r)
    }
  const main = ready.filter(({ r }) => mainEnds.has(r))

  if (mode === 'air' || mode === 'rail') {
    for (const { r } of main) {
      const { f, t } = mainEnds.get(r)!
      Object.assign(r, adjust(mode, geodesicKm(f.lat, f.lon, t.lat, t.lon), opts.settings))
    }
  } else if (mode === 'road') {
    await Promise.all(
      ready.map(async ({ r }) => {
        const f = r.from as Place
        const t = r.to as Place
        try {
          const route = await roadKm(f, t, opts.keys.ors!, {
            fetchOpts: opts.fetchOpts,
            onCall: onRouteCall,
            signal: opts.signal,
            refused: () => routeRefused,
            onRefused: () => {
              routeRefused = true
            }
          })
          if (route.km <= 0) {
            r.error = 'openrouteservice returned 0 km between two different places — check both places.'
            return
          }
          Object.assign(r, adjust('road', route.km, opts.settings, route.crossingKm), {
            crossings: route.crossings
          })
          if (route.crossings === 'present')
            r.crossing = { km: Math.round(route.crossingKm * 10) / 10, note: CROSSING_NOTE }
          else if (route.crossings === 'unresolved') r.note = UNRESOLVED_NOTE
        } catch (e) {
          r.error = e instanceof DistanceHttpError || e instanceof Error ? e.message : String(e)
        }
      })
    )
  } else if (main.length) {
    const legs = main.map(({ r, i }) => {
      const { f, t } = mainEnds.get(r)!
      return {
        from: { lat: f.lat, lon: f.lon },
        to: { lat: t.lat, lon: t.lon },
        via: todo[i].via === 'cape' ? 'cape' : 'shortest'
      }
    })
    try {
      const res = await opts.backend('POST', '/api/v1/distances/sea', { legs })
      const out = (res.body as { legs?: SeaLegOut[] } | null)?.legs
      if (res.status !== 200 || !Array.isArray(out))
        throw new Error(`sea routing failed (HTTP ${res.status})`)
      main.forEach(({ r }, k) => {
        const leg = out[k]
        if (!leg || leg.km === null) {
          r.error = leg?.error ? `sea routing: ${leg.error}` : 'sea routing returned nothing for this leg'
          return
        }
        Object.assign(r, adjust('sea', leg.km, opts.settings))
        const via = leg.via === 'cape' ? 'cape' : 'shortest'
        r.sea = {
          from_snap_km: leg.from_snap_km ?? 0,
          to_snap_km: leg.to_snap_km ?? 0,
          passages: leg.passages ?? [],
          via
        }
        // Name the passages actually sailed — a generic "usually via Suez" made the model write "via
        // Suez" for Santos → Hamburg. The Cape hint only where Suez was used.
        const passages = leg.passages ?? []
        const sailed = passages.length
          ? `Shortest feasible route via ${passages.join(', ')}`
          : 'Shortest feasible route'
        r.note =
          (r.note ? `${r.note} ` : '') +
          (via === 'cape'
            ? 'Routed around the Cape of Good Hope (Suez and Panama avoided) — record that assumption. '
            : `${sailed}.${passages.includes('suez') ? ' Ask via="cape" for the routing around Africa instead.' : ''} `) +
          (r.access
            ? 'Port to port. The road legs to and from the ports are under "access", not in km.'
            : 'Port/node to port/node. The road or rail leg from each place to its node is NOT included — see the snap distances.')
        const gap = Math.max(leg.from_snap_km ?? 0, leg.to_snap_km ?? 0)
        if (r.access && gap >= SEA_GAP_WARN_KM)
          r.note += ` A port lies ${Math.round(gap)} km from the shipping-lane network (a river or coastal approach): that stretch is in no leg — check the port, or add it yourself.`
      })
      recordDistanceCalls('searoute', 'sea', legs.length)
    } catch (e) {
      for (const { r } of main) r.error = e instanceof Error ? e.message : String(e)
    }
  }

  // The access legs, all at once through the routing gate. A failed leg is the leg's error; the
  // main leg stands either way.
  let accessRouted = false
  if (accessOn) {
    const jobs: Array<Promise<void>> = []
    for (const { r } of ready) {
      if (r.error || !r.access) continue
      for (const side of ['from', 'to'] as const) {
        const leg = r.access[side]
        if (!leg) continue
        const ends = terminals.get(r)
        if (!ends) continue
        const tPlace = side === 'from' ? ends.f : ends.t
        if (leg.km === undefined) accessRouted = true
        jobs.push(
          routeAccessLeg(
            leg,
            r[side] as Place,
            tPlace,
            side === 'from' ? 'end' : 'start',
            opts.keys.ors!,
            opts.settings,
            {
              fetchOpts: opts.fetchOpts,
              onCall: onRouteCall,
              signal: opts.signal,
              refused: () => routeRefused,
              onRefused: () => {
                routeRefused = true
              }
            }
          )
        )
      }
    }
    await Promise.all(jobs)
  }

  // What the reservation did not use goes back — see the comment at `take(reserved)`.
  opts.turn?.release(Math.max(0, reserved - spent))

  const attribution = [
    mode === 'road'
      ? ATTRIBUTION_ROUTING
      : mode === 'sea'
        ? ATTRIBUTION_SEA
        : 'Great-circle distance (WGS84)',
    ...(catalogue.used || accessOn ? [ATTRIBUTION_CATALOGUE[mode === 'air' ? 'airport' : 'port']] : []),
    ...(accessRouted ? [`Access legs: ${ATTRIBUTION_ROUTING}`] : []),
    ATTRIBUTION_GEOCODER[geocoder]
  ].join(' · ')

  return {
    mode,
    geocoder,
    results,
    attribution,
    method: DISTANCE_METHOD[mode],
    ...(accessWanted && !accessOn
      ? {
          access_note:
            'Access legs by road need an openrouteservice key — not computed; the distance runs place to place.'
        }
      : {}),
    ...(mode === 'rail' ? { rail_caveat: RAIL_CAVEAT } : {}),
    quota: quotaState(opts),
    ...(skipped.length ? { skipped } : {})
  }
}

export function quotaState(opts: Pick<ComputeOpts, 'settings' | 'turn'>): QuotaState {
  return {
    turn_used: opts.turn?.used ?? 0,
    turn_limit: opts.turn?.limit ?? 0,
    day_geocode_used: usedGeocodingToday(),
    day_geocode_limit: opts.settings.dailyCalls.geocode,
    day_route_used: usedToday('route'),
    day_route_limit: opts.settings.dailyCalls.route
  }
}

function normalisePairs(raw: unknown): PairInput[] {
  // The array arrived JSON-encoded as ONE string (MiniMax M3 did this twice, GLM before
  // it — V279): name the mistake, or the model retries the same shape. Same doctrine as research_web.
  if (typeof raw === 'string' && raw.trim())
    throw new Error(
      '"pairs" arrived as ONE string, not an array — send a real JSON array of objects, e.g. ' +
        '{"mode": "road", "pairs": [{"from": "Binh Duong, Vietnam", "to": "Cat Lai port, Ho Chi Minh City"}]} — do not wrap the array in quotes or concatenate the places.'
    )
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'item' in (raw as object))
    throw new Error(
      '"pairs" arrived as an OBJECT {"item": …}, not an array — send the plain JSON array itself: ' +
        '{"pairs": [{"from": "Hamburg", "to": "Prague"}]}, no "item" wrapper.'
    )
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Pass at least one pair: pairs=[{from, to}].')
  if (raw.length > MAX_PAIRS_PER_CALL)
    throw new Error(
      `At most ${MAX_PAIRS_PER_CALL} pairs per call — you passed ${raw.length}. Split them over several calls.`
    )
  return raw.map((p, i) => {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>
    const from = String(o.from ?? '').trim()
    const to = String(o.to ?? '').trim()
    if (!from || !to)
      throw new Error(`Pair ${i + 1} needs both "from" and "to" as place names or "lat, lon".`)
    return {
      from,
      to,
      ...(typeof o.from_country === 'string' ? { from_country: o.from_country } : {}),
      ...(typeof o.to_country === 'string' ? { to_country: o.to_country } : {}),
      ...(o.via === 'cape' ? { via: 'cape' as const } : {}),
      ...(typeof o.from_terminal === 'string' && o.from_terminal.trim()
        ? { from_terminal: o.from_terminal.trim() }
        : {}),
      ...(typeof o.to_terminal === 'string' && o.to_terminal.trim()
        ? { to_terminal: o.to_terminal.trim() }
        : {})
    }
  })
}
