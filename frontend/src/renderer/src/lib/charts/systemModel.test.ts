import { describe, expect, it } from 'vitest'
import { fitLabel, systemModelSvg, tagLegendLayout, type SystemModelData } from './systemModel'
import { figureInk, PRISM_PALETTE } from '../reportColors'
import { textWidth } from './figureText'

const model: SystemModelData = {
  nodes: [
    {
      id: 'm/bottle',
      name: 'PET bottle, 0.5 l, filled',
      location: 'DE',
      unit: 'unit',
      external: false,
      share: 1,
      tags: [{ dimension: 'Stage', value: 'Production' }],
      folded: 0
    },
    {
      id: 'm/cap',
      name: 'cap',
      location: 'DE',
      unit: 'unit',
      external: false,
      share: 0.1,
      tags: [{ dimension: 'Stage', value: 'Production' }],
      folded: 0
    },
    {
      id: 'm/eol',
      name: 'end of life',
      location: 'DE',
      unit: 'unit',
      external: false,
      share: -0.05,
      tags: [{ dimension: 'Stage', value: 'End of life' }],
      folded: 0
    },
    {
      id: 'eco/pet',
      name: 'market for polyethylene terephthalate, granulate, bottle grade',
      location: 'GLO',
      unit: 'kg',
      external: true,
      share: 0.6,
      tags: [],
      folded: 0
    },
    {
      id: 'folded:m/bottle',
      name: '',
      location: '',
      unit: '',
      external: true,
      share: 0.12,
      tags: [],
      folded: 7
    }
  ],
  edges: [
    { source: 'm/cap', target: 'm/bottle', amount: 1, unit: 'unit', share: 0.1 },
    { source: 'm/bottle', target: 'm/eol', amount: 1, unit: 'unit', share: -0.05 },
    { source: 'eco/pet', target: 'm/bottle', amount: 0.03, unit: 'kg', share: 0.6 },
    { source: 'folded:m/bottle', target: 'm/bottle', amount: null, unit: '', share: 0.12 }
  ],
  per_process: 1,
  counts: { processes: 3, datasets: 8, folded: 7, has_shares: true }
}

describe('systemModelSvg', () => {
  it('draws the same picture twice for the same model', () => {
    const a = systemModelSvg(model, { lang: 'en' }, PRISM_PALETTE, figureInk(false))
    const b = systemModelSvg(model, { lang: 'en' }, PRISM_PALETTE, figureInk(false))
    expect(a).toBeTruthy()
    expect(a).toBe(b)
  })

  it('names the folded node and prints the shares', () => {
    const svg = systemModelSvg(model, { lang: 'en' }, PRISM_PALETTE, figureInk(false))!
    expect(svg).toContain('+ 7 further datasets')
    expect(svg).toContain('12 %')
    expect(svg).toContain('60 %')
    // One box per node, one arrow per edge.
    expect(svg.match(/<rect /g)?.length).toBe(model.nodes.length)
    expect(svg.match(/marker-end/g)?.length).toBe(model.edges.length)
  })

  it('cuts long names and escapes markup', () => {
    const svg = systemModelSvg(model, { lang: 'en' }, PRISM_PALETTE, figureInk(false))!
    expect(svg).toContain('…')
    expect(svg).not.toContain('market for polyethylene terephthalate, granulate, bottle grade')
    expect(fitLabel('a<b', 400, 9)).toBe('a<b') // fitLabel does not escape; the drawing does
    expect(
      systemModelSvg(
        { ...model, nodes: [{ ...model.nodes[0], name: 'a<b>&"c' }], edges: [] },
        {},
        PRISM_PALETTE,
        figureInk(false)
      )
    ).toContain('a&lt;b&gt;&amp;&quot;c')
  })

  it('colours by a tag family with a legend, and by share without one', () => {
    const byTag = systemModelSvg(
      model,
      { colourBy: 'tag:Stage', lang: 'en' },
      PRISM_PALETTE,
      figureInk(false)
    )!
    expect(byTag).toContain('Stage:')
    expect(byTag).toContain('End of life')
    const byShare = systemModelSvg(model, { colourBy: 'share', lang: 'en' }, PRISM_PALETTE, figureInk(false))!
    expect(byShare).not.toContain('Stage:')
    expect(byShare).not.toBe(byTag)
  })

  it('labels the links with amounts only when asked, in the report language', () => {
    const plain = systemModelSvg(model, { lang: 'de' }, PRISM_PALETTE, figureInk(false))!
    expect(plain).not.toContain('0,03 kg')
    const labelled = systemModelSvg(
      model,
      { lang: 'de', edgeAmounts: true },
      PRISM_PALETTE,
      figureInk(false)
    )!
    expect(labelled).toContain('0,03 kg')
  })

  it('returns null for an empty model and copes with a cycle', () => {
    expect(systemModelSvg({ nodes: [], edges: [] }, {}, PRISM_PALETTE, figureInk(false))).toBeNull()
    const cyclic: SystemModelData = {
      nodes: model.nodes.slice(0, 2),
      edges: [
        { source: 'm/cap', target: 'm/bottle', amount: 1, unit: 'unit', share: null },
        { source: 'm/bottle', target: 'm/cap', amount: 0.1, unit: 'unit', share: null }
      ]
    }
    expect(systemModelSvg(cyclic, {}, PRISM_PALETTE, figureInk(true))).toContain('<svg')
  })
})

