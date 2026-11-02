/**
 * The arithmetic and wording of the Sensitivity analysis tab, kept out of the components so it can be
 * tested: what a bar says, which curve values a rule allows, and when a stored run no longer describes the
 * model.
 */
import { fmtSig } from '../../lib/settings'
import type { ParamRule, SensInput, StoredRun, TornadoEntry, TornadoResult } from './types'

/** How many bars the tornado shows before "+ N more". */
export const TOP = 10
/** The range presets of the tornado; anything else is typed. */
export const DELTA_PRESETS = [0.1, 0.25, 0.5]
/** Points of a new curve, and the most it may have (each one costs a solve per variant). */
export const DEFAULT_POINTS = 11
export const MAX_POINTS = 50

/** Change of `v` against `base` in percent; 0 when there is no base to compare with. */
export function pctOf(v: number, base: number): number {
  return base ? ((v - base) / Math.abs(base)) * 100 : 0
}

/** "+11.1 %", "−9.1 %", "0 %": one decimal from 1 % up, two below, a real minus sign. */
export function signedPct(p: number): string {
  if (!p) return '0 %'
  const a = Math.abs(p)
  return `${p > 0 ? '+' : '−'}${a.toFixed(a < 1 ? 2 : 1)} %`
}

/** A parameter or score value as the page prints it: four significant figures, no trailing zeros. */
export function fmtValue(v: number): string {
  return fmtSig(v, 4)
}

/** How far the result moves between the two sides of one bar, for indicator `mi`. */
export function swing(e: TornadoEntry, mi: number, baseline: number): number {
  // The stretch the two bars cover from the result, not the distance between their ends: both steps raising
  // the result by 10 % is a parameter that moves it, though its ends are the same (engine/sensitivity.span).
  const points = [e.low[mi] ?? baseline, e.high[mi] ?? baseline, baseline]
  return Math.max(...points) - Math.min(...points)
}

/** The entries in the order the chart shows them for indicator `mi`: largest swing first. */
export function sortedEntries(r: TornadoResult, mi: number): TornadoEntry[] {
  return [...r.entries].sort((a, b) => swing(b, mi, r.baseline[mi]) - swing(a, mi, r.baseline[mi]))
}

/** A range as the page writes it: "10", "2.5" — never rounded to a whole percent, which turned a 0.4 % step
 *  into "+0 %". */
export function pctLabel(delta: number): string {
  return String(+(delta * 100).toPrecision(3))
}

/** How far one side really moved the parameter, in percent of its starting value. */
export function stepPct(e: TornadoEntry, side: 'low' | 'high'): number {
  return pctOf(side === 'low' ? e.low_value : e.high_value, e.base)
}

/** The footnote of a bar whose rule cut it short: "share +5.3 % (to 1, between 0 and 1)". A list rule has
 *  no percentage to fall short of, so it names the neighbouring values instead. */
export function limitedNote(e: TornadoEntry): string {
  const lim = e.limited ?? {}
  const rule = lim.low ?? lim.high ?? ''
  if (lim.low && lim.high && rule.startsWith('one of')) {
    return `${e.param}: the next allowed values ${fmtValue(e.low_value)} and ${fmtValue(e.high_value)} (${rule})`
  }
  const sides = (['low', 'high'] as const)
    .filter((s) => lim[s])
    .map((s) => `${signedPct(stepPct(e, s))} (to ${fmtValue(s === 'low' ? e.low_value : e.high_value)})`)
  return `${e.param} ${sides.join(' and ')}, ${rule}`
}

/** Why `v` breaks `rule`, or null — the same test the backend applies (engine/param_rules.py). */
export function violates(rule: ParamRule | undefined, v: number): string | null {
  const eps = 1e-9
  switch (rule?.kind) {
    case 'positive':
      return v > 0 ? null : 'must be greater than 0'
    case 'negative':
      return v < 0 ? null : 'must be less than 0'
    case 'range':
      if (rule.min != null && v < rule.min - eps) return `must be at least ${fmtValue(rule.min)}`
      if (rule.max != null && v > rule.max + eps) return `must be at most ${fmtValue(rule.max)}`
      return null
    case 'list':
      return (rule.values ?? []).some((a) => Math.abs(v - a) <= eps * Math.max(1, Math.abs(a)))
        ? null
        : `must be one of ${(rule.values ?? []).map(fmtValue).join(', ')}`
    default:
      return null
  }
}

