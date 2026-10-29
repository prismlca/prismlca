/**
 * The `distances` tool: kilometres between places for a transport leg, all four modes in ONE tool.
 * The tool-count cap was raised for exactly this one.
 *
 * The work happens in main/distance (geocoding, routing, sailing, geodesy, GLEC, caps, ledger); it
 * is INJECTED as `ctx.distances`, like the research sub-agent, so this module stays import-free.
 * When the feature is off — per-chat toggle, app setting, or no key — the tool is not offered at all
 * (focus.ts) and the model is not told it exists; the guard below only catches a stale request.
 *
 * Attribution rides in two places by design: inside the result, where the model reads it, and as
 * `notice`, which the chat renders visibly on the tool-call row — openrouteservice and Mapbox both
 * require it, and a collapsed JSON preview is not "displayed".
 */
import type { Tool } from '../context'
import { obj, objArr, str } from '../schema'
import { S } from '../format'

interface Place {
  text: string
  resolved?: string
  lat?: number
  lon?: number
}
interface PairOut {
  from: Place
  to: Place
  km?: number
  raw_km?: number
  adjustment?: string | null
  sea?: { from_snap_km: number; to_snap_km: number; passages: string[]; via?: string }
  crossings?: 'none' | 'present' | 'unresolved'
  crossing?: { km: number; note: string }
  access?: { from?: AccessOut; to?: AccessOut }
  error?: string
}
interface AccessOut {
  code: string
  km?: number
  crossings?: 'none' | 'present' | 'unresolved'
  crossing?: { km: number }
  error?: string
}
interface Batch {
  mode: 'road' | 'sea' | 'air' | 'rail'
  geocoder: 'ors' | 'mapbox'
  results: PairOut[]
  attribution: string
  method?: string
  rail_caveat?: string
  skipped?: Array<{ from: string; to: string; reason: string }>
}

/** The routing attribution, as the access-leg findings carry it (this module stays import-free). */
const ATTRIBUTION_ROUTING_SHORT =
  'Routing © openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors'

const SOURCE_URL: Record<Batch['mode'], string> = {
  road: 'https://openrouteservice.org/',
  sea: 'https://github.com/genthalili/searoute-py',
  air: 'https://www.openstreetmap.org/copyright',
  rail: 'https://www.openstreetmap.org/copyright'
}

