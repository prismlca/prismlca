/** Thin wrappers over the distance bridge (preload `distance:*`), typed for the views. */
import type { GeocodeProvider, SeaVia, TransportMode } from '../../../shared/distanceDefaults'
import type { KeyStatus } from '../../../shared/ipc'

export type { GeocodeProvider, SeaVia, TransportMode }

export interface DistancePlace {
  text: string
  resolved?: string
  lat?: number
  lon?: number
  country?: string
  via?: GeocodeProvider | 'input' | 'catalogue'
}

export interface DistancePairResult {
  from: DistancePlace
  to: DistancePlace
  km?: number
  raw_km?: number
  adjustment?: string | null
  sea?: { from_snap_km: number; to_snap_km: number; passages: string[]; via?: SeaVia }
  crossings?: 'none' | 'present' | 'unresolved'
  crossing?: { km: number; note: string }
  access?: { from?: DistanceAccessLeg; to?: DistanceAccessLeg }
  note?: string
  error?: string
}

export interface DistanceAccessLeg {
  terminal: string
  code: string
  chosen: 'given' | 'nearest'
  straight_km: number
  km?: number
  raw_km?: number
  adjustment?: string | null
  crossings?: 'none' | 'present' | 'unresolved'
  crossing?: { km: number; note: string }
  note?: string
  error?: string
}

export interface DistanceBatch {
  mode: TransportMode
  geocoder: GeocodeProvider
  results: DistancePairResult[]
  attribution: string
  method?: string
  access_note?: string
  rail_caveat?: string
  quota: {
    turn_used: number
    turn_limit: number
    day_geocode_used: number
    day_geocode_limit: number
    day_route_used: number
    day_route_limit: number
  }
  skipped?: Array<{ from: string; to: string; reason: string }>
}

export interface DistanceAvailability {
  ors: boolean
  mapbox: boolean
  geocoder: GeocodeProvider | null
  available: boolean
}

/** day → provider → endpoint → { calls, cost } (see main/distance/usage.ts). */
export type DistanceUsage = Record<string, Record<string, Record<string, { calls: number; cost: number }>>>

export const distanceKeyStatus = (p: GeocodeProvider): Promise<KeyStatus> =>
  window.prism.distance.keyStatus(p)
export const distanceSetKey = (key: string, p: GeocodeProvider): Promise<{ ok: boolean; error?: string }> =>
  window.prism.distance.setKey(key, p)
export const distanceClearKey = (p: GeocodeProvider): Promise<{ ok: boolean }> =>
  window.prism.distance.clearKey(p)
export const distanceAvailability = (): Promise<DistanceAvailability> => window.prism.distance.availability()
export const distanceCompute = (req: {
  mode: TransportMode
  from: string
  to: string
  fromCountry?: string
  toCountry?: string
  via?: SeaVia
}): Promise<DistanceBatch> => window.prism.distance.compute(req) as Promise<DistanceBatch>
export const distanceCancel = (): Promise<{ ok: boolean }> => window.prism.distance.cancel()
export const distanceUsage = (): Promise<DistanceUsage> =>
  window.prism.distance.usage() as Promise<DistanceUsage>

export interface PlaceSuggestion {
  label: string
  lat: number
  lon: number
  country?: string
}
export const distanceSuggest = (
  text: string,
  opts: { country?: string; kind?: 'airport' | 'port'; majorOnly?: boolean } = {}
): Promise<PlaceSuggestion[]> =>
  window.prism.distance.suggest({
    text,
    ...(opts.country ? { country: opts.country } : {}),
    ...(opts.kind ? { kind: opts.kind, majorOnly: opts.majorOnly === true } : {})
  })
