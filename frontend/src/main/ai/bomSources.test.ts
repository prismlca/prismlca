import { describe, expect, it } from 'vitest'
import type { BomItem, BomLeg } from './bomAnswer'
import { weighBom } from './bomBalance'
import { parseRecipeAnswer } from './bomRecipe'
import { settleSources } from './bomSources'
import { CitationBook } from './citationBook'
import { weighRecipe } from './recipeBalance'

/**
 * Settling a weighed bill of materials against the pages the search cited: a figure left without a page stays in
 * the sums and is named, apart from whether the parts add up; a page the search never returned is still a source.
 */

const leg = (items: BomItem[]): BomLeg => ({ items, unresolved: [], product_masses: [], versions_seen: [] })
const item = (component: string, mass_kg: number, more: Partial<BomItem> = {}): BomItem => ({
  component,
  material: 'steel',
  mass_kg,
  ...more
})
const DEAD = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/MANGLED'

const book = (...urls: string[]): CitationBook => {
  const b = new CitationBook()
  b.add(urls.map((url) => ({ url })))
  return b
}

describe('settleSources', () => {
  it('keeps a part without a source in the sum, marks it and names it, while the balance still closes', () => {
    const weighed = weighBom(
      [
        { request: 'frame', leg: leg([item('frame', 9, { source_url: 'https://maker.example/frame' })]) },
        { request: 'shelves', leg: leg([item('shelves', 4)]) }
      ],
      { totalMassKg: 13 }
    )
    const s = settleSources(weighed, book('https://maker.example/frame'))
    expect(weighed.balance_ok).toBe(true)
    expect(weighed.sum_kg).toBe(13)
    expect(weighed.items.map((i) => [i.component, i.unsourced])).toEqual([
      ['frame', undefined],
      ['shelves', true]
    ])
    expect(s.all_sourced).toBe(false)
    expect(s.unsourced).toEqual(['shelves'])
    expect(s.sentence).toBe(
      'Not every figure has a source: "shelves" has no usable source — kept in the sums all the same, so whether ' +
        'the parts add up says nothing about it.'
    )
    expect(s.sources).toEqual(['https://maker.example/frame'])
  })

  it('takes the source from a figure whose link leads to no page, and keeps the figure', () => {
    const weighed = weighBom([
      { request: 'frame', leg: leg([item('frame', 9, { source_url: DEAD })]) },
      { request: 'feet', leg: leg([item('feet', 0.4, { source_url: DEAD })]) }
    ])
    const s = settleSources(weighed, book('https://maker.example/other'))
    expect(weighed.items.map((i) => [i.component, i.source_url, i.unsourced])).toEqual([
      ['frame', undefined, true],
      ['feet', undefined, true]
    ])
    expect(weighed.sum_kg).toBe(9.4)
    expect(s.unsourced).toEqual(['frame', 'feet'])
    expect(s.sentence).toMatch(/"frame", "feet" have no usable source — .* says nothing about them\.$/)
    expect(s.notes.join(' ')).toMatch(/2 figures named a search-result link that leads to no page/)
  })

  it('leaves a page the search never returned as a source, marked as today, and adds nothing to the summary', () => {
    const weighed = weighBom([
      { request: 'frame', leg: leg([item('frame', 9, { source_url: 'https://maker.example/frame' })]) }
    ])
    const s = settleSources(weighed, book('https://elsewhere.example/page'))
    expect(weighed.items[0]).toMatchObject({
      source_url: 'https://maker.example/frame',
      cited_by_search: false
    })
    expect(weighed.items[0].unsourced).toBeUndefined()
    expect(s.all_sourced).toBe(true)
    expect(s.unsourced).toBeUndefined()
    expect(s.sentence).toBeUndefined()
    expect(s.notes.join(' ')).toMatch(
      /1 item's source_url was NOT among the pages the search engine returned/
    )
  })

  it('names packaging and ingredients without a source too, an ingredient as one', () => {
    // A formulation without a page: the water it doses has none, the water of the solution has its datasheet's.
    const soap = weighRecipe(
      parseRecipeAnswer({
        formulation: { name: 'MP-01', kind: 'frame' },
        lines: [
          { name: 'water', unit: '%', rest_to_total: true },
          {
            name: 'SLES 27 % solution',
            amount: 30,
            unit: '%',
            trade_form: {
              source_url: 'https://supplier.example/sles27.pdf',
              constituents: [
                { name: 'sodium laureth sulfate', pct: 27 },
                { name: 'water', pct: 73 }
              ]
            }
          }
        ]
      }),
      { of: 'liquid soap', request: { mass_kg: 0.5 } }
    )
    const weighed = weighBom([{ request: 'box', leg: leg([item('box', 0.2, { packaging: 'sales' })]) }], {
      recipe: soap
    })
    const s = settleSources(weighed, book('https://supplier.example/sles27.pdf'))
    expect(s.unsourced).toEqual(['box', 'water (recipe ingredient)'])
  })

  it('names eight and counts the rest, listing them all', () => {
    const parts = Array.from({ length: 10 }, (_, n) => item(`part ${n + 1}`, 1))
    const weighed = weighBom([{ request: null, leg: leg(parts) }])
    const s = settleSources(weighed, new CitationBook())
    expect(s.unsourced).toHaveLength(10)
    expect(s.sentence).toMatch(/"part 8" and 2 more \(see unsourced\) have no usable source/)
  })

  it('says nothing about sources when there is no figure', () => {
    const s = settleSources(weighBom([{ request: 'frame', leg: leg([]) }]), new CitationBook())
    expect(s.all_sourced).toBeUndefined()
    expect(s.sentence).toBeUndefined()
  })
})
