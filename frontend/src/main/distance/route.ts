/**
 * Road distance from openrouteservice Directions v2, profile `driving-hgv` — freight, not a car.
 * One request per pair: the quota is per request either way, and a Directions call is what the
 * free plan gives the most of. `api.heigit.org` from the start; the old host goes dark 28.09.2026.
 */
import { ORS_FREE_PLAN } from '../../shared/distanceDefaults'
import { DistanceHttpError, fetchJson, RateGate, type FetchJsonOpts } from './http'
import type { Place } from './types'

export const ORS_DIRECTIONS_URL = 'https://api.heigit.org/openrouteservice/v2/directions/driving-hgv'

export const routeGate = new RateGate(ORS_FREE_PLAN.routePerMinute, 4)

/** ORS error codes that mean "these two places are not connected by road" rather than "we failed". */
const NO_ROUTE_CODES = new Set([2009, 2099])

/**
 * openrouteservice answers an exhausted DAILY quota with HTTP 403 "Daily quota reached or API key
 * unauthorized" — the same status as a bad key — and the per-minute limit with 429. The minute limit
 * is worth one retry (fetchJson does it); the day's quota is not, and "rejected the key" sent users
 * hunting for a key problem they did not have. Shared with the geocoder.
 */
export const ORS_QUOTA_SENTENCE =
  "openrouteservice refused the request (HTTP 403): today's quota is used up, or the key is not valid. The free plan resets daily; the day's calls are counted under Settings → Transport distances."

export function describeOrsAuth(status: number): string | undefined {
  if (status === 401) return 'openrouteservice rejected the key (HTTP 401).'
  if (status === 403) return ORS_QUOTA_SENTENCE
  if (status === 429)
    return 'openrouteservice per-minute rate limit reached (HTTP 429). Try again in a minute.'
  return undefined
}

function describeOrs(status: number, body: unknown): string | undefined {
  const err = (body as { error?: { code?: number; message?: string } } | null)?.error
  const auth = describeOrsAuth(status)
  if (auth) return auth
  if (err?.code && NO_ROUTE_CODES.has(err.code))
    return 'No road route between these places — split the leg into road, sea and road legs.'
  // 2010 = no HGV-routable road within the snapping radius of a point. Should not happen with the
  // unlimited radius sent below; if it does, the place is the problem, not the pair.
  if (err?.code === 2010)
    return 'No road reachable for a heavy goods vehicle near one of the resolved points — give a street address or a nearby town.'
  if (err?.code === 2004) return 'Too far for one road request (openrouteservice limits a route to 6 000 km).'
  return err?.message ? `openrouteservice: ${err.message}` : undefined
}

/** waycategory bit 8 = "ferry" in openrouteservice — which covers ferries AND vehicle shuttle trains
 *  (Channel Tunnel, Sylt), also combined with other bits (10 = ferry + toll). It cannot tell the two
 *  apart, so neither do we: the sentence names both. */
const WAYCATEGORY_FERRY = 8

/**
 * 'none' — the waycategory summary is there, adds up, and has no ferry bit;
 * 'present' — it has, `crossingKm` says how much;
 * 'unresolved' — missing or not adding up. Never read as "no ferry": the caller says so.
 */
export type CrossingCheck = 'none' | 'present' | 'unresolved'

export interface RoadRoute {
  km: number
  crossingKm: number
  crossings: CrossingCheck
  remaining?: number
}

interface WaySummary {
  value?: number
  distance?: number
}

/** Read the crossing out of the waycategory summary, checked against the route's total (1 m or 0.1 %). */
export function crossingFrom(
  totalM: number,
  summary: unknown
): { crossingKm: number; crossings: CrossingCheck } {
  if (!Array.isArray(summary) || summary.length === 0) return { crossingKm: 0, crossings: 'unresolved' }
  let sum = 0
  let ferry = 0
  for (const item of summary as WaySummary[]) {
    const v = item?.value
    const d = item?.distance
    if (typeof v !== 'number' || typeof d !== 'number' || !Number.isFinite(d) || d < 0)
      return { crossingKm: 0, crossings: 'unresolved' }
    sum += d
    if ((Math.round(v) & WAYCATEGORY_FERRY) !== 0) ferry += d
  }
  if (Math.abs(sum - totalM) > Math.max(1, totalM * 0.001)) return { crossingKm: 0, crossings: 'unresolved' }
  return ferry > 0 ? { crossingKm: ferry / 1000, crossings: 'present' } : { crossingKm: 0, crossings: 'none' }
}

export interface RouteDeps {
  fetchOpts?: FetchJsonOpts
  /** Once per request that goes out, retries included. */
  onCall?: () => void
  signal?: AbortSignal
  /** Asked once the gate admits the call: true = the day's quota is known to be gone, send nothing. */
  refused?: () => boolean
  /** Snapping radius per end in metres; default -1/-1 (unlimited, see below). An access leg bounds
   *  its terminal end (ACCESS_TERMINAL_RADIUS_M). */
  radiuses?: [number, number]
  /** Told of a 403 INSIDE the gate, before its slot is handed on — set later, in the caller's catch,
   *  the flag came too late for the call the freed slot admitted next. */
  onRefused?: () => void
}

/** Routed road distance in km, the part of it on a ferry or shuttle train, and what the service says
 *  is left of the DAY's allowance (x-ratelimit-remaining counts the daily quota, checked 29.09.2026). */
export async function roadKm(from: Place, to: Place, key: string, deps: RouteDeps = {}): Promise<RoadRoute> {
  return routeGate.run(async () => {
    // Checked HERE, after the wait in the gate, not before it: a ten-pair batch queues all ten at
    // once, and a check before the queue would let every one of them through.
    if (deps.refused?.()) throw new DistanceHttpError(ORS_QUOTA_SENTENCE, 403)
    const { data, headers } = await fetchJson<{
      routes?: Array<{
        summary?: { distance?: number }
        extras?: { waycategory?: { summary?: unknown } }
      }>
    }>(
      ORS_DIRECTIONS_URL,
      {
        method: 'POST',
        headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          coordinates: [
            [from.lon, from.lat],
            [to.lon, to.lat]
          ],
          // A geocoded city is its centre, and a centre is a pedestrian zone more often than not:
          // with the default 350 m snapping radius the HGV profile answered "Could not find routable
          // point" for Salzgitter, Hanover and Frankfurt alike.
          // -1 = unlimited radius: snap to the nearest road a lorry may use, however far.
          radiuses: deps.radiuses ?? [-1, -1],
          instructions: false,
          geometry: false,
          // The summary per waycategory comes without geometry: distance per bit combination, in m.
          extra_info: ['waycategory']
        })
      },
      { ...deps.fetchOpts, describeError: describeOrs, onAttempt: () => deps.onCall?.(), signal: deps.signal }
    ).catch((e: unknown) => {
      if (e instanceof DistanceHttpError && e.status === 403) deps.onRefused?.()
      throw e
    })
    const route = data?.routes?.[0]
    const metres = route?.summary?.distance
    if (typeof metres !== 'number' || !Number.isFinite(metres) || metres < 0)
      throw new DistanceHttpError('openrouteservice returned no route.', 502)
    const rem = Number(headers.get('x-ratelimit-remaining'))
    return {
      km: metres / 1000,
      ...crossingFrom(metres, route?.extras?.waycategory?.summary),
      ...(Number.isFinite(rem) ? { remaining: rem } : {})
    }
  })
}
