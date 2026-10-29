/**
 * Transport-distance defaults shared by the main process and the renderer.
 *
 * Same constraints as aiDefaults.ts: plain values and pure functions only — this module is compiled
 * into both bundles. The numbers here are the ones the Settings sheet PRINTS beside their source, so
 * a change to a figure and a change to its sentence cannot drift apart.
 */

export type TransportMode = 'road' | 'sea' | 'air' | 'rail'
export const TRANSPORT_MODES: readonly TransportMode[] = ['road', 'sea', 'air', 'rail']

export type GeocodeProvider = 'ors' | 'mapbox'

/** GLEC Framework v3.2 (21.10.2025, unchanged from v3.0) / ISO 14083: the planned road distance is
 *  raised by 5 % for the distance a vehicle actually drives (detours, depots, congestion). Applied to
 *  the part of a route driven on roads only — a ferry or shuttle-train crossing is not a road. */
export const GLEC_ROAD_FACTOR = 1.05
/** GLEC Framework v3.2 / EN 16258: air freight distance is the great-circle distance plus a fixed
 *  95 km for take-off, holding and landing patterns — additive, not a factor, and PER FLIGHT LEG:
 *  a trip with a stopover is two legs, two great circles, twice the 95 km. */
export const GLEC_AIR_ADD_KM = 95
/**
 * GLEC Framework v3.2 (21.10.2025), sea chapter: "In the absence of a specific operational DAF, a
 * default global value can be used. Clean Cargo recommends using a DAF of 1.15 since actual sea
 * container transport distances were found to be on average 15% greater than the shortest feasible
 * port-to-port route." The network's shortest path IS that shortest feasible route, so the factor
 * applies to the sailed km — never to the snap offsets, which are not sailed.
 * Applied since the v3.2 check; an earlier version left it out.
 */
export const GLEC_SEA_FACTOR = 1.15
/**
 * Rail has no GLEC or ISO 14083 factor — both ask for the shortest feasible network distance, which
 * needs a rail router PrismLCA does not have (checked in the GLEC v3 text itself: "Rail
 * distance can be difficult to identify … EcoTransIT's online tool can be used", no figure; still
 * no figure in v3.2).
 *
 * Default 1.2 = the circuity (network ÷ great-circle) of European FREIGHT CORRIDORS: Hamburg–Warsaw
 * 1.13, Duisburg–Vienna 1.18, Antwerp–Basel 1.24, Hamburg–Munich 1.27, Rotterdam–Milan 1.32–1.38,
 * Hamburg–Prague close to 1.0. The country-pair median of 1.42 (Heinold & Makowski, "Driving the Extra
 * Mile", 2024/25, range 1.13–2.07) was the first default and overshot Hamburg–Prague by 42 % in a
 * real run (V318): it averages over island states and peripheral pairs a freight leg rarely
 * is. It stays the upper bound the sheet names. A single editable number, honestly labelled.
 */
export const RAIL_CIRCUITY_EU = 1.2
export const RAIL_FACTOR_MIN = 1.0
export const RAIL_FACTOR_MAX = 3.0

export const ADJUSTMENT_SOURCES: Record<TransportMode, string> = {
  road: 'GLEC Framework v3.2 (Oct 2025) / ISO 14083 distance adjustment factor — planned road distance × 1.05 for the distance actually driven. Not applied to ferry or shuttle-train crossings.',
  air: 'GLEC Framework v3.2 (Oct 2025) / EN 16258 — great-circle distance + 95 km per flight leg for take-off, holding and landing.',
  rail: 'No GLEC/ISO 14083 factor exists. Default 1.2 = circuity (network ÷ great-circle) of European freight corridors (1.1–1.35: Hamburg–Warsaw 1.13, Antwerp–Basel 1.24, Rotterdam–Milan ≈ 1.35); the country-pair median of 1.42 ("Driving the Extra Mile", Heinold & Makowski 2024/25, range 1.13–2.07) is the upper bound.',
  sea: 'GLEC Framework v3.2 (Oct 2025), default global value after Clean Cargo — sailed distance × 1.15: actual container routes average 15 % longer than the shortest feasible port-to-port route. Not applied to the distance from a place to its sea node.'
}

