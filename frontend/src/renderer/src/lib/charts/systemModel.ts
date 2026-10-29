/**
 * The system-model figure: the foreground processes, their links, and the first tier of background
 * datasets — laid out with dagre and drawn as SVG by hand.
 *
 * Why not an echarts graph: its force layout is not deterministic, and a report figure has to come
 * out byte-identical for the same model (the export bundle is compared, the preview is cached). Dagre
 * is deterministic and is what the canvas already uses (`lib/layout.ts`), so the drawing looks like the
 * model the reader knows from the app. The *data* — which datasets are drawn, which are folded into a
 * "+ n further" node, each node's share of the leading indicator — comes from the backend
 * (`report_graph.system_model`) and lands in `data.json`; this module only places and paints it.
 */
import type { Edge, Node } from '@xyflow/react'
import { layoutWithDagre } from '../layout'
import { heatColor, mix, seriesColors, type FigureInk, type ReportPalette } from '../reportColors'
import { ellipsize, textWidth } from './figureText'
import { figureFont, type FigureFonts } from './reportFigures'

export interface SystemModelNode {
  id: string
  name: string
  location: string
  unit: string
  product?: string
  /** A background dataset (drawn muted) rather than one of the model's own processes. */
  external: boolean
  /** Share of the leading indicator carried into the model, when a contribution tree was available. */
  share: number | null
  tags?: { dimension: string; value: string }[]
  /** How many datasets this node stands for — 0 for a real node, n for a "+ n further datasets" node. */
  folded: number
}

export interface SystemModelEdge {
  source: string
  target: string
  amount: number | null
  unit: string
  share: number | null
}

export interface SystemModelData {
  nodes: SystemModelNode[]
  edges: SystemModelEdge[]
  per_process?: number
  counts?: { processes: number; datasets: number; folded: number; has_shares?: boolean }
}

export interface SystemModelOptions {
  /** `tag:<family>` colours the foreground by that family's values; `share` by the node's share of the
   *  leading indicator; anything else paints every process in the accent. */
  colourBy?: string | null
  /** Print each link's amount and unit beside it. */
  edgeAmounts?: boolean
  lang?: string
}

// Box geometry, in SVG user units. The whole drawing is scaled to the text block (~470 pt on A4), so
// what decides legibility is the drawing's total width in these units: three tiers of 150 with 56
// between them come out at roughly 0.85 pt per unit, which keeps 9-unit type at 7.5 pt. The first
// cut used the canvas' 168 × 52 boxes and its 150-unit tier gap, and the type came out under 5 pt.
const W = 150
const H = 40
const H_EXT = 34
const RADIUS = 4
const FONT = 9
const FONT_SMALL = 7.5
const NODESEP = 8
const RANKSEP = 56
/** Average glyph advance for the fonts the themes use, relative to the font size — how many characters
 *  fit a line. An estimate, deliberately: measuring text needs a canvas and the font loaded, and the
 *  figure has to come out the same on every machine. */
