/**
 * The transport-distance surface: the two keys (openrouteservice, Mapbox), one lookup for the
 * panel, the availability the renderer gates on, and the ledger for the cost table.
 *
 * Its own namespace rather than a widening of `ai:*` — `ipc/keys.ts` pushes every key it stores
 * to the backend and resets the chat client, and both would be wrong here: the backend never sees
 * a geocoding key (it only does sea geometry), and the assistant does not care which geocoder runs.
 */
import { ipcMain } from 'electron'

import {
  computeDistances,
  distancesAvailable,
  effectiveGeocoder,
  type DistanceKeys
} from '../distance/service'
import { suggest } from '../distance/geocode'
import { getDistanceUsage, recordDistanceCalls, usedGeocodingToday } from '../distance/usage'
import { clearSecret, resolve, setSecret, status as secretStatus } from '../secrets'
import { getSettings } from '../settings'

export interface DistanceIpcDeps {
  apiRequest: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>
}

type DistanceProvider = 'ors' | 'mapbox'

/** Anything but the two known slots is refused, never mapped onto another key. */
const asProvider = (p: unknown): DistanceProvider => {
  if (p === 'ors' || p === 'mapbox') return p
  throw new Error(`Unknown distance provider "${String(p)}".`)
}

/** The keys as the service wants them — resolved through the one resolution order (env, store, dev file). */
export function distanceKeys(): DistanceKeys {
  return { ors: resolve('ors').key, mapbox: resolve('mapbox').key }
}

/** The lookup a window has running, by its webContents id — the panel runs one at a time, and a
 *  Stop click can only mean that one. A new lookup from the same window replaces (and stops) the old. */
const inFlight = new Map<number, AbortController>()
const senderId = (e: unknown): number => (e as { sender?: { id?: number } } | null)?.sender?.id ?? 0

export function registerDistanceIpc(deps: DistanceIpcDeps): void {
  ipcMain.handle('distance:keyStatus', (_e, provider: unknown) => secretStatus(asProvider(provider)))

  ipcMain.handle('distance:setKey', (_e, key: unknown, provider: unknown) => {
    const p = asProvider(provider)
    try {
      setSecret(p, typeof key === 'string' ? key : '')
      return { ok: true, status: secretStatus(p) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('distance:clearKey', (_e, provider: unknown) => {
    const p = asProvider(provider)
    clearSecret(p)
    return { ok: true, status: secretStatus(p) }
  })

  ipcMain.handle('distance:availability', () => {
    const keys = distanceKeys()
    const settings = getSettings().transport
    return {
      ors: !!keys.ors,
      mapbox: !!keys.mapbox,
      geocoder: effectiveGeocoder(settings, keys),
      available: distancesAvailable(settings, keys)
    }
  })

  // The panel's lookup: one pair, no per-turn budget (that cap is the assistant's). The daily caps
  // still apply — they protect the free plan, whoever is asking.
  ipcMain.handle(
    'distance:compute',
    async (
      e,
      req: {
        mode?: unknown
        from?: unknown
        to?: unknown
        fromCountry?: unknown
        toCountry?: unknown
        via?: unknown
      }
    ) => {
      const settings = getSettings().transport
      const id = senderId(e)
      inFlight.get(id)?.abort()
      const ctrl = new AbortController()
      inFlight.set(id, ctrl)
      try {
        return await computeDistances(
          req?.mode,
          [
            {
              from: String(req?.from ?? ''),
              to: String(req?.to ?? ''),
              ...(typeof req?.fromCountry === 'string' ? { from_country: req.fromCountry } : {}),
              ...(typeof req?.toCountry === 'string' ? { to_country: req.toCountry } : {}),
              ...(req?.via === 'cape' ? { via: 'cape' as const } : {})
            }
          ],
          { settings, keys: distanceKeys(), backend: deps.apiRequest, signal: ctrl.signal }
        )
      } finally {
        if (inFlight.get(id) === ctrl) inFlight.delete(id)
      }
    }
  )

  // The panel's Stop button: aborts the requests of this window's running lookup (the service then
  // answers "Stopped." for what was still open — the panel discards that answer). No lookup running
  // is not an error; it says so and nothing happens.
  ipcMain.handle('distance:cancel', (e) => {
    const ctrl = inFlight.get(senderId(e))
    if (!ctrl) return { ok: false }
    ctrl.abort()
    return { ok: true }
  })

  // Typeahead for the panel: openrouteservice only, within the day's geocoding allowance, and never
  // an error — an empty list is the whole failure mode. Booked as `autocomplete` so the cost table can
  // say how much of the allowance typing took.
  ipcMain.handle(
    'distance:suggest',
    async (_e, req: { text?: unknown; country?: unknown; kind?: unknown; majorOnly?: unknown }) => {
      // Air and sea: the bundled catalogue answers — local, free, no key and no allowance spent.
      if (req?.kind === 'airport' || req?.kind === 'port') {
        const q = String(req?.text ?? '')
          .trim()
          .slice(0, 200)
        if (q.length < 2) return []
        try {
          const qs = new URLSearchParams({
            kind: req.kind,
            q,
            major_only: req.majorOnly === true ? 'true' : 'false'
          })
          const res = await deps.apiRequest('GET', `/api/v1/distances/places/suggest?${qs.toString()}`)
          const items = (
            res.body as { items?: Array<{ label: string; lat: number; lon: number; country: string }> }
          )?.items
          return res.status === 200 && Array.isArray(items)
            ? items.map((t) => ({ label: t.label, lat: t.lat, lon: t.lon, country: t.country }))
            : []
        } catch {
          return []
        }
      }
      const settings = getSettings().transport
      const keys = distanceKeys()
      if (effectiveGeocoder(settings, keys) !== 'ors' || !keys.ors) return []
      const cap = settings.dailyCalls.geocode
      if (cap > 0 && usedGeocodingToday() >= cap) return []
      return suggest(
        String(req?.text ?? ''),
        keys.ors,
        typeof req?.country === 'string' ? req.country : undefined,
        {
          onCall: () => recordDistanceCalls('ors', 'autocomplete', 1)
        }
      )
    }
  )

  ipcMain.handle('distance:usage', () => getDistanceUsage())
}