/**
 * The method each mode's figure was produced with, written into the provenance log beside every
 * value. Bump the date when the method changes, so a figure logged under the old method stays
 * recognisable as such (e.g. road values from before the ferry check).
 */
export const DISTANCE_METHOD: Record<TransportMode, string> = {
  road: 'road v2026-09-29: openrouteservice driving-hgv, ferry/shuttle-train check (waycategory)',
  sea: 'sea v2026-09-29b: searoute port to port, road access legs apart, GLEC v3.2 sea factor',
  air: 'air v2026-09-29b: great circle airport to airport, road access legs apart',
  rail: 'rail v2026-09-05: WGS84 great circle × circuity factor'
}

/** Printed with every rail answer, verbatim. */
export const RAIL_CAVEAT =
  'Rail distance is the great-circle distance times a circuity factor. It says nothing about whether rail infrastructure exists on this relation.'

/** openrouteservice free plan (HeiGIT, account.heigit.org/info/plans, checked 2026-09-05). */
export const ORS_FREE_PLAN = {
  geocodePerDay: 3000,
  geocodePerMinute: 100,
  routePerDay: 2000,
  routePerMinute: 40
} as const

/**
 * Access legs: in air and sea mode the road from a place to its airport or port,
 * and from the arrival terminal on, is delivered as its own road leg by default — the flight or
 * voyage itself runs terminal to terminal, as GLEC measures it.
 *
 * ACCESS_TERMINAL_RADIUS_M: how far openrouteservice may look for a lorry road around the TERMINAL
 * end (the place end keeps -1). Bounded so a terminal point is never tied to a road kilometres away.
 * teamtools v2 uses 700 m; measured, that is too tight for the catalogue's points, which
 * for an airport sit on the airfield: of the 40 largest cargo airports only 27 of 39 answered had a
 * lorry road within 700 m (HKG 1.69 km, SZX 1.39, MXP 1.17, KUL 1.11, CGN 1.07, DXB 0.88, SHA 0.77 …),
 * 34 within 1 km, 38 within 1.5 km, all within 2 km; of 30 terminal ports all within 1.01 km.
 * Hence 2 km rather than 700 m; one constant to revert.
 * ACCESS_ZERO_BELOW_KM: a routed access leg shorter than this is set to 0 before any adjustment — at
 * that length it is the geocoder's point against the catalogue's, not a transport.
 * ACCESS_AT_TERMINAL_KM: a place this close (straight line) to its terminal IS the terminal: no leg,
 * no request.
 */
export const ACCESS_TERMINAL_RADIUS_M = 2000
export const ACCESS_ZERO_BELOW_KM = 1
export const ACCESS_AT_TERMINAL_KM = 1
/** A port this far or further from the shipping-lane network leaves that stretch (a river, a
 *  coastal approach) out of every leg — the answer says so. The backend never PICKS such a port
 *  beyond 100 km (engine/transport_catalogue.py, AUTO_PORT_MAX_NETWORK_KM). */
export const SEA_GAP_WARN_KM = 50

/** HeiGIT's Collaborative plan, free on application for research, non-profit and public organisations
 *  (account.heigit.org/info/plans, as quoted in the teamtools v2 research). Named in
 *  the Settings sheet only; the daily limits stay the user's to raise. */
export const ORS_COLLABORATIVE_PLAN = { routePerDay: 10_000, geocodePerDay: 15_000 } as const

/** One pair costs up to three calls (two geocodes + one routing); ten pairs per tool call. */
export const MAX_PAIRS_PER_CALL = 10
export const DEFAULT_PER_TURN_CALLS = 30
export const MIN_PER_TURN_CALLS = 1
export const MAX_PER_TURN_CALLS = 500