const GLYPH = 0.52

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Cut a label to the characters that fit one line, with an ellipsis — deterministic, glyph-estimated. */
export function fitLabel(text: string, width: number, size: number): string {
  const max = Math.max(3, Math.floor(width / (size * GLYPH)))
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

function pct(share: number | null, lang: string): string {
  if (share === null || !Number.isFinite(share)) return ''
  const v = Math.abs(share) * 100
  const digits = v >= 10 ? 0 : 1
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(share * 100)} %`
}

// The tag legend under the graph, in SVG units: a swatch and its gap to the name, the gap to the next item,
// the depth of a row and of the first one (which also clears the graph), and how many rows it may take.
const SWATCH = 11
const ITEM_GAP = 12
const LEGEND_ROW = 13
const LEGEND_FIRST = 22
const LEGEND_ROWS = 4

/** One placed piece of the tag legend: a value with its colour, or the count of those left out. */
export interface LegendPiece {
  text: string
  /** The value's place in the colour order; absent on the family's name and on the count. */
  colour?: number
  x: number
  row: number
}

/**
 * The tag legend, broken into rows across `width` — the graph's own width, so the legend never makes the
 * drawing wider and the graph keeps its scale on the page. The family's name leads the first row, the
 * values follow and continue under the first of them; a name too long for a row of its own ends in an
 * ellipsis. Past `LEGEND_ROWS` rows the rest is counted ("+ 9") rather than drawn: four rows of colours are
 * already more than a reader can tell apart, and the boxes still carry their colour. Widths are the widest
 * bundled face's, so no name runs into the next swatch whatever face the theme prints it in.
 */
export function tagLegendLayout(
  family: string,
  values: string[],
  width: number
): {
  pieces: LegendPiece[]
  rows: number
  height: number
} {
  const lead = ellipsize(`${family}:`, width, FONT_SMALL)
  const leadWidth = textWidth(lead, FONT_SMALL) + 10
  // A short name hangs the values under the first of them; a long one takes the first row to itself.
  const indent = leadWidth <= width / 3 ? leadWidth : 0
  const pieces: LegendPiece[] = [{ text: lead, x: 0, row: 0 }]
  let row = indent ? 0 : 1
  let x = indent
  const room = Math.max(24, width - indent - SWATCH)
  const placed: LegendPiece[] = []
  let i = 0
  for (; i < values.length; i++) {
    const text = ellipsize(values[i], room, FONT_SMALL)
    const w = SWATCH + textWidth(text, FONT_SMALL)
    if (x > indent && x + w > width) {
      if (row + 1 >= LEGEND_ROWS) break
      row += 1
      x = indent
    }
    placed.push({ text, colour: i, x, row })
    x += w + ITEM_GAP
  }
  if (i < values.length) {
    // The count goes at the end of the last row, giving up as many of its values as it needs room for.
    let count = `+ ${values.length - i}`
    while (
      placed.length &&
      x + textWidth(count, FONT_SMALL) > width &&
      placed[placed.length - 1].row === row
    ) {
      const last = placed.pop()!
      x = last.x
      count = `+ ${values.length - placed.length}`
    }
    placed.push({ text: count, x, row })
  }
  pieces.push(...placed)
  const rows = Math.max(...pieces.map((p) => p.row)) + 1
  return { pieces, rows, height: LEGEND_FIRST + (rows - 1) * LEGEND_ROW }
}

function amountText(amount: number | null, unit: string, lang: string): string {
  if (amount === null || !Number.isFinite(amount)) return ''
  const a = Math.abs(amount)
  const text =
    a !== 0 && (a >= 1e4 || a < 1e-3)
      ? amount.toExponential(2)
      : new Intl.NumberFormat(lang, { maximumSignificantDigits: 3 }).format(amount)
  return unit ? `${text} ${unit}` : text
}

/**
 * The figure as an SVG string, or null when there is nothing to draw.
 *
 * Deterministic for the same input: dagre's layout is, and every number and label here is derived by
 * fixed rules. Nodes are laid out left to right — inputs on the left feeding the reference product on
 * the right, the way the canvas draws the model.
 */
export function systemModelSvg(
  model: SystemModelData,
  opts: SystemModelOptions,
  pal: ReportPalette,
  ink: FigureInk,
  fonts?: FigureFonts
): string | null {
  const nodes = model.nodes ?? []
  if (!nodes.length) return null
  const lang = opts.lang ?? 'en'
  const font = figureFont(fonts, 'body')
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges = (model.edges ?? []).filter((e) => byId.has(e.source) && byId.has(e.target))

  // Layout. The React Flow node/edge types are structural here: dagre reads id, size and the two
  // endpoints, nothing else — which is what makes the canvas' layout reusable for a static picture.
  const flowNodes = nodes.map(
    (n) =>
      ({
        id: n.id,
        position: { x: 0, y: 0 },
        data: {},
        width: W,
        height: n.external ? H_EXT : H
      }) as Node
  )
  const flowEdges = edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target }) as Edge)
  const placed = layoutWithDagre(flowNodes, flowEdges, [], 'LR', W, H, { nodesep: NODESEP, ranksep: RANKSEP })
  const pos = new Map(placed.map((n) => [n.id, n.position]))

  // Colours. Foreground by tag family (one colour per value, in first-seen order), by share (the heat
  // ramp), or the accent; background muted so the eye reads the model first and its inputs second.
  const family = opts.colourBy?.startsWith('tag:') ? opts.colourBy.slice(4) : null
  const values: string[] = []
  if (family) {
    for (const n of nodes) {
      const v = n.tags?.find((t) => t.dimension === family)?.value
      if (v && !values.includes(v)) values.push(v)
    }
  }
  const series = seriesColors(Math.max(2, values.length), pal)
  // Boxes carry no border and white type: the fill is the whole mark. A background
  // dataset is a mid grey that white type reads on, on light and on dark paper alike.
  const fillFor = (n: SystemModelNode): string => {
    if (n.external) return mix(pal.deep, ink.axis, 0.5)
    if (family) {
      const v = n.tags?.find((t) => t.dimension === family)?.value
      const i = v ? values.indexOf(v) : -1
      // Untagged processes in a mostly deep tone — the pale accent wash they had swallowed the white type.
      return i >= 0 ? series[i % series.length] : mix(pal.deep, pal.accent, 0.3)
    }
    if (opts.colourBy === 'share' && n.share !== null) return heatColor(Math.min(1, Math.abs(n.share)), pal)
    return pal.accent
  }

  // Bounds → viewBox, with room for a legend row when the colouring needs one.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    const p = pos.get(n.id) ?? { x: 0, y: 0 }
    const h = n.external ? H_EXT : H
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + W)
    maxY = Math.max(maxY, p.y + h)
  }
  const pad = 12
  const legend = family && values.length ? tagLegendLayout(family, values, maxX - minX) : null
  const x0 = minX - pad
  const y0 = minY - pad
  const width = maxX - minX + 2 * pad
  const height = maxY - minY + 2 * pad + (legend?.height ?? 0)

  const out: string[] = []
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${width} ${height}" width="${width}" height="${height}" font-family="${esc(font)}" font-size="${FONT}">`
  )
  out.push(
    `<defs><marker id="sm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${esc(ink.axis)}"/></marker></defs>`
  )

  // Edges first, so the boxes cover their ends. A cubic from the source's right edge to the target's
  // left edge; the label sits at the curve's midpoint.
  for (const e of edges) {
    const s = byId.get(e.source)!
    const t = byId.get(e.target)!
    const ps = pos.get(s.id) ?? { x: 0, y: 0 }
    const pt = pos.get(t.id) ?? { x: 0, y: 0 }
    const sx = ps.x + W
    const sy = ps.y + (s.external ? H_EXT : H) / 2
    const tx = pt.x
    const ty = pt.y + (t.external ? H_EXT : H) / 2
    const dx = Math.max(16, (tx - sx) / 2)
    const d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${tx - dx} ${ty}, ${tx} ${ty}`
    const stroke = s.external ? ink.axis : ink.ink
    const dash = s.external ? ' stroke-dasharray="3 2"' : ''
    out.push(
      `<path d="${d}" fill="none" stroke="${esc(stroke)}" stroke-width="${s.external ? 0.8 : 1.1}"${dash} marker-end="url(#sm-arrow)"/>`
    )
    if (opts.edgeAmounts) {
      const label = amountText(e.amount, e.unit, lang)
      if (label) {
        const mx = (sx + tx) / 2
        const my = (sy + ty) / 2 - 3
        out.push(
          `<text x="${mx}" y="${my}" text-anchor="middle" font-size="${FONT_SMALL}" fill="${esc(ink.axis)}">${esc(label)}</text>`
        )
      }
    }
  }

  // Boxes. Two lines for a process — name, then location · unit (· share) — and one and a half for a
  // dataset; the folded node says how many it stands for.
  for (const n of nodes) {
    const p = pos.get(n.id) ?? { x: 0, y: 0 }
    const h = n.external ? H_EXT : H
    const fill = fillFor(n)
    out.push(`<rect x="${p.x}" y="${p.y}" width="${W}" height="${h}" rx="${RADIUS}" fill="${esc(fill)}"/>`)
    const textColor = '#ffffff'
    const share = pct(n.share, lang)
    if (n.folded) {
      const line1 = fitLabel(`+ ${n.folded} further ${n.folded === 1 ? 'dataset' : 'datasets'}`, W - 12, FONT)
      out.push(
        `<text x="${p.x + W / 2}" y="${p.y + h / 2 - (share ? 2 : -3)}" text-anchor="middle" font-style="italic" fill="${esc(textColor)}">${esc(line1)}</text>`
      )
      if (share) {
        out.push(
          `<text x="${p.x + W / 2}" y="${p.y + h / 2 + 10}" text-anchor="middle" font-size="${FONT_SMALL}" fill="${esc(textColor)}">${esc(share)}</text>`
        )
      }
      continue
    }
    const name = fitLabel(n.name || n.id, W - 12, FONT)
    const sub = [n.location, n.unit, share].filter(Boolean).join(' · ')
    const subText = fitLabel(sub, W - 12, FONT_SMALL)
    out.push(
      `<text x="${p.x + 6}" y="${p.y + (sub ? h / 2 - 3 : h / 2 + 3)}" fill="${esc(textColor)}" font-weight="${n.external ? 'normal' : '600'}">${esc(name)}</text>`
    )
    if (sub) {
      out.push(
        `<text x="${p.x + 6}" y="${p.y + h / 2 + 9}" font-size="${FONT_SMALL}" fill="${esc(textColor)}">${esc(subText)}</text>`
      )
    }
  }

  // Legend for a tag colouring: one swatch per value, in the order they appeared, in rows under the graph.
  if (legend) {
    const top = maxY + pad + LEGEND_FIRST - 10
    for (const piece of legend.pieces) {
      const x = minX + piece.x
      const y = top + piece.row * LEGEND_ROW
      if (piece.colour === undefined) {
        // The family's name, and the count of values left out, in the axis grey.
        out.push(
          `<text x="${x}" y="${y}" font-size="${FONT_SMALL}" fill="${esc(ink.axis)}">${esc(piece.text)}</text>`
        )
        continue
      }
      out.push(
        `<rect x="${x}" y="${y - 7}" width="8" height="8" rx="1.5" fill="${esc(series[piece.colour % series.length])}"/>`
      )
      out.push(
        `<text x="${x + SWATCH}" y="${y}" font-size="${FONT_SMALL}" fill="${esc(ink.ink)}">${esc(piece.text)}</text>`
      )
    }
  }
  out.push('</svg>')
  return out.join('')
}
