import { describe, expect, it } from 'vitest'
import { parseRecipeAnswer, type RecipeRequest } from './bomRecipe'
import { weighRecipe } from './recipeBalance'

/**
 * Which list a recipe is held against: the INCI list the caller passed, or else the ingredient list the recipe leg
 * found on the product — only when the leg says it is a cosmetic's label list and its page leads somewhere. The
 * case is the T9 soap: nobody named the brand, the research found the product and its label list at a retailer.
 */
const weigh = (answer: unknown, request: RecipeRequest = {}, page?: (url: string) => string | undefined) =>
  weighRecipe(parseRecipeAnswer(answer), { of: 'liquid soap', request, ...(page ? { page } : {}) })

const PCC = 'https://pcc.example/frame-formulations.pdf'
const DM = 'https://www.dm.example/p/d/3038087/'
const LABEL = [
  'Aqua',
  'Sodium Laureth Sulfate',
  'Sodium Chloride',
  'Cocamidopropyl Betaine',
  'Glycerin',
  'Parfum',
  'Glyceryl Oleate'
]
const frame = (declared?: unknown) => ({
  formulation: { name: 'Liquid soap MP-01', kind: 'frame', source_url: PCC },
  lines: [
    { name: 'Aqua', inci: 'Aqua', amount: null, unit: '%', rest_to_total: true },
    { name: 'Sodium Laureth Sulfate', amount: 8, unit: '%' },
    { name: 'Sodium Chloride', amount: 2.5, unit: '%' },
    { name: 'Cocamidopropyl Betaine', amount: 1.05, unit: '%' },
    { name: 'Glycerin', amount: 2, unit: '%' }
  ],
  ...(declared ? { declared_ingredients: declared } : {})
})
const found = {
  names: LABEL,
  kind: 'inci',
  product: 'Balea Liquid Soap Eucalyptus & Lotus, 500 ml',
  source_url: DM
}

describe('the INCI list the recipe leg finds', () => {
  it("holds the recipe against a label list it found, naming that list's product and page", () => {
    const r = weigh(frame(found))
    const order = r.block.inci_order!
    expect(order).toMatchObject({
      list: 'found',
      product: 'Balea Liquid Soap Eucalyptus & Lotus, 500 ml',
      source_url: DM,
      compared: 5
    })
    expect(order.contradictions.map((c) => [c.listed_first.inci, c.listed_later.inci])).toEqual([
      ['Cocamidopropyl Betaine', 'Glycerin']
    ])
    // Named as the list the research found, for the product it found — whether that is the user's is open.
    expect(r.sentence).toMatch(
      /Its shares contradict the order of the INCI list the research found for "Balea Liquid Soap Eucalyptus & Lotus, 500 ml" \(dm\.example\): Cocamidopropyl Betaine \(no\. 4\) is listed before Glycerin \(no\. 5\), but the recipe gives 1\.05 % against 2 % — if that is the user's product, this is not its recipe as labelled; say so to the user\. It may still serve as a stand-in/
    )
    // Still covered as before, and still outside the verdict.
    expect(r.block.missing_ingredients).toEqual(['Parfum', 'Glyceryl Oleate'])
    expect(r.block.declared_source).toBe(DM)
    expect(r.block.closes).toBe(true)
    expect(r.lock).toBeUndefined()
  })

  it('compares no list the leg did not mark as a label list, or whose page leads nowhere — covers it all the same', () => {
    const other = weigh(frame({ ...found, kind: 'other' }))
    const unsaid = weigh(frame({ names: LABEL, source_url: DM }))
    const bare = weigh(frame(LABEL))
    const sourceless = weigh(frame({ ...found, source_url: undefined }))
    const dead = weigh(frame(found), {}, () => undefined)
    for (const r of [other, unsaid, bare, sourceless, dead]) {
      expect(r.block.inci_order).toBeUndefined()
      expect(r.sentence).not.toMatch(/INCI list/)
      expect(r.block.missing_ingredients).toEqual(['Parfum', 'Glyceryl Oleate'])
    }
    // A kind the leg wrote in capitals is still its word.
    expect(weigh(frame({ ...found, kind: 'INCI' })).block.inci_order?.list).toBe('found')
  })

  it('takes the list the caller passed instead of the one found — for the order and for the coverage', () => {
    // The found list is of an older version: a preservative more, glycerin before the betaine.
    const older = {
      ...found,
      names: [
        'Aqua',
        'Sodium Laureth Sulfate',
        'Sodium Chloride',
        'Glycerin',
        'Cocamidopropyl Betaine',
        'Phenoxyethanol'
      ]
    }
    const r = weigh(frame(older), { inci_list: LABEL })
    expect(r.block.inci_order).toMatchObject({ list: 'passed' })
    expect(r.block.inci_order?.product).toBeUndefined()
    expect(r.block.inci_order?.contradictions).toHaveLength(1)
    expect(r.sentence).toMatch(/contradict the order of the INCI list you passed/)
    // The older list's extra ingredient is not "known from the product", and its page is not the list's source.
    expect(r.block.missing_ingredients).toEqual(['Parfum', 'Glyceryl Oleate'])
    expect(r.block.declared_source).toBeUndefined()
  })

  it('reads the kind, the product and the INCI names of trade-form constituents from the answer', () => {
    const leg = parseRecipeAnswer({
      formulation: { name: 'x', source_url: PCC },
      lines: [
        {
          name: 'Glycerin/SLES blend',
          amount: 14,
          unit: '%',
          trade_form: {
            constituents: [
              { name: 'glycerol', inci: 'Glycerin', pct: 50 },
              { name: 'sodium laureth sulfate', pct: 50 }
            ]
          }
        }
      ],
      declared_ingredients: { names: LABEL, kind: 'label', product: '  ', source_url: DM }
    })
    expect(leg.lines[0].trade_form?.constituents).toEqual([
      { name: 'glycerol', inci: 'Glycerin', pct: 50 },
      { name: 'sodium laureth sulfate', pct: 50 }
    ])
    // A kind outside the two words is no kind; an empty product is none.
    expect(leg.declared).toEqual({ names: LABEL, source_url: DM })
  })
})