/**
 * Mapbox Geocoding v6 with `permanent=true`: 5 $ per 1 000 requests from the first request — the
 * free allowance covers temporary geocodes only, and those may not be stored, which is why PrismLCA
 * never asks for them. openrouteservice is free within the plan above.
 *
 * **Bump `DISTANCE_PRICES_CHECKED` in the same commit as any price** (same rule as OPENAI_PRICES_CHECKED).
 */
export const MAPBOX_PERMANENT_USD_PER_1000 = 5
export const DISTANCE_PRICES_CHECKED = '2026-09-05'

export const ATTRIBUTION_ROUTING =
  'Routing © openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors'
export const ATTRIBUTION_SEA = 'Sea route: searoute on the Eurostat marnet shipping-lane network'
/** Added to the attribution when a catalogue answered for at least one place of the batch. */
export const ATTRIBUTION_CATALOGUE = {
  airport: 'Airports: OurAirports (public domain)',
  port: 'Ports: searoute port list (UN/LOCODE)'
} as const
export const ATTRIBUTION_GEOCODER: Record<GeocodeProvider, string> = {
  ors: 'Geocoding: openrouteservice (© OpenStreetMap contributors)',
  mapbox: 'Geocoding: Mapbox (© Mapbox)'
}
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright'

/** One panel lookup, kept for the "Recent" list (the last five). */
export interface RecentDistance {
  mode: TransportMode
  from: string
  to: string
  /** The adjusted figure the user copies. */
  km: number
  at: string
  geocoder: GeocodeProvider
  /** Sea only: the routing that was asked for; absent = shortest. */
  via?: SeaVia
  /** Air / sea: the road legs to and from the terminals, NOT in `km` — kept per side with what
   *  would make a reused figure incomplete: a failed leg, a crossing in it, an unchecked route. */
  access?: { from?: RecentAccessLeg; to?: RecentAccessLeg }
  /** Road only: a ferry / shuttle-train crossing that is NOT in `km`, or a route that could not be
   *  checked for one — kept so a reused entry still says another leg may be needed. */
  crossing_km?: number
  crossing_unchecked?: true
}
export interface RecentAccessLeg {
  code: string
  km?: number
  failed?: true
  crossing_km?: number
  unchecked?: true
}
export const RECENT_DISTANCES_KEPT = 5

function sanitiseAccessLeg(v: unknown): RecentAccessLeg | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (typeof o.code !== 'string' || !o.code) return undefined
  const km = Number(o.km)
  const crossing = Number(o.crossing_km)
  return {
    code: o.code.slice(0, 12),
    ...(o.km !== undefined && Number.isFinite(km) && km >= 0 ? { km } : {}),
    ...(o.failed === true ? { failed: true as const } : {}),
    ...(Number.isFinite(crossing) && crossing > 0 ? { crossing_km: crossing } : {}),
    ...(o.unchecked === true ? { unchecked: true as const } : {})
  }
}

/** What makes two recent lookups the same route: mode, places (trimmed, case-folded) and the sea option. */
export function recentKey(r: { mode: string; from: string; to: string; via?: string }): string {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')
  return `${r.mode}|${norm(r.from)}|${norm(r.to)}|${r.via ?? 'shortest'}`
}

/** Sea routing: the network's shortest path (usually Suez), or round the Cape of Good Hope — the
 *  routing much Asia–Europe traffic has used since late 2023 (Suez and Panama both avoided). */
export type SeaVia = 'shortest' | 'cape'

export interface TransportSettings {
  geocoder: GeocodeProvider
  /** GLEC adjustment per mode. Rail off = factor 1.0 (pure great-circle). */
  glec: { road: boolean; air: boolean; rail: boolean; sea: boolean }
  railFactor: number
  /** Air / sea: deliver the road legs to and from the terminals separately (default on). */
  accessLegs: boolean
  perTurnCalls: number
  dailyCalls: { geocode: number; route: number }
  /** App-wide switch for the assistant's tool; the chat "+" menu narrows it per chat. */
  toolEnabled: boolean
  recent: RecentDistance[]
}

