import { describe, expect, it } from 'vitest'
import { weighBom } from './bomBalance'
import { parseRecipeAnswer, type RecipeRequest } from './bomRecipe'
import { inciEntries, listNames } from './inciOrder'
import { weighRecipe } from './recipeBalance'

/**
 * A cosmetic's recipe held against the order of its INCI list, on answers built the way a recipe leg writes them.
 * The first case is the liquid soap of the mid-November test series (T9): the recipe had the glycerin at 2 % and the
 * betaine at 1.05 %, the label lists the betaine first.
 */
const weigh = (answer: unknown, request: RecipeRequest = {}) =>
  weighRecipe(parseRecipeAnswer(answer), { of: 'liquid soap', request })

const PCC = 'https://pcc.example/frame-formulations.pdf'
const SLES = (amount: number) => ({
  name: 'SLES 27 % solution',
  amount,
  unit: '%',
  trade_form: {
    constituents: [
      { name: 'sodium laureth sulfate', pct: 27 },
      { name: 'water', pct: 73 }
    ]
  }
})
const CAPB = (amount: number) => ({
  name: 'CAPB 30 % solution',
  amount,
  unit: '%',
  trade_form: {
    constituents: [
      { name: 'cocamidopropyl betaine', pct: 30 },
      { name: 'sodium chloride', pct: 5 },
      { name: 'water', pct: 65 }
    ]
  }
})
const LABEL = [
  'Aqua',
  'Sodium Laureth Sulfate',
  'Sodium Chloride',
  'Cocamidopropyl Betaine',
  'Glycerin',
  'Parfum',
  'Sodium Benzoate'
]

