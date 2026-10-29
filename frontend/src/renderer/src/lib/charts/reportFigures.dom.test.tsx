import { describe, expect, it, vi } from 'vitest'

import { figureInk } from '../reportColors'
import { textWidth } from './figureText'
import {
  BAR_WIDTH,
  CONTRIBUTION_WIDTH,
  barOption,
  chartSvg,
  columnChartHeight,
  contributionPlotTop,
  groupedContributionOption,
  heatmapHeight,
  heatmapOption,
  rowChartHeight,
  stackedContributionHeight,
  stackedContributionOption
} from './reportFigures'

/**
 * The legend never reaches the plot, and the names on a variant axis never reach each other — checked on
 * the drawing echarts actually makes, not on the option.
 *
 * Before the legend was laid out by `figureText`, a legend that wrapped put its second row across the top
 * of the bars (rows are 24 apart, the plot moved down 16 per row), and a full first row ran over the unit
 * the value axis letters above the plot. Here the SVG is drawn and the three are found in it: the legend
 * swatches, the unit, and the plot's top grid line.
 */

const FONTS = { body: 'IBM Plex Sans', mono: 'IBM Plex Sans' }
const UNIT = 'kg CO2-Eq'

function subjects(names: string[]) {
  return names.map((label, i) => ({
    label,
    groups: [
      { key: 'production', label: 'Production', impact: 3.2 - i * 0.1 },
      { key: 'transport', label: 'Transport', impact: 0.8 + i * 0.3 },
      { key: 'eol', label: 'End of life', impact: -0.4 }
    ]
  }))
}

/** Where the legend's last row ends, where the unit is centred, and where the plot starts, read off the SVG. */
function geometry(svg: string) {
  // A legend swatch is echarts' rounded rectangle, 25 × 14, placed by a translate.
  const swatches = [
    ...svg.matchAll(/<path d="M3\.5 0L21\.5 0[^"]*" transform="translate\([\d.]+ ([\d.]+)\)/g)
  ]
  const legendBottom = Math.max(...swatches.map((m) => Number(m[1]) + 14))
  const tag = svg.match(/<text([^>]*)>kg CO2-Eq</)?.[1] ?? null
  const unitCentre = tag
    ? Number(tag.match(/translate\([\d.]+ ([\d.]+)\)/)?.[1]) + Number(tag.match(/ y="([-\d.]+)"/)?.[1] ?? 0)
    : null
  // The plot's top edge: the highest horizontal line drawn across most of the width.
  const lines = [...svg.matchAll(/<path d="M([\d.]+) ([\d.]+)L([\d.]+) \2"/g)]
    .filter((m) => Number(m[3]) - Number(m[1]) > 400)
    .map((m) => Number(m[2]))
  return { legendBottom, unitCentre, plotTop: Math.min(...lines), swatches: swatches.length }
}

const LEGENDS: Record<string, string[]> = {
  'one row': ['Baseline', 'Long distribution (1200 km)', 'Recycled content 50 %'],
  'a full first row': [
    'BASELINE: VIRGIN PET MIX',
    'SCENARIO A: RECYCLED PET',
    'SCENARIO B: BIO-BASED PE',
    'SCENARIO C: RAIL FREIGHT'
  ],
  'three rows': Array.from({ length: 10 }, (_, i) => `Alternative supplier ${i + 1}, rail freight`)
}

describe('a report figure’s legend', () => {
  for (const [name, labels] of Object.entries(LEGENDS)) {
    it(`stays above the unit and the plot: ${name}`, () => {
      // jsdom has no canvas; echarts then estimates text widths itself, which is what the slots override.
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
      const option = groupedContributionOption(
        subjects(labels),
        UNIT,
        undefined,
        figureInk(false),
        FONTS,
        'en'
      )
      const svg = chartSvg(option, 720, 92 + 4 * 26 + contributionPlotTop(labels))
      expect(svg).not.toBeNull()
      const g = geometry(svg!)
      expect(g.swatches).toBe(labels.length)
      expect(g.unitCentre).not.toBeNull()
      // 11-pixel type, centred: its top sits 5.5 above the centre, and we want air above that.
      expect(g.legendBottom + 4).toBeLessThanOrEqual(g.unitCentre! - 5.5)
      expect(g.unitCentre! + 5.5).toBeLessThan(g.plotTop)
    })
  }

  it('stays above the plot of bars running across, which letter their unit at the foot', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const phases = ['Raw material production', 'Manufacturing', 'Transport', 'Use phase', 'End of life']
    const variants = subjects(['A', 'B']).map((s) => ({
      ...s,
      groups: phases.map((label, i) => ({ key: label, label, impact: i + 1 }))
    }))
    const option = stackedContributionOption(variants, UNIT, undefined, true, true, figureInk(false), FONTS)
    const svg = chartSvg(option, 720, 300)
    const g = geometry(svg!)
    expect(g.swatches).toBe(phases.length)
    expect(g.legendBottom).toBeLessThan(g.plotTop)
  })
})

