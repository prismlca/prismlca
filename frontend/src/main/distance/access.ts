/**
 * Access legs — the road from a place to its airport or port, and from the arrival terminal on
 * (delivered separately, as road, by default). The flight or voyage itself then
 * runs terminal to terminal, which is how GLEC measures it: the great circle between airports, the
 * sea route between ports.
 *
 * Which terminal: the one the text itself names (a code or "Port of …" — no leg at all), the one the
 * request names in from_terminal / to_terminal, or else the nearest MAJOR one by straight line. The
 * last is a first guess for an inland place, and every answer says which it took and how far away it
 * is, so a wrong pick is visible and can be overridden.
 *
 * Road rules from the teamtools v2 practice: the terminal end snaps within ACCESS_TERMINAL_RADIUS_M
 * only (a terminal point is never tied to a road kilometres away), a place within
 * ACCESS_AT_TERMINAL_KM of its terminal IS the terminal (no request), and a routed leg under
 * ACCESS_ZERO_BELOW_KM is set to 0 before any adjustment. Each leg is checked for ferry crossings like
 * any road route, and fails on its own: the main leg stays.
 */
import {
  ACCESS_AT_TERMINAL_KM,
  ACCESS_TERMINAL_RADIUS_M,
  ACCESS_ZERO_BELOW_KM,
  type TransportSettings
} from '../../shared/distanceDefaults'
import { geodesicKm } from './geo'
import { adjust } from './glec'
import { DistanceHttpError } from './http'
import { roadKm, type RouteDeps } from './route'
import type { AccessLeg, PairInput, PairResult, Place } from './types'

type Backend = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>

interface TerminalOut {
  code: string
  label: string
  lat: number
  lon: number
  country: string
}

/** A place end's terminal: where the main leg starts or ends, and the leg to reach it (if any). */
export interface TerminalPick {
  place: Place
  leg?: AccessLeg
}

const round1 = (n: number): number => Math.round(n * 10) / 10

function asPlace(t: TerminalOut): Place {
  return { text: t.code, resolved: t.label, lat: t.lat, lon: t.lon, country: t.country, via: 'catalogue' }
}

/**
 * For every ready pair, both ends' terminals. An end the catalogue already resolved is its own
 * terminal (no leg); a named terminal is resolved, the rest gets the nearest major one. Throws
 * nothing: a failed lookup becomes the pair's error, since without a terminal there is no main leg.
 */
