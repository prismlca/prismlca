/**
 * The GLEC adjustments, as pure arithmetic over the raw figure. Each mode's switch lives in the
 * transport settings (default on); the sentences say what was applied so the model can copy them
 * into a process note and the panel can print them.
 */
import {
  GLEC_AIR_ADD_KM,
  GLEC_ROAD_FACTOR,
  GLEC_SEA_FACTOR,
  type TransportMode,
  type TransportSettings
} from '../../shared/distanceDefaults'

export interface Adjusted {
  km: number
  raw_km: number
  adjustment: string | null
}

const round1 = (n: number): number => Math.round(n * 10) / 10

/**
 * `crossingKm` (road only): the part of the route on a ferry or a vehicle shuttle train. It is not
 * road, so it is taken OUT of `km` — the figure for the lorry exchange — and gets no road factor;
 * the caller reports it separately as its own leg. `raw_km` stays the whole routed distance.
 */
export function adjust(mode: TransportMode, rawKm: number, s: TransportSettings, crossingKm = 0): Adjusted {
  const raw_km = round1(rawKm)
  switch (mode) {
    case 'road': {
      const crossing = Math.min(Math.max(0, crossingKm), rawKm)
      const roadPart = rawKm - crossing
      const minus = crossing > 0 ? ` (routed ${raw_km} km − ${round1(crossing)} km crossing)` : ''
      if (!s.glec.road)
        return {
          km: round1(roadPart),
          raw_km,
          adjustment: crossing > 0 ? `road part only${minus}, no adjustment` : null
        }
      return {
        km: round1(roadPart * GLEC_ROAD_FACTOR),
        raw_km,
        adjustment: `${crossing > 0 ? `road part${minus}` : 'routed distance'} × ${GLEC_ROAD_FACTOR} (GLEC v3.2 / ISO 14083: +5 % planned → actual)`
      }
    }
    case 'air':
      return s.glec.air
        ? {
            km: round1(rawKm + GLEC_AIR_ADD_KM),
            raw_km,
            adjustment: `great-circle distance + ${GLEC_AIR_ADD_KM} km for this flight leg (GLEC v3.2 / EN 16258)`
          }
        : { km: raw_km, raw_km, adjustment: null }
    case 'rail': {
      // The factor IS the method here: with the switch off the estimate is the bare great-circle
      // distance, which the sentence says in so many words rather than pretending to a route.
      const factor = s.glec.rail ? s.railFactor : 1
      return {
        km: round1(rawKm * factor),
        raw_km,
        adjustment: s.glec.rail
          ? `great-circle distance × ${s.railFactor} (European freight-corridor circuity)`
          : 'great-circle distance, no circuity factor (switched off in Settings)'
      }
    }
    case 'sea':
      return s.glec.sea && rawKm > 0
        ? {
            km: round1(rawKm * GLEC_SEA_FACTOR),
            raw_km,
            adjustment: `sailed distance × ${GLEC_SEA_FACTOR} (GLEC v3.2, Clean Cargo default: actual routes average 15 % longer than the shortest feasible one)`
          }
        : { km: raw_km, raw_km, adjustment: null }
  }
}
