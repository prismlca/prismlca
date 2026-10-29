/**
 * The distance ledger — its own file, its own shape, nothing to do with the AI usage ledger
 * (a separate cost table under Settings → Transport distances).
 *
 * Day-keyed, because the same numbers serve two readers: the cost table, and the daily caps that
 * keep a free openrouteservice plan from running dry by noon. Shape:
 *
 *   { "2026-09-05": { "ors": { "geocode": { calls, cost }, "route": { calls, cost } },
 *                     "mapbox": { "geocode": { calls, cost } } } }
 *
 * Writes go through one promise queue: the lookups run concurrently, and two interleaved
 * read-modify-write cycles on the same file would lose one of them.
 */
import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAPBOX_PERMANENT_USD_PER_1000, type GeocodeProvider } from '../../shared/distanceDefaults'

/** `autocomplete` is the panel's typeahead — same Pelias quota as `geocode`, booked apart so the cost
 *  table can show how much of the day's allowance went into typing rather than into lookups. */
export type DistanceEndpoint = 'geocode' | 'autocomplete' | 'route' | 'sea'
export type DistanceProvider = GeocodeProvider | 'searoute'

export interface CallBucket {
  calls: number
  cost: number
}
/** day → provider → endpoint → bucket */
export type DistanceUsageMap = Record<
  string,
  Partial<Record<DistanceProvider, Partial<Record<DistanceEndpoint, CallBucket>>>>
>

let _cache: DistanceUsageMap | null = null
let _queue: Promise<void> = Promise.resolve()

const file = (): string => join(app.getPath('userData'), 'distance-usage.json')

/** Today's key, in the machine's local calendar day — the quota resets when the user's day does. */
export function todayKey(d: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function migrate(parsed: unknown): DistanceUsageMap {
  if (!parsed || typeof parsed !== 'object') return {}
  const out: DistanceUsageMap = {}
  for (const [day, providers] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !providers || typeof providers !== 'object') continue
    const dayOut: DistanceUsageMap[string] = {}
    for (const [prov, endpoints] of Object.entries(providers as Record<string, unknown>)) {
      if (!endpoints || typeof endpoints !== 'object') continue
      const provOut: Partial<Record<DistanceEndpoint, CallBucket>> = {}
      for (const [ep, raw] of Object.entries(endpoints as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue
        const b = raw as Partial<CallBucket>
        provOut[ep as DistanceEndpoint] = {
          calls: Math.max(0, Number(b.calls) || 0),
          cost: Math.max(0, Number(b.cost) || 0)
        }
      }
      if (Object.keys(provOut).length) dayOut[prov as DistanceProvider] = provOut
    }
    out[day] = dayOut
  }
  return out
}

function load(): DistanceUsageMap {
  if (_cache) return _cache
  try {
    _cache = migrate(JSON.parse(readFileSync(file(), 'utf-8')))
  } catch {
    _cache = {}
  }
  return _cache
}

/** What one call costs, in USD, by the hand-maintained list (see distanceDefaults). */
export function costOf(provider: DistanceProvider, endpoint: DistanceEndpoint): number {
  if (provider === 'mapbox' && endpoint === 'geocode') return MAPBOX_PERMANENT_USD_PER_1000 / 1000
  return 0
}

/** Book `n` calls. Never throws, never loses a concurrent booking (serialised), never blocks a lookup. */
export function recordDistanceCalls(provider: DistanceProvider, endpoint: DistanceEndpoint, n = 1): void {
  if (n <= 0) return
  const data = load()
  const day = (data[todayKey()] ??= {})
  const prov = (day[provider] ??= {})
  const bucket = (prov[endpoint] ??= { calls: 0, cost: 0 })
  bucket.calls += n
  bucket.cost += n * costOf(provider, endpoint)
  _queue = _queue.then(() => {
    try {
      const tmp = `${file()}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf-8')
      renameSync(tmp, file())
    } catch {
      /* a failed ledger write must never break a lookup */
    }
  })
}

/** Wait for pending writes — tests, and the app's quit path. */
export function flushDistanceUsage(): Promise<void> {
  return _queue
}

export function getDistanceUsage(): DistanceUsageMap {
  return load()
}

/** Calls of one kind booked today, across providers — the figure the daily cap compares against. */
export function usedToday(endpoint: DistanceEndpoint): number {
  const day = load()[todayKey()] ?? {}
  let n = 0
  for (const prov of Object.values(day)) n += prov?.[endpoint]?.calls ?? 0
  return n
}

/** What the daily geocoding cap compares against: lookups AND typeahead, both draw on the same plan. */
export function usedGeocodingToday(): number {
  return usedToday('geocode') + usedToday('autocomplete')
}

/** Test seam. */
export function resetDistanceUsageCache(): void {
  _cache = null
}
