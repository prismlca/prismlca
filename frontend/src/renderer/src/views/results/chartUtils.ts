import { NEUTRAL_GREY, STACK_PALETTE } from '../../lib/palette'

// Distinct colours for stacked classification segments; '(untagged)'/'(no …)' = grey.
export function stackColor(key: string, i: number): string {
  return /^\(/.test(key) ? NEUTRAL_GREY : STACK_PALETTE[i % STACK_PALETTE.length]
}

/** Category-axis label config that copes with full ecoinvent names: every label is shown
 * (interval 0) but truncated with an ellipsis to its share of the chart width — the full name
 * stays readable in the axis tooltip. */
export function catAxisLabel(
  axisColor: string,
  count: number,
  el: HTMLElement | null,
  rotated: boolean,
  /** 1 in a panel, larger in the enlarge overlay — see `ZOOM_SCALE`. */
  scale = 1
): Record<string, unknown> {
  const chartWidth = el?.clientWidth || 600
  const width = Math.max(70, Math.min(170 * scale, Math.floor(chartWidth / Math.max(count, 1)) - 12))
  // Wrap, do not truncate. A scenario called "Long distribution (1200 km)" was cut to "Long distr…",
  // which is exactly the information that distinguishes it from its neighbour. Rotation and wrapping
  // together are unreadable, so a wrapped label stays horizontal.
  return {
    color: axisColor,
    interval: 0,
    rotate: rotated ? 22 : 0,
    width,
    overflow: rotated ? 'truncate' : 'break',
    fontSize: Math.round(12 * scale),
    lineHeight: Math.round(13 * scale)
  }
}

/**
 * How much larger the type is in the enlarge overlay.
 *
 * A chart drawn at 1400×800 with the 10px labels of a 300px panel is a big picture with unreadable writing —
 * which is the opposite of what enlarging is for. The factor is not
 * the size ratio: at 4× the area, 4× the type would be a poster.
 *
 * 1.3, not 1.5 — at half again the axis was a touch louder than the data. 1.3 puts
 * the axis labels at 16px against the overlay's own 17px title, which is the order those two belong in.
 */
export const ZOOM_SCALE = 1.3

/**
 * Drop the part every label shares.
 *
 * Subjects read "<model> · <scenario>", so a chart comparing three scenarios of one model repeated the
 * model name three times and pushed the distinguishing half out of view. Deliberately *not* an LLM
 * abbreviation: a chart label has to match the table beside it exactly, and an invented short form in a
 * client report is a defect rather than a nicety.
 */
export function trimCommonPrefix(labels: string[]): string[] {
  if (labels.length < 2) return labels
  const parts = labels.map((l) => l.split(' · '))
  if (parts.some((p) => p.length < 2)) return labels
  const head = parts[0][0]
  if (!parts.every((p) => p[0] === head)) return labels
  return parts.map((p) => p.slice(1).join(' · '))
}

export function fmtPct(x: number): string {
  const s = Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1)
  return `${x > 0 ? '+' : ''}${s}%`
}

export function pngName(s: string): string {
  return (
    (s
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'chart') + '.png'
  )
}
/** Lighten a hex colour toward white by `t` (0..1) — for shading indicators within a family. */
export function lighten(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  const mix = (c: number): number => Math.round(c + (255 - c) * t)
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}
