/**
 * The contribution tree's card — geometry and text fitting, apart from the drawing.
 *
 * The tree is drawn in SVG (see `views/DetailedResults.tsx` and ADR-006: React Flow is the canvas,
 * D3 the result graphics), and SVG has no box model: every line, every truncation and every bar
 * width is a number somebody has to compute. Those numbers live here so they can be tested without
 * a DOM — and because getting them wrong is invisible until a name runs under the chevron.
 *
 * The design is `design/detailed-results-nodes.html`, compact variant: a white card with the ISIC
 * colour as a bar along its top, the process name over at most two lines, one meta line, and the
 * share as a percentage over a two-segment bar — pale for what the whole branch carries, solid for
 * the part this process emits itself.
 */

/** Card geometry in SVG units. One card, one size — the tree stays legible by being uniform. */
export const CARD = {
  W: 216,
  H: 82,
  /** Left inset for every text and the bar. */
  PAD: 11,
  /** The expand/collapse zone along the right edge. */
  ZONE_W: 26,
  /** Where the content has to stop: the zone plus a breath. */
  RIGHT: 33,
  /** The ISIC colour bar along the top. */
  BAR_H: 5,
  R: 8,
  /** Baselines, measured from the card's centre (the group's origin). */
  TITLE1_Y: -19,
  TITLE2_Y: -6,
  META_Y: 9,
  SHARE_Y: 26,
  /** The share bar. */
  BAR_Y: 31,
  BAR_TH: 6,
  /** The ⓘ of a background dataset, centred here. */
  INFO_X: 175,
  INFO_Y: -27,
  INFO_R: 7
} as const

/** How wide the content may be — line 1 gives way to the ⓘ when there is one. */
export const contentW = (hasInfo: boolean): number => CARD.W - CARD.PAD - CARD.RIGHT - (hasInfo ? 18 : 0)

/** The share bar's track. */
export const trackW = (): number => CARD.W - CARD.PAD - CARD.RIGHT

export type Measure = (text: string) => number

/**
 * The name over at most two lines, broken on words, the last one ellipsised if it still does not fit.
 *
 * Two lines rather than one, because ecoinvent names are sentences ("market for electricity, medium
 * voltage" is the short kind) and the old card cut them at 24 characters — which turned three
 * different transport datasets into the same string. A word longer than the line is broken mid-word:
 * refusing to break it would print past the card edge, and there are chemical names that do that.
 */
export function fitLines(text: string, measure: Measure, budgets: [number, number]): string[] {
  const clean = String(text || '').trim()
  if (!clean) return ['']
  const lines: string[] = []
  let rest = clean
  for (let i = 0; i < budgets.length; i++) {
    const budget = budgets[i]
    const last = i === budgets.length - 1
    if (measure(rest) <= budget) {
      lines.push(rest)
      return lines
    }
    if (last) {
      lines.push(ellipsise(rest, measure, budget))
      return lines
    }
    // The longest run of whole words that still fits; a single over-long word is cut mid-word so the
    // line is never wider than the card.
    const words = rest.split(' ')
    let take = ''
    let n = 0
    while (n < words.length) {
      const next = take ? `${take} ${words[n]}` : words[n]
      if (measure(next) > budget) break
      take = next
      n++
    }
    if (!take) {
      take = cutToWidth(words[0], measure, budget)
      rest = (words[0].slice(take.length) + ' ' + words.slice(1).join(' ')).trim()
    } else {
      rest = words.slice(n).join(' ')
    }
    lines.push(take)
    if (!rest) return lines
  }
  return lines
}

/** As much of the text as fits, with an ellipsis — used for the last line and the meta line. */
export function ellipsise(text: string, measure: Measure, budget: number): string {
  const clean = String(text || '')
  if (measure(clean) <= budget) return clean
  const cut = cutToWidth(clean, measure, budget - measure('…'))
  return `${cut.replace(/[\s,;·-]+$/, '')}…`
}

function cutToWidth(text: string, measure: Measure, budget: number): string {
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(text.slice(0, mid)) <= budget) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, Math.max(1, lo))
}

/**
 * The line under the name: what kind of process this is and where it sits.
 *
 * A process of the model itself says so — it has no ISIC section, and "—" would read as missing data
 * rather than as "this is yours". The root says what it is: the reference of the whole calculation,
 * which happens to be a model process too, and calling it one would bury the distinction. The ISIC section name is the part that gives way when the line is
 * too long: the letter and the geography are identifiers, the name is a gloss.
 */
export function metaText(
  node: { isic?: string; isicName?: string; geo?: string; own: boolean; root?: boolean },
  measure: Measure,
  budget: number
): string {
  const geo = (node.geo || '').trim()
  const head = node.root
    ? 'Functional unit'
    : node.own
      ? 'Model process'
      : node.isic
        ? `${node.isic}${node.isicName ? ` · ${node.isicName}` : ''}`
        : 'Background dataset'
  const tail = geo ? ` · ${geo}` : ''
  const room = budget - measure(tail)
  return `${ellipsise(head, measure, Math.max(20, room))}${tail}`
}

/**
 * The two segments of the share bar, in SVG units.
 *
 * Both are shares of the **whole system**, never of the parent: the pale one is what this branch
 * carries, the solid one the part this very process emits. So a card that is almost solid is a
 * hotspot you can act on, and an almost pale one is a doorway — the impact sits further upstream.
 * A negative contribution (a credit) still has to draw something, hence the absolute value.
 */
export function shareWidths(o: { impact: number; direct: number; total: number }): {
  fill: number
  direct: number
} {
  const w = trackW()
  const total = Math.abs(o.total)
  if (!total || !isFinite(total)) return { fill: 0, direct: 0 }
  const frac = (x: number): number => Math.min(1, Math.abs(x) / total)
  const fill = frac(o.impact) * w
  return { fill, direct: Math.min(fill, frac(o.direct) * w) }
}

/** The card's outline; only the top corners of the colour bar are rounded into it. */
export function colourBarPath(): string {
  const { W, H, R, BAR_H } = CARD
  const top = -H / 2
  return `M0,${top + R} A${R},${R} 0 0 1 ${R},${top} H${W - R} A${R},${R} 0 0 1 ${W},${top + R} V${top + BAR_H} H0 Z`
}

/**
 * The expand/collapse zone: the card's right edge, rounded on the BOTTOM only.
 *
 * Its top edge runs flush to the card's right edge, because the colour bar above it already carries
 * the card's rounded top corner. Rounding it here as well left a white notch between the two — the zone was
 * inset by the corner radius exactly where the card was
 * still square.
 */
export function zonePath(): string {
  const { W, H, R, ZONE_W, BAR_H } = CARD
  const top = -H / 2 + BAR_H // starts under the colour bar, so the bar stays one unbroken line
  const bottom = H / 2
  return `M${W - ZONE_W},${top} H${W} V${bottom - R} a${R},${R} 0 0 1 -${R},${R} H${W - ZONE_W} Z`
}