describe('the recipe against the order of the INCI list', () => {
  it('names the T9 soap: glycerin at 2 % stands after the betaine at 1.05 % — beside the balance, not in it', () => {
    const r = weigh(
      {
        formulation: { name: 'Liquid soap MP-01', kind: 'frame', source_url: PCC },
        lines: [
          { name: 'Aqua', inci: 'Aqua', amount: null, unit: '%', rest_to_total: true },
          SLES(30),
          CAPB(3.5),
          { name: 'Glycerin', amount: 2, unit: '%' },
          { name: 'Sodium Chloride', amount: 2.5, unit: '%' }
        ]
      },
      { inci_list: LABEL, mass_kg: 0.5 }
    )
    const order = r.block.inci_order!
    // After the trade forms are taken apart, per substance: the water of both solutions joins the water added
    // (62 + 21.9 + 2.275), the salt of the betaine solution joins the salt dosed (2.5 + 0.175).
    expect(order.compared).toBe(5)
    expect(order.contradictions).toEqual([
      {
        listed_first: {
          inci: 'Cocamidopropyl Betaine',
          position: 4,
          share_pct: 1.05,
          lines: ['CAPB 30 % solution']
        },
        listed_later: { inci: 'Glycerin', position: 5, share_pct: 2, lines: ['Glycerin'] }
      }
    ])
    expect(order.note).toBe(
      'One contradiction with the order of the INCI list: Cocamidopropyl Betaine (no. 4) is listed before ' +
        'Glycerin (no. 5), but the recipe gives 1.05 % against 2 %.'
    )
    expect(r.sentence).toMatch(
      /Its shares contradict the order of the INCI list you passed: Cocamidopropyl Betaine \(no\. 4\) is listed before Glycerin \(no\. 5\), but the recipe gives 1\.05 % against 2 % — as it stands, it does not fit this product as labelled; say so to the user\. It may still serve as a stand-in: do not adjust its amounts or research again for this alone \(the balance does not depend on it\)\./
    )
    expect(order.list).toBe('passed')
    // Not part of the verdict: the recipe closes, nothing is locked, and the whole balance stands.
    expect(r.block.closes).toBe(true)
    expect(r.lock).toBeUndefined()
    const bom = weighBom([], { recipe: r })
    expect(bom.balance_ok).toBe(true)
    expect(bom.summary).toMatch(/Its shares contradict the order of the INCI list you passed/)
    expect(bom.recipe?.inci_order?.contradictions).toHaveLength(1)
  })

  it('takes the water of every contribution together, whatever name the datasheet gives it', () => {
    // Added alone, the water (10 %) would stand lighter than the glycerin listed after it.
    const r = weigh(
      {
        formulation: { name: 'x', kind: 'frame', source_url: PCC },
        lines: [
          { name: 'Aqua', amount: 10, unit: '%' },
          SLES(70),
          { name: 'Glycerin', amount: 20, unit: '%' }
        ]
      },
      { inci_list: ['Aqua (Water)', 'Glycerin', 'Sodium Laureth Sulfate'] }
    )
    expect(r.block.inci_order).toMatchObject({ compared: 3, contradictions: [] })
    // No contradiction is not a match: the note says what was not found, not that the recipe fits.
    expect(r.block.inci_order?.note).toBe(
      '3 of its ingredients are certainly above 1 % and named in the INCI list; no certain contradiction with the ' +
        "list's order among them."
    )
    expect(r.sentence).not.toMatch(/INCI/)
  })

  it('leaves ingredients below 1 % out: the label lists them in any order', () => {
    const r = weigh(
      {
        formulation: { name: 'x', kind: 'product', source_url: PCC },
        lines: [
          { name: 'Aqua', amount: 96.4, unit: '%' },
          { name: 'Glycerin', amount: 2, unit: '%' },
          { name: 'Parfum', amount: 0.5, unit: '%' },
          { name: 'Sodium Benzoate', amount: 0.5, unit: '%' },
          { name: 'Citric Acid', amount: 0.6, unit: '%' }
        ]
      },
      { inci_list: ['Aqua', 'Parfum', 'Glycerin', 'Sodium Benzoate', 'Citric Acid'] }
    )
    expect(r.block.inci_order).toMatchObject({ compared: 2, contradictions: [] })
  })

  it('names a range only where its bounds leave no other order', () => {
    const sds = (capb: [number, number]) =>
      weigh(
        {
          formulation: { name: 'SDS section 3', kind: 'product', source_url: 'https://maker.example/sds' },
          lines: [
            { name: 'water', amount: null, unit: '%', range: [60, 80] },
            { name: 'Sodium Laureth Sulfate', unit: '%', range: [12, 25] },
            { name: 'Cocamidopropyl Betaine', amount: capb[0] + 1, unit: '%', range: capb }
          ]
        },
        { inci_list: ['Aqua', 'Cocamidopropyl Betaine', 'Sodium Laureth Sulfate'] }
      ).block.inci_order!
    const refuted = sds([5, 10])
    expect(refuted.contradictions).toEqual([
      {
        listed_first: {
          inci: 'Cocamidopropyl Betaine',
          position: 2,
          share_pct: [5, 10],
          lines: ['Cocamidopropyl Betaine']
        },
        listed_later: {
          inci: 'Sodium Laureth Sulfate',
          position: 3,
          share_pct: [12, 25],
          lines: ['Sodium Laureth Sulfate']
        }
      }
    ])
    expect(refuted.note).toMatch(
      /is listed before Sodium Laureth Sulfate \(no\. 3\), but the recipe gives 5–10 % against 12–25 %/
    )
    // Overlapping bounds leave the label's order possible — and the printed point inside the range does not count.
    expect(sds([5, 15]).contradictions).toEqual([])
  })

  it('lets the unnamed part of a trade form be any listed ingredient — with no composition, or only part of one', () => {
    // An SLES solution is mostly water: the water added (10 %) alone is not the water of the soap.
    const soap = (tradeForm: object) =>
      weigh(
        {
          formulation: { name: 'x', kind: 'product', source_url: PCC },
          lines: [
            { name: 'Aqua', amount: 10, unit: '%' },
            {
              name: 'SLES solution',
              inci: 'Sodium Laureth Sulfate',
              amount: 70,
              unit: '%',
              trade_form: tradeForm
            },
            { name: 'Glycerin', amount: 20, unit: '%' }
          ]
        },
        { inci_list: ['Aqua', 'Glycerin', 'Sodium Laureth Sulfate'] }
      ).block.inci_order!
    const none = soap({ name: 'SLES solution' })
    expect(none.contradictions).toEqual([])
    expect(none.note).toMatch(/^\d+ of its ingredients are certainly above 1 % .*no certain contradiction/)
    expect(none.note).not.toMatch(/no reading|stand in the list's order/)
    expect(none.note).toMatch(
      /Trade forms not stated in full could hold any listed ingredient in their unnamed part, so a contradiction is named only where it is wider than 70 %: SLES solution \(up to 70 %\)\./
    )
    const active = soap({ constituents: [{ name: 'sodium laureth sulfate', pct: 27 }] })
    expect(active.contradictions).toEqual([])
    expect(active.note).toMatch(/wider than 51\.1 %: SLES solution \(up to 51\.1 %\)/)
    // A contradiction wider than all of the unnamed mass is still named.
    const wide = weigh(
      {
        formulation: { name: 'x', kind: 'product', source_url: PCC },
        lines: [
          { name: 'Aqua', amount: 85, unit: '%' },
          { name: 'CAPB solution', amount: 3, unit: '%', trade_form: { name: 'CAPB solution' } },
          { name: 'Glycerin', amount: 2, unit: '%' },
          { name: 'Sodium Laureth Sulfate', amount: 10, unit: '%' }
        ]
      },
      { inci_list: ['Aqua', 'Glycerin', 'Sodium Laureth Sulfate', 'Cocamidopropyl Betaine'] }
    ).block.inci_order!
    expect(wide.contradictions.map((c) => [c.listed_first.inci, c.listed_later.inci])).toEqual([
      ['Glycerin', 'Sodium Laureth Sulfate']
    ])
    // With no share at all, the unnamed mass has no bound, and nothing can be named.
    const unbounded = weigh(
      {
        formulation: { name: 'x', kind: 'product', source_url: PCC },
        lines: [
          { name: 'Aqua', amount: 85, unit: '%' },
          { name: 'CAPB solution', amount: null, unit: '%', trade_form: { name: 'CAPB solution' } },
          { name: 'Glycerin', amount: 2, unit: '%' },
          { name: 'Sodium Laureth Sulfate', amount: 10, unit: '%' }
        ]
      },
      { inci_list: ['Aqua', 'Glycerin', 'Sodium Laureth Sulfate'] }
    ).block.inci_order!
    expect(unbounded.contradictions).toEqual([])
    expect(unbounded.note).toMatch(/so no contradiction can be named: CAPB solution \(no share\)/)
  })

  it('moves the rest with the ranges of the other lines', () => {
    const lotion = (glycerin: [number, number]) =>
      weigh(
        {
          formulation: { name: 'x', kind: 'frame', source_url: PCC },
          lines: [
            { name: 'Aqua', unit: '%', rest_to_total: true },
            { name: 'Propylene Glycol', amount: 40, unit: '%' },
            { name: 'Glycerin', amount: 30, unit: '%', range: glycerin }
          ]
        },
        { inci_list: ['Aqua', 'Propylene Glycol', 'Glycerin'] }
      ).block.inci_order!
    // Glycerin anywhere in 5–30 leaves the water anywhere in 30–55: the label's order is possible.
    const wide = lotion([5, 30])
    expect(wide.contradictions).toEqual([])
    // Some readings (glycerin at 30, water at 30) still turn the order: the note claims no certainty either way.
    expect(wide.note).toMatch(/no certain contradiction with the list's order among them\.$/)
    expect(wide.note).not.toMatch(/no reading|stand in the list's order/)
    // At 25–30 the water stays at 30–35, below the propylene glycol listed after it.
    expect(lotion([25, 30]).contradictions).toEqual([
      {
        listed_first: { inci: 'Aqua', position: 1, share_pct: [30, 35], lines: ['Aqua'] },
        listed_later: { inci: 'Propylene Glycol', position: 2, share_pct: 40, lines: ['Propylene Glycol'] }
      }
    ])
  })

  it('moves every share of a recipe without a stated total with the ranges in it', () => {
    const r = weigh(
      {
        formulation: { name: 'Home-made shower gel', kind: 'frame', source_url: PCC },
        lines: [
          { name: 'Water', amount: 700, unit: 'g' },
          { name: 'Sodium Laureth Sulfate', amount: 200, unit: 'g', range: [150, 250] },
          { name: 'Glycerin', amount: 100, unit: 'g' }
        ]
      },
      { inci_list: ['Aqua', 'Glycerin', 'Sodium Laureth Sulfate'] }
    )
    expect(r.block.shares_from).toBe('sum_of_lines')
    expect(r.block.inci_order?.contradictions).toEqual([
      {
        listed_first: { inci: 'Glycerin', position: 2, share_pct: [9.524, 10.53], lines: ['Glycerin'] },
        listed_later: {
          inci: 'Sodium Laureth Sulfate',
          position: 3,
          share_pct: [15.79, 23.81],
          lines: ['Sodium Laureth Sulfate']
        }
      }
    ])
  })

  it('places a name at its own entry, never at one that merely shares a part of it', () => {
    const r = weigh(
      {
        formulation: { name: 'x', kind: 'product', source_url: PCC },
        lines: [
          { name: 'Aqua', amount: 77, unit: '%' },
          { name: 'Glycerin', amount: 10, unit: '%' },
          { name: 'Dimethicone/Vinyl Dimethicone Crosspolymer', amount: 8, unit: '%' },
          { name: 'Dimethicone', amount: 5, unit: '%' }
        ]
      },
      {
        inci_list: ['Water/Aqua/Eau', 'Glycerin', 'Dimethicone/Vinyl Dimethicone Crosspolymer', 'Dimethicone']
      }
    )
    expect(r.block.inci_order).toMatchObject({ compared: 4, contradictions: [] })
    // A label's alias for water is water; a crosspolymer is not its monomer.
    expect(r.block.inci_order?.unplaced).toBeUndefined()
  })

  it('gives the rest that carries a line dosed without an amount no lower bound', () => {
    const soap = (qs: boolean) =>
      weigh(
        {
          formulation: { name: 'Example 89', kind: 'frame', source_url: 'https://patents.example/89' },
          lines: [
            { name: 'Aqua', unit: '%', rest_to_total: true },
            { name: 'Sodium Laureth Sulfate', amount: 12, unit: '%' },
            { name: 'Glycerin', amount: 3, unit: '%' },
            ...(qs ? [{ name: 'Citric Acid', amount: null, unit: '%', note: 'ad pH 5.0' }] : [])
          ]
        },
        { inci_list: ['Sodium Laureth Sulfate', 'Aqua', 'Glycerin', 'Citric Acid'] }
      ).block.inci_order!
    // Without the q.s. line the rest is the water's own 85 %, and a label that puts the surfactant first is wrong.
    expect(soap(false).contradictions.map((c) => [c.listed_first.inci, c.listed_later.inci])).toEqual([
      ['Sodium Laureth Sulfate', 'Aqua']
    ])
    // With it, the 85 % hold the citric acid too: the water's share is known only from above.
    expect(soap(true)).toMatchObject({ compared: 2, contradictions: [] })
  })

  it('names what it could not place in the list, and the gap of a recipe that does not close', () => {
    const r = weigh(
      {
        formulation: { name: 'Traditional liquid soap MP-01', kind: 'frame', source_url: PCC },
        lines: [
          { name: 'water', amount: 73.9, unit: '%' },
          { name: 'surfactants', amount: 11.67, unit: '%' },
          { name: 'glycerin', amount: 2.0, unit: '%' },
          { name: 'additives', amount: 3.55, unit: '%' }
        ]
      },
      { inci_list: ['Aqua', 'Sodium Laureth Sulfate', 'Cocamidopropyl Betaine', 'Glycerin'] }
    )
    expect(r.block.inci_order).toMatchObject({
      compared: 2,
      contradictions: [],
      unplaced: ['surfactants 11.67 %', 'additives 3.55 %']
    })
    expect(r.block.inci_order?.note).toMatch(
      /Not in the list under the names the recipe uses, so in no comparison: surfactants 11\.67 %, additives 3\.55 %\. The 8\.88 % the recipe leaves unaccounted is in no comparison\./
    )
  })

  it('runs only on a list passed as an INCI list, and only on a recipe with shares', () => {
    const lines = [
      { name: 'Aqua', amount: 90, unit: '%' },
      { name: 'Glycerin', amount: 2, unit: '%' },
      { name: 'Cocamidopropyl Betaine', amount: 8, unit: '%' }
    ]
    const answer = { formulation: { name: 'x', kind: 'frame', source_url: PCC }, lines }
    // The same names as known ingredients are covered, never ordered.
    expect(
      weigh(answer, { ingredients: ['Aqua', 'Glycerin', 'Cocamidopropyl Betaine'] }).block.inci_order
    ).toBeUndefined()
    expect(weigh(answer).block.inci_order).toBeUndefined()
    expect(
      weigh(answer, { inci_list: ['Aqua', 'Glycerin', 'Cocamidopropyl Betaine'] }).block.inci_order
        ?.contradictions
    ).toHaveLength(1)
    const mixed = weigh(
      {
        formulation: { name: 'x', source_url: PCC },
        lines: [
          { name: 'Aqua', amount: 50, unit: '%' },
          { name: 'Glycerin', amount: 0.5, unit: 'kg' }
        ]
      },
      { inci_list: ['Aqua', 'Glycerin'] }
    )
    expect(mixed.block.inci_order).toEqual({
      compared: 0,
      contradictions: [],
      note: 'Not compared: the recipe gives no shares of the mixture.',
      list: 'passed'
    })
  })

  it("places a trade form's constituent by the INCI name the leg wrote, before its datasheet name", () => {
    // 2 % glycerin dosed and 7 % in a blend whose datasheet says "glycerol": 9 % against 7 % SLES, in the order.
    const blend = (inci?: string) =>
      weigh(
        {
          formulation: { name: 'x', kind: 'frame', source_url: PCC },
          lines: [
            { name: 'Aqua', amount: 84, unit: '%' },
            { name: 'Glycerin', amount: 2, unit: '%' },
            {
              name: 'Glycerin/SLES blend',
              amount: 14,
              unit: '%',
              trade_form: {
                constituents: [
                  { name: 'glycerol', pct: 50, ...(inci ? { inci } : {}) },
                  { name: 'sodium laureth sulfate', pct: 50 }
                ]
              }
            }
          ]
        },
        { inci_list: ['Aqua', 'Glycerin', 'Sodium Laureth Sulfate'] }
      ).block.inci_order!
    expect(blend('Glycerin')).toMatchObject({ compared: 3, contradictions: [] })
    expect(blend('Glycerin').unplaced).toBeUndefined()
    // Without it the datasheet's name places nothing, and the dosed 2 % alone stands against the 7 %.
    expect(blend().unplaced).toEqual(['glycerol (in Glycerin/SLES blend) 7 %'])
    expect(blend().contradictions).toHaveLength(1)
  })

  it('reads a list sent as one string, without splitting "1,2-Hexanediol"', () => {
    expect(inciEntries(['Aqua, Glycerin, 1,2-Hexanediol,Parfum'])).toEqual([
      'Aqua',
      'Glycerin',
      '1,2-Hexanediol',
      'Parfum'
    ])
    // The covered names follow the same reading.
    const r = weigh(
      {
        formulation: { name: 'x', kind: 'frame', source_url: PCC },
        lines: [
          { name: 'Aqua', amount: 97, unit: '%' },
          { name: 'Glycerin', amount: 2, unit: '%' },
          { name: '1,2-Hexanediol', amount: 1, unit: '%' }
        ]
      },
      { inci_list: ['Aqua, Glycerin, 1,2-Hexanediol, Parfum'] }
    )
    expect(r.block.missing_ingredients).toEqual(['Parfum'])
    expect(r.block.inci_order).toMatchObject({ compared: 2, contradictions: [] })
  })
})

/**
 * Colourants (Regulation (EC) No 1223/2009, Art. 19(1)(g)): a label may list them after the other ingredients whatever
 * their amount, and a product sold in several shades every colourant of the range behind "+/-" or "may contain".
 */
describe('colourants and the "may contain" part of the INCI list', () => {
  const FOUNDATION = (pigment: { name: string; inci?: string }) => ({
    formulation: { name: 'Liquid foundation F-12', kind: 'frame', source_url: PCC },
    lines: [
      { name: 'Aqua', amount: null, unit: '%', rest_to_total: true },
      { name: 'Cyclopentasiloxane', amount: 12, unit: '%' },
      { name: 'Dimethicone', amount: 3, unit: '%' },
      { name: 'Glycerin', amount: 2, unit: '%' },
      { ...pigment, amount: 5, unit: '%' },
      { name: 'Iron oxides (yellow)', inci: 'CI 77492', amount: 1.5, unit: '%' },
      { name: 'Phenoxyethanol', amount: 0.8, unit: '%' }
    ]
  })
  const OILS = ['Aqua', 'Cyclopentasiloxane', 'Dimethicone', 'Glycerin', 'Phenoxyethanol']
  const OILS_COMPARED =
    '4 of its ingredients are certainly above 1 % and named in the INCI list; no certain contradiction with the ' +
    "list's order among them."
  const SET_ASIDE =
    'Not compared, as a label may list colourants after the other ingredients whatever their amount (a shade ' +
    'range\'s behind "+/-" or "may contain"): '

  it('sets aside the titanium dioxide at 5 % listed as CI 77891 after the glycerin at 2 %, and says so', () => {
    const r = weigh(FOUNDATION({ name: 'Titanium dioxide', inci: 'CI 77891' }), {
      inci_list: [...OILS, 'CI 77891', 'CI 77492', 'CI 77491'],
      mass_kg: 0.03
    })
    const order = r.block.inci_order!
    expect(order).toMatchObject({ compared: 4, contradictions: [] })
    expect(order.unplaced).toBeUndefined()
    expect(order.note).toBe(`${OILS_COMPARED} ${SET_ASIDE}CI 77891 (no. 6) 5 %, CI 77492 (no. 7) 1.5 %.`)
    expect(r.sentence).not.toMatch(/INCI/)
    // A colourant printed without "may contain" is in the product: one the recipe lacks is still reported.
    expect(r.block.missing_ingredients).toEqual(['CI 77491'])
  })

  it('holds a name without a CI number to the order: titanium dioxide as a UV filter is no colourant', () => {
    const order = weigh(FOUNDATION({ name: 'Titanium Dioxide' }), {
      inci_list: [...OILS, 'Titanium Dioxide', 'CI 77492']
    }).block.inci_order!
    expect(order.compared).toBe(5)
    expect(order.contradictions.map((c) => [c.listed_first.inci, c.listed_later.inci])).toEqual([
      ['Dimethicone', 'Titanium Dioxide'],
      ['Glycerin', 'Titanium Dioxide']
    ])
    expect(order.note).toContain(`${SET_ASIDE}CI 77492 (no. 7) 1.5 %.`)
  })

  it('sets aside everything behind "+/-", names its entries without the marker, and never reports them missing', () => {
    const answer = FOUNDATION({ name: 'Titanium dioxide', inci: 'CI 77891' })
    answer.lines.splice(4, 0, { name: 'Mica', amount: 4, unit: '%' })
    // Sent as one string, the marker and the bracket sit inside entries: "Phenoxyethanol [+/- Mica", "CI 77491]".
    const r = weigh(answer, {
      inci_list: [`${OILS.join(', ')} [+/- Mica, CI 77891, CI 77492, CI 77491, CI 77499]`]
    })
    const order = r.block.inci_order!
    expect(order).toMatchObject({ compared: 4, contradictions: [] })
    expect(order.note).toBe(
      `${OILS_COMPARED} ${SET_ASIDE}Mica (no. 6) 4 %, CI 77891 (no. 7) 5 %, CI 77492 (no. 8) 1.5 %.`
    )
    // A shade need not contain every colourant of its range; the phenoxyethanol before the marker is covered.
    expect(r.block.missing_ingredients).toBeUndefined()
  })

  it('reads the marker however the label prints it: alone, in several languages, as "may contain"', () => {
    const answer = FOUNDATION({ name: 'Titanium dioxide', inci: 'CI 77891' })
    answer.lines.splice(4, 0, { name: 'Mica', amount: 4, unit: '%' })
    // The last three as a model passed them, the marker before every entry.
    const each = (marker: string) => ['Mica', 'CI 77891', 'CI 77492'].map((n) => `${marker} ${n}`)
    for (const tail of [
      ['+/-', 'Mica', 'CI 77891', 'CI 77492'],
      ['May contain/Peut contenir (+/-): Mica', 'CI 77891', 'CI 77492'],
      ['MAY CONTAIN: Mica', 'CI 77891', 'CI 77492.'],
      ['(±) Mica', 'CI 77891', 'CI 77492'],
      each('+/- MAY CONTAIN:'),
      each('MAY CONTAIN/PEUT CONTENIR/PUEDE CONTENER:'),
      each('[+/-]')
    ]) {
      const r = weigh(answer, { inci_list: [...OILS, ...tail] })
      expect(r.block.inci_order?.note, tail[0]).toBe(
        `${OILS_COMPARED} ${SET_ASIDE}Mica (no. 6) 4 %, CI 77891 (no. 7) 5 %, CI 77492 (no. 8) 1.5 %.`
      )
      expect(r.block.missing_ingredients, tail[0]).toBeUndefined()
    }
  })

  it('reads the names of the list without their markers, and keeps the colon of a lake', () => {
    expect(
      listNames(['Glycerin', 'Phenoxyethanol [+/- Mica', 'C.I. 15850:1', 'Iron Oxides (CI 77491)]'])
    ).toEqual([
      { name: 'Glycerin', colourant: false, may: false },
      { name: 'Phenoxyethanol', colourant: false, may: false },
      { name: 'Mica', colourant: false, may: true },
      { name: 'C.I. 15850:1', colourant: true, may: true },
      { name: 'Iron Oxides (CI 77491)', colourant: true, may: true }
    ])
    expect(listNames(['May contain: CI 15850:1']).map((n) => n.name)).toEqual(['CI 15850:1'])
    // A heading in another language before the marker is no name; a name before it ends at a full stop.
    const names = (e: string) => listNames(['Glycerin', e]).map((n) => `${n.name}${n.may ? ' (may)' : ''}`)
    expect(names('Peut contenir/May contain (+/-): CI 77891')).toEqual(['Glycerin', 'CI 77891 (may)'])
    expect(names('Peut contenir/Kann enthalten/May contain (+/-) CI 77891')).toEqual([
      'Glycerin',
      'CI 77891 (may)'
    ])
    expect(names('Kann enthalten [+/-]: CI 77891')).toEqual(['Glycerin', 'CI 77891 (may)'])
    expect(names('Phenoxyethanol. Peut contenir/May contain (+/-): CI 77891')).toEqual([
      'Glycerin',
      'Phenoxyethanol',
      'CI 77891 (may)'
    ])
    expect(names('Phenoxyethanol. May contain: CI 77891')).toEqual([
      'Glycerin',
      'Phenoxyethanol',
      'CI 77891 (may)'
    ])
    // In a list sent with the marker before every entry, a heading before it is no name either.
    expect(listNames(['+/- Mica', 'PEUT CONTENIR/MAY CONTAIN: CI 77891']).map((n) => n.name)).toEqual([
      'Mica',
      'CI 77891'
    ])
    // A CI number is a whole number of five digits, not a part of another name.
    expect(listNames(['Acid Red 52', 'CI 123456', 'Polysorbate 20']).some((n) => n.colourant)).toBe(false)
  })

  it('changes nothing where the colourant stays below 1 %: the soap with its blue dye', () => {
    // The T9 soap with a dye at 0.001 %, once under its CI number and once under a name the order would hold.
    const soap = (inci: string) =>
      weigh(
        {
          formulation: { name: 'Liquid soap MP-01', kind: 'frame', source_url: PCC },
          lines: [
            { name: 'Aqua', inci: 'Aqua', amount: null, unit: '%', rest_to_total: true },
            SLES(30),
            CAPB(3.5),
            { name: 'Glycerin', amount: 2, unit: '%' },
            { name: 'Sodium Chloride', amount: 2.5, unit: '%' },
            { name: 'Blue 1', inci, amount: 0.001, unit: '%' }
          ]
        },
        { inci_list: [...LABEL, inci], mass_kg: 0.5 }
      ).block.inci_order!
    const dyed = soap('CI 42090')
    expect(dyed).toEqual(soap('Blue Dye'))
    expect(dyed.contradictions).toHaveLength(1)
    expect(dyed.note).not.toMatch(/colourant/)
  })
})