/** A label's box (the invisible background that fixes its size), where it lands, and the lines in it. */
interface Box {
  left: number
  right: number
  top: number
  bottom: number
  /** The box's own width before any rotation: the width its lines were fitted to. */
  width: number
  lines: string[]
  fontSize: number
}

/** Every fitted label box in the drawing, rotation applied, with the lines echarts drew at the same place. */
function labelBoxes(svg: string): Box[] {
  const texts = [...svg.matchAll(/<text([^>]*)transform="([^"]*)"[^>]*>([^<]*)<\/text>/g)]
  const boxes = svg.matchAll(
    /<path d="M(-?[\d.]+) (-?[\d.]+)l(-?[\d.]+) 0l0 (-?[\d.]+)l-?[\d.]+ 0Z" transform="([^"]*)" fill="rgb\(0,0,0\)" fill-opacity="0">/g
  )
  return [...boxes].map((m) => {
    const [x, y, w, h] = m.slice(1, 5).map(Number)
    const t = m[5].match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g)!.map(Number)
    const [a, b, c, d, e, f] = m[5].startsWith('matrix') ? t : [1, 0, 0, 1, t[0], t[1]]
    const corners = [
      [x, y],
      [x + w, y],
      [x, y + h],
      [x + w, y + h]
    ].map(([px, py]) => [a * px + c * py + e, b * px + d * py + f])
    const mine = texts.filter((tx) => tx[2] === m[5])
    return {
      left: Math.min(...corners.map((p) => p[0])),
      right: Math.max(...corners.map((p) => p[0])),
      top: Math.min(...corners.map((p) => p[1])),
      bottom: Math.max(...corners.map((p) => p[1])),
      width: w,
      lines: mine.map((tx) => tx[3].replace(/&amp;/g, '&')),
      fontSize: Number(mine[0]?.[1].match(/font-size: ([\d.]+)px/)?.[1] ?? 0)
    }
  })
}

/** The plot's bottom edge: the lowest horizontal line drawn across most of the width. */
const plotBottom = (svg: string): number =>
  Math.max(
    ...[...svg.matchAll(/<path d="M([\d.]+) ([\d.]+)L([\d.]+) \2"/g)]
      .filter((m) => Number(m[3]) - Number(m[1]) > 300)
      .map((m) => Number(m[2]))
  )

const svgHeight = (svg: string): number => Number(svg.match(/height="([\d.]+)"/)![1])

const VARIANTS = [
  'Baseline',
  'Long distribution (1200 km)',
  'Recycled content 50 %',
  'Alternative supplier, rail freight',
  'Bio-based polymer (50 % share)',
  'Optimised packaging, lighter carton',
  'Grid mix 2030',
  'SCENARIO H: REUSABLE CRATE',
  'Combined best case with renewable electricity',
  'Variant J',
  'Variant K: heavier glass',
  'Variant L',
  'Variant M (refill)',
  'Variant N'
]

/** Each box holds its lines in the widest face, and no two boxes touch: `gap` apart along the axis. */
function expectApart(boxes: Box[], across: 'x' | 'y', gap: number): void {
  for (const box of boxes) {
    for (const line of box.lines)
      expect(textWidth(line, box.fontSize), line).toBeLessThanOrEqual(box.width + 0.5)
  }
  const sorted = [...boxes].sort((p, q) => (across === 'x' ? p.left - q.left : p.top - q.top))
  for (let i = 1; i < sorted.length; i++) {
    const before = across === 'x' ? sorted[i - 1].right : sorted[i - 1].bottom
    const after = across === 'x' ? sorted[i].left : sorted[i].top
    expect(after - before, sorted[i].lines.join(' ')).toBeGreaterThanOrEqual(gap)
  }
}

