/**
 * What the Distances panel shows for one looked-up pair, sorted into three tiers (on a flight the three
 * figures stood between seven paragraphs, and a hint addressed to the assistant — "name it with
 * from_terminal / to_terminal" — sat in the panel twice).
 *
 *   legs      one row per leg to enter: road to the terminal, the flight or voyage, road from it.
 *             Under a row, only what changes what its number means (not in the figure, not measured).
 *   hints     a line each, visible: what to do with several legs, a terminal picked by distance alone.
 *   notices   visible and amber: the batch-level caveats (no road key for the access legs, rail).
 *   details   collapsed: how each figure was made — adjustments, routed vs. adjusted, sea passages.
 *
 * The attribution is not here on purpose: the panel prints `result.attribution` unchanged under every
 * result, because the providers' terms require it where their results are shown.
 */
import { SEA_GAP_WARN_KM, type TransportMode } from '../../../shared/distanceDefaults'
import type { DistanceAccessLeg, DistanceBatch, DistancePairResult } from './distance'

/** The number as it goes into a field: one decimal at most, a dot, no unit. */
export const kmText = (km: number): string => (Math.round(km * 10) / 10).toString()

export interface LegView {
  key: 'from' | 'main' | 'to'
  mode: TransportMode
  /** What the leg is — "Road to the airport", "Flight". */
  label: string
  /** Where it runs, short; `title` carries the full names where the path abbreviates them. */
  path: string
  title?: string
  km: number | null
  /** Why there is no number, when there is none. */
  error?: string
  warnings: string[]
}

export interface ResultView {
  legs: LegView[]
  hints: string[]
  notices: string[]
  details: string[]
}

const MAIN_LABEL: Record<TransportMode, string> = { road: 'Road', sea: 'Voyage', air: 'Flight', rail: 'Rail' }
/** The service's note on a terminal picked by straight-line distance, written for the assistant. */
const NEAREST_NOTE = /^Nearest major terminal/

const placeName = (p: { text: string; resolved?: string }): string => p.resolved || p.text

function accessLeg(
  side: 'from' | 'to',
  leg: DistanceAccessLeg,
  pair: DistancePairResult,
  terminalWord: string
): { view: LegView; details: string[] } {
  const label = side === 'from' ? `Road to the ${terminalWord}` : `Road from the ${terminalWord}`
  const path =
    side === 'from' ? `${placeName(pair.from)} → ${leg.code}` : `${leg.code} → ${placeName(pair.to)}`
  const warnings: string[] = []
  if (leg.crossing)
    warnings.push(
      `Plus ${kmText(leg.crossing.km)} km on a ferry or a vehicle shuttle train, not in this leg.`
    )
  else if (leg.crossings === 'unresolved') warnings.push('Not checked for ferry or shuttle-train crossings.')
  const details: string[] = []
  if (typeof leg.km === 'number' && leg.adjustment)
    details.push(`${label}: ${kmText(leg.raw_km ?? leg.km)} km before adjustment — ${leg.adjustment}.`)
  if (leg.note && !NEAREST_NOTE.test(leg.note)) details.push(`${label}: ${leg.note}`)
  return {
    view: {
      key: side,
      mode: 'road',
      label,
      path,
      title: leg.terminal,
      km: typeof leg.km === 'number' ? leg.km : null,
      ...(typeof leg.km === 'number' ? {} : { error: leg.error ?? 'not measured' }),
      warnings
    },
    details
  }
}

export function resultView(mode: TransportMode, pair: DistancePairResult, batch: DistanceBatch): ResultView {
  const terminalWord = mode === 'air' ? 'airport' : 'port'
  const access = pair.access
  const legs: LegView[] = []
  const hints: string[] = []
  const details: string[] = []

  // The main leg, between the terminals when there are access legs, else between the places.
  const mainFrom = access?.from?.terminal ?? placeName(pair.from)
  const mainTo = access?.to?.terminal ?? placeName(pair.to)
  const warnings: string[] = []
  if (pair.crossing)
    warnings.push(
      `Plus ${kmText(pair.crossing.km)} km on a ferry or a vehicle shuttle train, not in the figure — ` +
        'openrouteservice cannot tell which. Check the route and enter it as its own sea or rail leg.'
    )
  else if (pair.crossings === 'unresolved') warnings.push('Not checked for ferry or shuttle-train crossings.')
  if (pair.sea) {
    const gap = Math.max(pair.sea.from_snap_km, pair.sea.to_snap_km)
    const snaps = access
      ? `The ports lie ${kmText(pair.sea.from_snap_km)} km and ${kmText(pair.sea.to_snap_km)} km from the shipping-lane network — not sailed, not included.`
      : `Not included: ${kmText(pair.sea.from_snap_km)} km from the origin to its sea node (port) and ${kmText(pair.sea.to_snap_km)} km from the destination’s sea node (port) — those are separate road or rail legs.`
    // Far from the network, or no road legs that would cover it: that changes what the figure means.
    if (!access || gap >= SEA_GAP_WARN_KM) warnings.push(snaps)
    else details.push(snaps)
    if (pair.sea.via === 'cape') details.push('Routed around the Cape of Good Hope.')
    if (pair.sea.passages.length) details.push(`Via ${pair.sea.passages.join(', ')}.`)
  }
  const main: LegView = {
    key: 'main',
    mode,
    label: MAIN_LABEL[mode],
    path: `${mainFrom} → ${mainTo}`,
    km: typeof pair.km === 'number' ? pair.km : null,
    ...(typeof pair.km === 'number' ? {} : { error: pair.error ?? 'No result.' }),
    warnings
  }
  if (typeof pair.km === 'number')
    details.unshift(
      pair.adjustment
        ? `${main.label}: ${kmText(pair.raw_km ?? pair.km)} km before adjustment — ${pair.adjustment}.`
        : mode === 'sea'
          ? `${main.label}: sailed distance, sea node (port) to sea node (port).`
          : `${main.label}: no adjustment applied.`
    )

  const before = access?.from ? accessLeg('from', access.from, pair, terminalWord) : null
  const after = access?.to ? accessLeg('to', access.to, pair, terminalWord) : null
  if (before) legs.push(before.view)
  legs.push(main)
  if (after) legs.push(after.view)
  details.push(...(before?.details ?? []), ...(after?.details ?? []))

  // Legs that carry kilometres: a road leg set to 0 (the place is at the terminal) is no transport.
  const moving = legs.filter((l) => l.km !== 0).length
  if (moving > 1)
    hints.push(
      `${moving === 3 ? 'Three' : 'Two'} separate legs — enter each as its own transport in the model.`
    )
  if (access?.from?.chosen === 'nearest' || access?.to?.chosen === 'nearest')
    hints.push(
      `The ${terminalWord}s are the nearest major ones by straight line. If the freight uses another, look up the ` +
        `${mode === 'air' ? 'flight' : 'voyage'} from that ${terminalWord} (name or code) and the road leg to it separately.`
    )
  if (pair.note && !pair.sea) hints.push(pair.note)

  const notices = [batch.access_note, batch.rail_caveat].filter((n): n is string => !!n)
  return { legs, hints, notices, details }
}