/** `points` evenly spaced values from `from` to `to`, both ends included, without float dust. */
export function linspace(from: number, to: number, points: number): number[] {
  const n = Math.max(2, Math.round(points))
  return Array.from({ length: n }, (_, i) => Number((from + ((to - from) * i) / (n - 1)).toPrecision(12)))
}

/**
 * The values a curve is computed at, or why there are none. A list rule decides them itself — a discrete
 * choice has no points in between. Otherwise both ends and every point must be allowed: the backend would
 * refuse the run anyway, and a field that says so before the click is the better place.
 */
export function curveValues(
  input: SensInput | undefined,
  from: number | null,
  to: number | null,
  points: number
): { values: number[] | null; error: string | null } {
  if (!input) return { values: null, error: 'Pick a parameter.' }
  if (input.rule.kind === 'list') {
    const values = [...(input.rule.values ?? [])].sort((a, b) => a - b)
    return values.length > 1
      ? { values, error: null }
      : { values: null, error: 'Its rule allows a single value: there is nothing to vary.' }
  }
  if (from == null || to == null) return { values: null, error: 'Enter where the curve starts and ends.' }
  if (from === to) return { values: null, error: 'Start and end are the same value.' }
  if (!Number.isInteger(points) || points < 2 || points > MAX_POINTS)
    return { values: null, error: `Use 2 to ${MAX_POINTS} points.` }
  for (const v of [from, to]) {
    const why = violates(input.rule, v)
    if (why) return { values: null, error: `${fmtValue(v)} is not allowed: ${input.name} ${why}.` }
  }
  return { values: linspace(Math.min(from, to), Math.max(from, to), points), error: null }
}

/** A stable key of the settings a run was computed with: a stored run whose key differs is not what the
 *  card's settings ask for any more. */
export function runKey(body: unknown): string {
  return JSON.stringify(body)
}

/** What the card says about a stored run against the settings and the model as they are now. `changed` is
 *  the backend's answer to "did anything that moves this result change since the run?" (`useRunChanged`). */
export function runState(
  stored: StoredRun<unknown> | null | undefined,
  key: string,
  changed: boolean | null,
  /** The check itself failed: freshness is unknown, which must not read as "fresh". */
  failed = false
): RunState {
  if (!stored) return 'none'
  if (changed) return 'model'
  if (stored.key !== key) return 'settings'
  return failed ? 'unknown' : 'fresh'
}

export type RunState = 'none' | 'settings' | 'model' | 'fresh' | 'unknown'

/** "4 min 29 s", "38 s". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null) return ''
  const s = Math.round(seconds)
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`
}

/** "today 19:53" or "3 Nov 19:53" — when a stored run was started. */
export function fmtWhen(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === now.toDateString()
    ? `today ${time}`
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`
}

/**
 * The range a new curve starts with: half to one and a half times the parameter's value, cut to what its
 * rule allows — a recycling rate of 0.97 proposed up to 1.455 was a range the curve's own check then
 * refused. A parameter at 0 has no "half of it"; it starts on its rule's range, or 0 to 1.
 */
export function defaultRange(input: SensInput): { from: number; to: number } {
  const rule = input.rule
  const lo = rule.kind === 'range' ? rule.min : undefined
  const hi = rule.kind === 'range' ? rule.max : undefined
  const round = (v: number): number => Number(v.toPrecision(6))
  if (!input.value) return { from: lo ?? 0, to: hi ?? (lo != null ? lo + 1 : 1) }
  // Rounded first, cut second: rounding after the cut could land just past the end (0.123457 > 0.1234567).
  let from = round(Math.min(input.value * 0.5, input.value * 1.5))
  let to = round(Math.max(input.value * 0.5, input.value * 1.5))
  if (lo != null) from = Math.max(from, lo)
  if (hi != null) to = Math.min(to, hi)
  return { from, to }
}

/** The footnote of a bar whose step pushed another parameter outside its rule: "eol_plastic_inc +10 % takes
 *  eol_plastic_rec to −0.045 (allowed: between 0 and 1)". Such a bar describes a model the rules exclude. */
export function breakNote(e: TornadoEntry, delta: number): string {
  return (['low', 'high'] as const)
    .flatMap((side) =>
      (e.breaks?.[side] ?? []).map((b) => {
        const step = e.limited?.[side]
          ? signedPct(stepPct(e, side))
          : `${side === 'low' ? '−' : '+'}${pctLabel(delta)} %`
        return `${e.param} ${step} takes ${b.param} to ${fmtValue(b.value)} (allowed: ${b.allowed})`
      })
    )
    .join('; ')
}