export async function pickTerminals(
  kind: 'airport' | 'port',
  ready: Array<{ r: PairResult; p: PairInput }>,
  backend: Backend,
  /** Only ends with a NAMED terminal get one — access legs off or no road key: the named terminal
   *  still moves the main leg, the others stay place to place. */
  namedOnly = false
): Promise<Map<PairResult, { from: TerminalPick; to: TerminalPick } | Error>> {
  const out = new Map<PairResult, { from: TerminalPick; to: TerminalPick } | Error>()
  type End = { r: PairResult; side: 'from' | 'to'; place: Place; given?: string }
  const ends: End[] = []
  for (const { r, p } of ready)
    for (const side of ['from', 'to'] as const) {
      const place = r[side] as Place
      if (place.via === 'catalogue') continue
      const given = (side === 'from' ? p.from_terminal : p.to_terminal)?.trim()
      if (namedOnly && !given) continue
      ends.push({ r, side, place, ...(given ? { given } : {}) })
    }

  const named = ends.filter((e) => e.given)
  const nearest = ends.filter((e) => !e.given)
  // 'self': the point lies ON a catalogue entry (its own coordinates pasted back) — that entry is
  // the terminal, with no leg, even when it is not a major one (Portland, Maine is not; the nearest
  // major port is Boston).
  const picked = new Map<End, { t: TerminalOut; chosen: 'given' | 'nearest' | 'self' } | Error>()
  // Each lookup fails only the ends that depended on it: a pair whose ends are all terminals already,
  // or were resolved by the other lookup, keeps its answer.
  const unreadable = (): Error =>
    new Error(
      `The ${kind} list could not be read, so no ${kind} was chosen — try again, or name the ${kind} itself.`
    )
  if (named.length) {
    try {
      const res = await backend('POST', '/api/v1/distances/places/resolve', {
        kind,
        items: named.map((e) => ({ text: e.given!.slice(0, 200) }))
      })
      const items = (res.body as { items?: Array<{ match: TerminalOut | null; error: string | null }> })
        ?.items
      if (res.status !== 200 || !Array.isArray(items) || items.length !== named.length) throw unreadable()
      named.forEach((e, i) => {
        const it = items[i]
        picked.set(
          e,
          it.match
            ? { t: it.match, chosen: 'given' }
            : new Error(
                it.error ?? `${e.side}_terminal "${e.given}" is not in the ${kind} list — pass its code.`
              )
        )
      })
    } catch {
      for (const e of named) picked.set(e, unreadable())
    }
  }
  if (nearest.length) {
    try {
      const res = await backend('POST', '/api/v1/distances/places/nearest', {
        kind,
        points: nearest.map((e) => ({ lat: e.place.lat, lon: e.place.lon }))
      })
      const items = (res.body as { items?: Array<{ terminal: TerminalOut; at?: TerminalOut | null }> })?.items
      if (res.status !== 200 || !Array.isArray(items) || items.length !== nearest.length) throw unreadable()
      nearest.forEach((e, i) =>
        picked.set(
          e,
          items[i].at ? { t: items[i].at!, chosen: 'self' } : { t: items[i].terminal, chosen: 'nearest' }
        )
      )
    } catch {
      for (const e of nearest) picked.set(e, unreadable())
    }
  }

  for (const { r } of ready) {
    const pick: Partial<Record<'from' | 'to', TerminalPick>> = {}
    let failed: Error | null = null
    for (const side of ['from', 'to'] as const) {
      const place = r[side] as Place
      const end = ends.find((e) => e.r === r && e.side === side)
      if (!end) {
        pick[side] = { place }
        continue
      }
      const got = picked.get(end)
      if (!got || got instanceof Error) {
        failed = got instanceof Error ? got : new Error(`no ${kind} for ${side}`)
        break
      }
      if (got.chosen === 'self') {
        pick[side] = { place: { ...asPlace(got.t), text: place.text } }
        continue
      }
      const chosen = got.chosen
      const straight = geodesicKm(place.lat, place.lon, got.t.lat, got.t.lon)
      pick[side] = {
        place: asPlace(got.t),
        leg: {
          terminal: got.t.label,
          code: got.t.code,
          chosen,
          straight_km: round1(straight),
          // A place this close to the terminal is the terminal: a leg of 0, no request.
          ...(straight <= ACCESS_AT_TERMINAL_KM
            ? { km: 0, raw_km: 0, adjustment: null, note: 'The place is at the terminal — no road leg.' }
            : {})
        }
      }
    }
    out.set(r, failed ?? { from: pick.from!, to: pick.to! })
  }
  return out
}

const NEAREST_NOTE =
  'Nearest major terminal by straight line — freight often uses a bigger one further away; name it with from_terminal / to_terminal if the study knows it.'

/**
 * Route one access leg by road. `terminalAt` says which end of the request is the terminal, so its
 * snapping radius is the bounded one. Fills the leg in place; never throws.
 */
export async function routeAccessLeg(
  leg: AccessLeg,
  place: Place,
  terminal: Place,
  terminalAt: 'start' | 'end',
  key: string,
  settings: TransportSettings,
  deps: RouteDeps
): Promise<void> {
  if (leg.km !== undefined) return // at the terminal already
  const [a, b] = terminalAt === 'start' ? [terminal, place] : [place, terminal]
  try {
    const route = await roadKm(a, b, key, {
      ...deps,
      radiuses: terminalAt === 'start' ? [ACCESS_TERMINAL_RADIUS_M, -1] : [-1, ACCESS_TERMINAL_RADIUS_M]
    })
    if (route.km < ACCESS_ZERO_BELOW_KM) {
      Object.assign(leg, {
        km: 0,
        raw_km: round1(route.km),
        adjustment: null,
        note: `Routed ${round1(route.km)} km — under ${ACCESS_ZERO_BELOW_KM} km, set to 0 before any adjustment.`
      })
      return
    }
    Object.assign(leg, adjust('road', route.km, settings, route.crossingKm), { crossings: route.crossings })
    if (route.crossings === 'present')
      leg.crossing = {
        km: round1(route.crossingKm),
        note: 'On a ferry or a vehicle shuttle train — not in this leg’s km; its own leg.'
      }
    const notes = [
      leg.chosen === 'nearest' ? NEAREST_NOTE : '',
      route.crossings === 'unresolved' ? 'Not checked for ferry or shuttle-train crossings.' : ''
    ].filter(Boolean)
    if (notes.length) leg.note = notes.join(' ')
  } catch (e) {
    const code = e instanceof DistanceHttpError ? e.message : e instanceof Error ? e.message : String(e)
    leg.error = /2010|reachable|routable/i.test(code)
      ? `No lorry road within ${ACCESS_TERMINAL_RADIUS_M} m of ${leg.terminal} — pass the terminal's gate as "lat, lon" in a separate road lookup.`
      : code
  }
}