describe('the names on a variant axis', () => {
  for (const count of [3, 9, 14]) {
    it(`stand clear of each other and of the plot under upright stacked bars: ${count} variants`, () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
      const variants = subjects(VARIANTS.slice(0, count))
      const option = stackedContributionOption(
        variants,
        UNIT,
        undefined,
        true,
        false,
        figureInk(false),
        FONTS
      )
      const svg = chartSvg(option, CONTRIBUTION_WIDTH, stackedContributionHeight(variants))!
      const below = labelBoxes(svg).filter((b) => b.top >= plotBottom(svg) - 1)
      expect(below).toHaveLength(count)
      expectApart(below, 'x', 6)
      for (const box of below) expect(box.bottom).toBeLessThanOrEqual(svgHeight(svg))
      // Up to nine they stand upright and every name is whole; past that they stand on end.
      if (count <= 9) {
        expect(below.every((b) => b.right - b.left === b.width)).toBe(true)
        expect(below.map((b) => b.lines.join(' '))).toEqual(VARIANTS.slice(0, count))
      } else expect(below.every((b) => b.bottom - b.top === b.width)).toBe(true)
    })
  }

  it('stand clear of each other under upright bars of a chapter’s own figure', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const names = VARIANTS.slice(0, 9)
    const option = barOption(
      names,
      names.map((_, i) => i + 1),
      UNIT,
      undefined,
      false,
      figureInk(false),
      FONTS
    )
    const svg = chartSvg(option, BAR_WIDTH, columnChartHeight(names))!
    const below = labelBoxes(svg).filter((b) => b.top >= plotBottom(svg) - 1)
    expect(below).toHaveLength(names.length)
    expectApart(below, 'x', 6)
    for (const box of below) expect(box.bottom).toBeLessThanOrEqual(svgHeight(svg))
  })

  it('get a row each, as tall as their lines, beside bars running across', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const names = VARIANTS.slice(0, 9)
    const option = barOption(
      names,
      names.map((_, i) => i + 1),
      UNIT,
      undefined,
      true,
      figureInk(false),
      FONTS
    )
    const svg = chartSvg(option, BAR_WIDTH, rowChartHeight(names, 300))!
    const beside = labelBoxes(svg)
    expect(beside).toHaveLength(names.length)
    expectApart(beside, 'y', 2)
    for (const box of beside) expect(box.left).toBeGreaterThanOrEqual(0)
  })

  it('leave room for the unit at the end of a value axis running across', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const variants = subjects(VARIANTS.slice(0, 4))
    const option = stackedContributionOption(variants, UNIT, undefined, true, true, figureInk(false), FONTS)
    const svg = chartSvg(option, CONTRIBUTION_WIDTH, stackedContributionHeight(variants, true))!
    const unit = svg.match(/<text([^>]*)>kg CO2-Eq</)![1]
    const x = Number(unit.match(/translate\(([\d.]+) /)![1]) + Number(unit.match(/ x="([-\d.]+)"/)?.[1] ?? 0)
    expect(x + textWidth(UNIT, 11)).toBeLessThanOrEqual(CONTRIBUTION_WIDTH)
  })
})

describe('a heatmap’s variant names', () => {
  const INDICATORS = [
    'climate change',
    'acidification',
    'photochemical oxidant formation: human health',
    'particulate matter formation',
    'water use'
  ]
  const heatSubjects = (names: string[]) =>
    names.map((label, i) => ({
      label,
      results: INDICATORS.map((method_label, j) => ({ method_label, score: 1 + ((i + j) % 4) }))
    }))

  for (const names of [
    ['Alternative production with renewable electricity', 'Alternative packaging with recycled material'],
    VARIANTS.slice(0, 9)
  ]) {
    it(`get rows as tall as their lines, under indicator names on end: ${names.length} variants`, () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
      const option = heatmapOption(
        heatSubjects(names),
        INDICATORS,
        INDICATORS,
        undefined,
        figureInk(false),
        FONTS
      )
      const svg = chartSvg(option, 760, heatmapHeight(names, INDICATORS))!
      const rows = labelBoxes(svg).filter(
        (b) => names.includes(b.lines.join(' ').replace(/…$/, '')) || b.left < 200
      )
      expect(rows).toHaveLength(names.length)
      // Two pixels apart at least, and every row inside the plot rather than in the indicator names under it.
      expectApart(rows, 'y', 2)
      for (const box of rows) expect(box.bottom).toBeLessThanOrEqual(plotBottom(svg) + 1)
    })
  }
})
