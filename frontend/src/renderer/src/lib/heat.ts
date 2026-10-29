/**
 * ONE heat ramp for the whole app: light green (low) → amber → soft red (high).
 *
 * Two places draw the same picture from the same numbers — the Results heatmap (an HTML table,
 * coloured cell by cell, plus its PNG export) and the report's heatmap figure (echarts, coloured by
 * a visualMap). They must not disagree, and twice now they have: first as a white-to-green wash in
 * the report, which reads as "more green is more good" and is the wrong signal for an impact
 * indicator; then, after that was fixed here, because the report figure was quietly moved onto the
 * palette-derived ramp in `reportColors.heatColor` while this comment went on claiming they matched.
 *
 * Deliberately green-to-red everywhere. Unlike the rest of a report
 * figure — the axis ink, the grid, the series colours, which all come from the document's own
 * palette so a chart belongs to the page it lands on — a heat scale is not decoration. Its colours
 * ARE the reading: low, middling, high. A ramp that changes with the theme would make the same cell
 * mean different things in two exports of the same study.
 */
export const HEAT_STOPS: [number, number, number][] = [
  [232, 240, 216], // pale house green
  [255, 224, 138], // amber
  [230, 126, 100] // soft red
]

/** The ramp as CSS colours, for anything that interpolates by itself (echarts' visualMap). */
export const HEAT_RANGE: string[] = HEAT_STOPS.map(([r, g, b]) => `rgb(${r}, ${g}, ${b})`)

/** The ramp as one CSS gradient, for the scale drawn above the Results heatmap: the same three
 * stops at 0 %, 50 % and 100 %, so the bar and the cells cannot drift apart. */
export const HEAT_GRADIENT = `linear-gradient(90deg, ${HEAT_RANGE.map(
  (c, i) => `${c} ${Math.round((i / (HEAT_RANGE.length - 1)) * 100)}%`
).join(', ')})`

/** Heat colour for a normalized value t∈[0,1]. */
export function heatColor(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (HEAT_STOPS.length - 1)
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(x))
  const f = x - i
  const a = HEAT_STOPS[i]
  const b = HEAT_STOPS[i + 1]
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)}, ${Math.round(a[1] + (b[1] - a[1]) * f)}, ${Math.round(
    a[2] + (b[2] - a[2]) * f
  )})`
}