const STAGES = [
  'Raw material extraction',
  'Primary production',
  'Semi-finished goods',
  'Manufacturing',
  'Assembly',
  'Packaging',
  'Distribution to retail',
  'Retail',
  'Use phase (home)',
  'Maintenance and repair',
  'Collection',
  'Sorting',
  'Recycling (mechanical)',
  'Energy recovery',
  'Landfill'
]

/** Where each piece of the legend ends: a value's swatch and name, or the name and the count alone. */
const pieceEnd = (p: { text: string; colour?: number; x: number }): number =>
  p.x + (p.colour === undefined ? 0 : 11) + textWidth(p.text, 7.5)

describe('the tag legend of the system model', () => {
  it('wraps into rows within the graph’s width, the values hanging under the first of them', () => {
    const { pieces, rows, height } = tagLegendLayout('Life cycle stage', STAGES, 500)
    expect(rows).toBeGreaterThan(1)
    expect(height).toBe(22 + (rows - 1) * 13)
    for (const p of pieces) expect(pieceEnd(p), p.text).toBeLessThanOrEqual(500)
    const values = pieces.filter((p) => p.colour !== undefined)
    expect(values.map((p) => p.text)).toEqual(STAGES)
    // Every row starts at the same place, after the family's name.
    expect(
      new Set(values.filter((p, i) => i === 0 || p.row !== values[i - 1].row).map((p) => p.x)).size
    ).toBe(1)
    // Within a row, no name reaches the next swatch.
    for (let i = 1; i < values.length; i++)
      if (values[i].row === values[i - 1].row) expect(pieceEnd(values[i - 1])).toBeLessThan(values[i].x)
  })

  it('gives a long family name a row of its own and cuts what no row can hold', () => {
    const long = tagLegendLayout('A very long family name for the colouring', ['x'.repeat(200)], 150)
    expect(long.pieces[0].row).toBe(0)
    expect(long.pieces[1]).toMatchObject({ row: 1, x: 0 })
    for (const p of long.pieces) expect(pieceEnd(p)).toBeLessThanOrEqual(150)
    expect(long.pieces[1].text.endsWith('…')).toBe(true)
  })

  it('counts what four rows cannot hold instead of drawing it', () => {
    const many = Array.from({ length: 60 }, (_, i) => `Stage ${i + 1}: secondary packaging line`)
    const { pieces, rows } = tagLegendLayout('Stage', many, 400)
    expect(rows).toBe(4)
    const count = pieces[pieces.length - 1]
    expect(count.colour).toBeUndefined()
    const shown = pieces.filter((p) => p.colour !== undefined).length
    expect(count.text).toBe(`+ ${many.length - shown}`)
    for (const p of pieces) expect(pieceEnd(p)).toBeLessThanOrEqual(400)
  })

  it('makes the drawing taller, never wider, for every row it takes', () => {
    const tagged = (values: string[]): SystemModelData => ({
      nodes: values.map((value, i) => ({
        id: `p${i}`,
        name: `Process ${i}`,
        location: 'DE',
        unit: 'kg',
        external: false,
        share: null,
        folded: 0,
        tags: [{ dimension: 'Stage', value }]
      })),
      edges: values
        .slice(1)
        .map((_, i) => ({ source: `p${i + 1}`, target: 'p0', amount: 1, unit: 'kg', share: null }))
    })
    const size = (svg: string) =>
      svg
        .match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/)!
        .slice(1)
        .map(Number)
    const opts = { colourBy: 'tag:Stage', lang: 'en' }
    const few = systemModelSvg(tagged(STAGES.slice(0, 2)), opts, PRISM_PALETTE, figureInk(false))!
    const all = systemModelSvg(tagged(STAGES.slice(0, 8)), opts, PRISM_PALETTE, figureInk(false))!
    const [fewWidth] = size(few)
    const [allWidth, allHeight] = size(all)
    // Two tiers, as wide for eight inputs as for two; the eight names wrap instead of running off.
    expect(allWidth).toBe(fewWidth)
    const x0 = Number(all.match(/viewBox="([-\d.]+)/)![1])
    for (const m of all.matchAll(/<text x="([-\d.]+)"[^>]*font-size="7.5"[^>]*>([^<]*)<\/text>/g))
      expect(Number(m[1]) + textWidth(m[2], 7.5), m[2]).toBeLessThanOrEqual(x0 + allWidth)
    expect(allHeight).toBeGreaterThan(
      size(systemModelSvg(tagged(STAGES.slice(0, 8)), { lang: 'en' }, PRISM_PALETTE, figureInk(false))!)[1] +
        22
    )
  })
})