export const DEFAULT_TRANSPORT: TransportSettings = {
  geocoder: 'ors',
  glec: { road: true, air: true, rail: true, sea: true },
  railFactor: RAIL_CIRCUITY_EU,
  accessLegs: true,
  perTurnCalls: DEFAULT_PER_TURN_CALLS,
  dailyCalls: { geocode: ORS_FREE_PLAN.geocodePerDay, route: ORS_FREE_PLAN.routePerDay },
  toolEnabled: true,
  recent: []
}

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function clampRailFactor(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return RAIL_CIRCUITY_EU
  return Math.min(RAIL_FACTOR_MAX, Math.max(RAIL_FACTOR_MIN, Math.round(n * 100) / 100))
}

const isMode = (v: unknown): v is TransportMode => TRANSPORT_MODES.includes(v as TransportMode)

/**
 * Every field coerced: the value crosses IPC and may come from a hand-edited file, and a nested
 * group is copied wholesale by the settings loader, so this is the one place its fields are checked.
 */
export function sanitiseTransport(raw: unknown): TransportSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const glec = (r.glec && typeof r.glec === 'object' ? r.glec : {}) as Record<string, unknown>
  const daily = (r.dailyCalls && typeof r.dailyCalls === 'object' ? r.dailyCalls : {}) as Record<
    string,
    unknown
  >
  const recent: RecentDistance[] = []
  const seen = new Set<string>()
  if (Array.isArray(r.recent)) {
    for (const item of r.recent) {
      if (!item || typeof item !== 'object') continue
      const e = item as Record<string, unknown>
      const km = Number(e.km)
      if (!isMode(e.mode) || typeof e.from !== 'string' || typeof e.to !== 'string' || !Number.isFinite(km))
        continue
      // The same lookup twice reads as two lookups (V348): one entry per route, the newest kept.
      const key = recentKey({
        mode: e.mode,
        from: e.from,
        to: e.to,
        via: e.via === 'cape' ? 'cape' : undefined
      })
      if (seen.has(key)) continue
      seen.add(key)
      recent.push({
        mode: e.mode,
        from: e.from,
        to: e.to,
        km,
        at: typeof e.at === 'string' ? e.at : '',
        geocoder: e.geocoder === 'mapbox' ? 'mapbox' : 'ors',
        ...(e.via === 'cape' ? { via: 'cape' as const } : {}),
        ...(() => {
          const a = (e.access && typeof e.access === 'object' ? e.access : {}) as Record<string, unknown>
          const from = sanitiseAccessLeg(a.from)
          const to = sanitiseAccessLeg(a.to)
          return from || to ? { access: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {}
        })(),
        ...(Number.isFinite(Number(e.crossing_km)) && Number(e.crossing_km) > 0
          ? { crossing_km: Number(e.crossing_km) }
          : {}),
        ...(e.crossing_unchecked === true ? { crossing_unchecked: true as const } : {})
      })
      if (recent.length >= RECENT_DISTANCES_KEPT) break
    }
  }
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt)
  return {
    geocoder: r.geocoder === 'mapbox' ? 'mapbox' : 'ors',
    glec: {
      road: bool(glec.road, true),
      air: bool(glec.air, true),
      rail: bool(glec.rail, true),
      sea: bool(glec.sea, true)
    },
    railFactor: clampRailFactor(r.railFactor),
    accessLegs: bool(r.accessLegs, true),
    perTurnCalls: clampInt(r.perTurnCalls, MIN_PER_TURN_CALLS, MAX_PER_TURN_CALLS, DEFAULT_PER_TURN_CALLS),
    dailyCalls: {
      geocode: clampInt(daily.geocode, 0, 1_000_000, ORS_FREE_PLAN.geocodePerDay),
      route: clampInt(daily.route, 0, 1_000_000, ORS_FREE_PLAN.routePerDay)
    },
    toolEnabled: bool(r.toolEnabled, true),
    recent
  }
}
