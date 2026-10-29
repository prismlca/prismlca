/**
 * The shapes of a distance lookup, shared by the assistant's tool and the Distances panel — both
 * call `computeDistances` and read the same result.
 */
import type { GeocodeProvider, SeaVia, TransportMode } from '../../shared/distanceDefaults'

export type { GeocodeProvider, SeaVia, TransportMode }

export interface PairInput {
  from: string
  to: string
  /** ISO-3166 alpha-2, biases the geocoder ("Cambridge" is in two countries). */
  from_country?: string
  to_country?: string
  /** Sea only: 'shortest' (default) or 'cape'. */
  via?: SeaVia
  /** Air / sea: the terminal a place end uses (code or name); default = the nearest major one. */
  from_terminal?: string
  to_terminal?: string
}

/** The road leg between a place and its airport or port — its own leg, never inside `km`. */
export interface AccessLeg {
  /** The terminal, as the catalogue labels it (with its code). */
  terminal: string
  code: string
  /** 'given' = named in the request; 'nearest' = the nearest major terminal by straight line. */
  chosen: 'given' | 'nearest'
  /** Straight-line distance place ↔ terminal, for the plausibility of 'nearest'. */
  straight_km: number
  km?: number
  raw_km?: number
  adjustment?: string | null
  crossings?: 'none' | 'present' | 'unresolved'
  crossing?: { km: number; note: string }
  note?: string
  error?: string
}

/** A geocoded place. `resolved` is the geocoder's own label, echoed so a wrong match is visible. */
export interface Place {
  text: string
  resolved: string
  lat: number
  lon: number
  country?: string
  /** The country the search was confined to, and where that came from: the caller's code, or the
   *  country named at the end of the text ("…, China") and resolved first (V405). Absent when the
   *  search ran unbound. */
  bound?: string
  bound_by?: 'given' | 'text'
  /** 'input' when the text was already a coordinate pair and no geocoder was asked; 'catalogue' when
   *  the bundled airport or port list answered (a code or a named terminal). */
  via: GeocodeProvider | 'input' | 'catalogue'
}

export interface SeaDetail {
  /** How far each input place sits from the network node the ship's km is measured from. Not added. */
  from_snap_km: number
  to_snap_km: number
  passages: string[]
  via: SeaVia
}

export interface PairResult {
  from: Place | { text: string }
  to: Place | { text: string }
  /** The figure to use: adjusted per the GLEC settings. */
  km?: number
  /** Before the adjustment (routed, sailed or great-circle). */
  raw_km?: number
  /** What was applied, or null when the mode's adjustment is switched off / does not exist. */
  adjustment?: string | null
  sea?: SeaDetail
  /** Air / sea: the road legs to the departure and from the arrival terminal (absent side = the place
   *  IS the terminal). `km` above is the flight or voyage only. */
  access?: { from?: AccessLeg; to?: AccessLeg }
  /** Road only: whether the route was checked for ferry / shuttle-train crossings, and what came out.
   *  'unresolved' means the check could not be made — never "no ferry". */
  crossings?: 'none' | 'present' | 'unresolved'
  /** Road only: the crossing, NOT in `km` — its own leg (ship or rail), to be checked. */
  crossing?: { km: number; note: string }
  note?: string
  error?: string
}

export interface QuotaState {
  turn_used: number
  turn_limit: number
  day_geocode_used: number
  day_geocode_limit: number
  day_route_used: number
  day_route_limit: number
}

export interface DistanceBatch {
  mode: TransportMode
  geocoder: GeocodeProvider
  results: PairResult[]
  attribution: string
  /** Why the access legs were not delivered although the setting asks for them (no road key). */
  access_note?: string
  /** What produced the figures, versioned — the provenance log keeps it beside every value. */
  method: string
  rail_caveat?: string
  quota: QuotaState
  /** Pairs not looked up because a cap was reached — named, never silently dropped. */
  skipped?: Array<{ from: string; to: string; reason: string }>
}

/** Counts the API calls of one assistant turn; the panel gets a fresh, unlimited one per lookup. */
export class TurnBudget {
  used = 0
  constructor(public readonly limit: number) {}
  get remaining(): number {
    return Math.max(0, this.limit - this.used)
  }
  take(n = 1): void {
    this.used += n
  }
  /** Hand back what a reservation did not use — see service.computeDistances. */
  release(n: number): void {
    this.used = Math.max(0, this.used - n)
  }
}