export const distancesTools: Tool[] = [
  {
    spec: {
      type: 'function',
      function: {
        name: 'distances',
        description:
          'Distance in kilometres between two places for a transport leg: mode="road" (routed, heavy goods vehicle), "sea" (sailed route over the shipping-lane network), "air" (great-circle) or "rail" (great-circle × a circuity factor — it says NOTHING about whether rail infrastructure exists; repeat that caveat when you use it). Pass up to 10 pairs in ONE call; a place is a name, an address or "lat, lon". In air mode an airport can be its IATA/ICAO code ("FRA", "EDDF"), in sea mode a port its UN/LOCODE ("DEHAM") or a name with "port"/"airport" in it ("Shanghai Pudong Airport") — these resolve from a local catalogue, no geocoding, and a terminal name several places share comes back as an error listing the codes; a plain city name is geocoded as a place, as in the other modes. Each result gives km (already adjusted per the GLEC conventions the user configured — this is the figure for the exchange), raw_km, the adjustment applied, and the resolved place name so you can see a wrong match; add a country code to a pair when a name is ambiguous. Air: one pair per flight leg — a trip with a stopover is two pairs. For sea, the default is the shortest route (usually Suez); pass via="cape" per pair for the routing around Africa and say in the process comment which the study assumes. Distances are ONE WAY. Air and sea run terminal to terminal: for a place that is not itself an airport/port, the result has "access" — the ROAD legs from the place to its airport/port and from the arrival terminal on, already measured, each with its own km, adjustment and ferry check (do not look them up again); km is the flight or voyage only, so book each access leg as a separate road transport. Without from_terminal / to_terminal the nearest major terminal by straight line is taken ("chosen": "nearest"); name the assumed terminal in your answer and the process comment. A far pick (straight_km in the hundreds) is only a guess. Decide yourself where you can: if one gateway is the usual one for this relation (a major hub that freight from the region typically uses), call again with it as from_terminal / to_terminal and state it as your assumption. Ask the user only when several terminals are about equally plausible and the choice would change the result noticeably. An access leg with "error" was NOT measured. A road result with "crossing" drove part of the way on a ferry or a vehicle shuttle train: that part is NOT in km — tell the user and model it as its own leg once they know which; "crossings": "unresolved" means the route could not be checked — say so. Put the adjustment and the resolved places into the process comment. A pair listed under "skipped" or carrying "error" was NOT measured: say so and ask, never fill a distance in yourself. When the user has already given a distance, use theirs and do not look it up.',
        parameters: obj(
          {
            mode: str('One of: road | sea | air | rail.'),
            pairs: objArr('The legs to measure, in order; at most 10 per call.', {
              from: str('Origin: place name, address, or "lat, lon".'),
              to: str('Destination: place name, address, or "lat, lon".'),
              from_country: str('Optional ISO-3166 alpha-2 code to disambiguate the origin, e.g. "DE".'),
              to_country: str('Optional ISO-3166 alpha-2 code to disambiguate the destination.'),
              from_terminal: str(
                'Air/sea only, optional: the airport or port the origin uses, as a code ("FRA", "DEHAM") or name. Default: the nearest major one.'
              ),
              to_terminal: str(
                'Air/sea only, optional: the airport or port the destination uses. Default: the nearest major one.'
              ),
              via: str(
                'Sea only: "shortest" (default — the network\'s shortest route, usually via Suez) or "cape" for the routing around the Cape of Good Hope that much Asia–Europe traffic has used since late 2023 (Suez and Panama avoided). Which one the study assumes is a decision to record.'
              )
            })
          },
          ['mode', 'pairs']
        )
      }
    },
    run: async (a, ctx) => {
      if (ctx.distancesAvailable === false || !ctx.distances)
        return S({ error: 'Distances are not available in this chat.' })
      let batch: Batch
      try {
        batch = (await ctx.distances(a.mode, a.pairs)) as Batch
      } catch (e) {
        return S({ error: e instanceof Error ? e.message : String(e) })
      }
      // Same provenance log the web research writes: a routed distance is exactly the kind of
      // figure a report has to attribute, and the attribution outlives the chat only here.
      // Best-effort — never at the result's expense.
      const db = ctx.activeDb
      const measured = batch.results.filter((r) => typeof r.km === 'number')
      if (db && measured.length) {
        const label = { road: 'Road', sea: 'Sea', air: 'Air', rail: 'Rail' }[batch.mode]
        const entries = measured.map((r) => ({
          question: `${label} distance ${r.from.resolved ?? r.from.text} → ${r.to.resolved ?? r.to.text}`,
          findings: [
            {
              text:
                `${r.km} km${r.adjustment ? ` (${r.adjustment})` : ''}` +
                (r.sea
                  ? `; node to node${r.sea.via === 'cape' ? ', routed around the Cape of Good Hope' : ''}, snap ${r.sea.from_snap_km} / ${r.sea.to_snap_km} km${r.sea.passages.length ? `, via ${r.sea.passages.join(', ')}` : ''}`
                  : '') +
                (r.crossing ? `; plus ${r.crossing.km} km on a ferry or shuttle train, not in km` : '') +
                (r.crossings === 'unresolved' ? '; ferry/shuttle check not possible' : '') +
                (r.access ? '; road access legs apart, see below' : '') +
                // The short tag only ("road v2026-09-29"): the log keeps 400 characters of a finding,
                // and the attribution must not be the part that is cut.
                (batch.method ? `. Method ${batch.method.split(':')[0]}` : '') +
                `. ${batch.attribution}`,
              sources: [SOURCE_URL[batch.mode]],
              source_class: 'official',
              confidence:
                batch.mode === 'rail'
                  ? 'low'
                  : r.crossing || r.crossings === 'unresolved'
                    ? 'medium'
                    : 'high',
              ...(r.crossing
                ? { confidence_note: 'part of the route is a ferry or shuttle-train crossing' }
                : r.crossings === 'unresolved'
                  ? { confidence_note: 'route not checked for ferry or shuttle-train crossings' }
                  : {})
            },
            // Each access leg is a finding of its own: its own figure, crossing and confidence — and
            // its own 400 characters, so neither it nor the attribution is the part that gets cut.
            ...(['from', 'to'] as const).flatMap((side) => {
              const l = r.access?.[side]
              if (!l) return []
              const route =
                side === 'from'
                  ? `${r.from.resolved ?? r.from.text} → ${l.code}`
                  : `${l.code} → ${r.to.resolved ?? r.to.text}`
              const doubt = l.crossing || l.crossings === 'unresolved' || typeof l.km !== 'number'
              return [
                {
                  text:
                    `Road access ${route}: ${typeof l.km === 'number' ? `${l.km} km` : `not measured (${l.error ?? 'no answer'})`}` +
                    (l.crossing ? `, plus ${l.crossing.km} km on a ferry or shuttle train, not in km` : '') +
                    (l.crossings === 'unresolved' ? ', ferry/shuttle check not possible' : '') +
                    `; not in the ${batch.mode === 'air' ? 'flight' : 'voyage'}'s km. ${ATTRIBUTION_ROUTING_SHORT}`,
                  sources: [SOURCE_URL.road],
                  source_class: 'official',
                  confidence: doubt ? 'medium' : 'high',
                  ...(l.crossing
                    ? { confidence_note: 'part of the access leg is a ferry or shuttle-train crossing' }
                    : l.crossings === 'unresolved'
                      ? { confidence_note: 'access leg not checked for ferry or shuttle-train crossings' }
                      : typeof l.km !== 'number'
                        ? { confidence_note: 'access leg not measured' }
                        : {})
                }
              ]
            })
          ]
        }))
        try {
          await ctx.api('POST', '/api/v1/provenance/research', { database: db, entries })
        } catch {
          /* logged provenance is a bonus, not a dependency */
        }
      }
      return { result: S(batch), notice: batch.attribution }
    }
  }
]
