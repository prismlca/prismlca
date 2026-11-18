import { describe, expect, it } from 'vitest'
import type { BomItem, BomLeg } from './bomAnswer'
import { weighBom, type LegOutcome } from './bomBalance'
import { parseRecipeAnswer } from './bomRecipe'
import { weighRecipe } from './recipeBalance'

/**
 * A mixture's own check, on answers built the way a recipe leg writes them. The first case is the liquid soap of
 * the mid-November test series (T9): four ingredients, four sources, 91.1 % — each figure sourced, the whole not a
 * recipe. The rest are the shapes a recipe takes in the sources: a frame formulation with "water ad 100", a booklet
 * of several recipes, trade forms with and without a datasheet, a safety data sheet's ranges, a concrete per m3.
 */
const weigh = (answer: unknown, request: { of?: string; mass_kg?: number; ingredients?: string[] } = {}) =>
  weighRecipe(parseRecipeAnswer(answer), { of: request.of ?? 'liquid soap', request })

const PCC = 'https://pcc.example/frame-formulations.pdf'

describe('weighRecipe', () => {
  it('reports the T9 soap pieced together from four sources as a gap, and takes no rest', () => {
    const r = weigh(
      {
        formulation: { name: 'Traditional liquid soap MP-01', kind: 'frame', source_url: PCC },
        lines: [
          {
            name: 'water',
            amount: 73.9,
            unit: '%',
            rest_to_total: true,
            other_recipe: 'free water of a foam soap',
            source_url: 'https://foam.example/soap'
          },
          {
            name: 'surfactants',
            amount: 11.67,
            unit: '%',
            other_recipe: 'JRC base case 2012',
            source_url: 'https://jrc.example/eu'
          },
          { name: 'glycerin', amount: 2.0, unit: '%', source_url: 'https://three.example/recipes' },
          { name: 'additives', amount: 3.55, unit: '%' }
        ]
      },
      { mass_kg: 0.51 }
    )
    expect(r.block.closes).toBe(false)
    expect(r.block.gap_pct).toBe(8.88)
    expect(r.block.gap_kg).toBeCloseTo(0.045288, 6)
    expect(r.block.closes_note).toMatch(
      /lines from other sources are mixed in — the rest of a pieced-together recipe/
    )
    expect(r.block.lines.filter((l) => l.other_source).map((l) => l.name)).toEqual([
      'water',
      'surfactants',
      'glycerin'
    ])
    expect(r.lock).toMatch(/does not close: 8\.88 % \(0\.045288 kg\) unaccounted/)
    expect(r.sentence).toMatch(/frame formulation, not this product's own/)
    expect(r.items.reduce((s, i) => s + i.mass_kg, 0)).toBeCloseTo(0.464712, 6)
  })

  it('closes a frame formulation by its own "water ad 100" line and splits trade forms only by their datasheet', () => {
    const r = weigh(
      {
        formulation: { name: 'Liquid soap MP-01', kind: 'frame', source_url: PCC, table: 'p. 12' },
        lines: [
          { name: 'water', amount: null, unit: '%', rest_to_total: true },
          {
            name: 'SLES 27 % solution',
            inci: 'SODIUM LAURETH SULFATE',
            amount: 30,
            unit: '%',
            trade_form: {
              source_url: 'https://supplier.example/sles27.pdf',
              constituents: [
                { name: 'sodium laureth sulfate', pct: 27 },
                { name: 'water', pct: 73 }
              ]
            }
          },
          { name: 'glycerin', amount: 2, unit: '%' },
          { name: 'sodium chloride', amount: 1.5, unit: '%' }
        ]
      },
      { mass_kg: 0.5 }
    )
    expect(r.block.closes).toBe(true)
    expect(r.block.gap_pct).toBe(0)
    expect(r.lock).toBeUndefined()
    expect(r.block.lines[0]).toMatchObject({ name: 'water', amount: 66.5, unit: '%', share_pct: 66.5 })
    expect(r.block.split).toEqual(['SLES 27 % solution'])
    // Booked as its constituents, never besides them: water added and water of the solution are two contributions.
    expect(r.items.map((i) => [i.component, i.mass_kg, i.from_trade_form])).toEqual([
      ['water', 0.3325, undefined],
      ['sodium laureth sulfate', 0.0405, 'SLES 27 % solution'],
      ['water', 0.1095, 'SLES 27 % solution'],
      ['glycerin', 0.01, undefined],
      ['sodium chloride', 0.0075, undefined]
    ])
    expect(r.items.every((i) => i.group === 'recipe')).toBe(true)
    expect(r.items.reduce((s, i) => s + i.mass_kg, 0)).toBeCloseTo(0.5, 9)
  })

  it('names a line taken from another recipe of the same booklet, and takes no rest beside it', () => {
    const r = weigh({
      formulation: { name: 'MP-01', kind: 'frame', source_url: PCC },
      lines: [
        { name: 'water', unit: '%', rest_to_total: true },
        { name: 'SLES 70 %', amount: 12, unit: '%' },
        { name: 'cocamide DEA', amount: 3, unit: '%', other_recipe: 'RD-01', source_url: PCC }
      ]
    })
    expect(r.block.lines[2].other_source).toBe('RD-01')
    expect(r.block.lines[0].amount).toBeUndefined()
    expect(r.block.closes).toBeNull()
    expect(r.block.closes_note).toMatch(/1 line has no amount \(water\).*pieced-together/)
  })

  // A live run wrote a remark into "other_recipe"; a review then showed that reading such text as a remark also lets
  // a real second recipe through ("Glycerin soap RD-01" on the glycerin line). Only the formulation's own name counts.
  it('reads every "other recipe" but the formulation itself as a second source, and takes no rest beside it', () => {
    const r = weigh(
      {
        formulation: { name: 'Traditionelle Flüssigseife [MP-01]', kind: 'frame', source_url: PCC },
        lines: [
          { name: 'Aqua', unit: '%', rest_to_total: true },
          {
            name: 'Sodium Laureth Sulfate',
            amount: 30,
            unit: '%',
            other_recipe: 'traditionelle flüssigseife MP 01'
          },
          { name: 'Glycerin', amount: 2, unit: '%', other_recipe: 'Glycerin soap RD-01' },
          { name: 'CI 19140', unit: '%', other_recipe: 'CI 19140 q.s. (Farbstoff)' }
        ]
      },
      { mass_kg: 0.51 }
    )
    expect(r.block.lines.filter((l) => l.other_source).map((l) => l.name)).toEqual(['Glycerin', 'CI 19140'])
    expect(r.block.lines[0].amount).toBeUndefined()
    expect(r.block.closes).toBeNull()
    expect(r.block.closes_note).toMatch(/pieced-together recipe is no figure/)
  })

  it('splits a betaine solution into the three constituents its datasheet states — the salt is not water', () => {
    const r = weigh(
      {
        formulation: { name: 'Shower gel', kind: 'product', source_url: 'https://maker.example/sds' },
        lines: [
          {
            name: 'CAPB 30 %',
            amount: 10,
            unit: '%',
            trade_form: {
              constituents: [
                { name: 'cocamidopropyl betaine', pct: 30 },
                { name: 'sodium chloride', pct: 5 },
                { name: 'water', pct: 65 }
              ]
            }
          },
          { name: 'water', amount: 90, unit: '%' }
        ]
      },
      { mass_kg: 1 }
    )
    expect(r.items.map((i) => [i.component, i.share_pct])).toEqual([
      ['cocamidopropyl betaine', 3],
      ['sodium chloride', 0.5],
      ['water', 6.5],
      ['water', 90]
    ])
  })

  it('keeps a trade form whose composition is not stated as one line, and one whose constituents do not add up', () => {
    const r = weigh(
      {
        formulation: { name: 'Shower gel', kind: 'product', source_url: 'https://maker.example/sds' },
        lines: [
          { name: 'CAPB solution', amount: 8, unit: '%', trade_form: { name: 'CAPB solution' } },
          {
            name: 'SLES solution',
            amount: 12,
            unit: '%',
            trade_form: { constituents: [{ name: 'sodium laureth sulfate', pct: 27 }] },
            note: 'datasheet gives only the active content'
          },
          { name: 'water', amount: 80, unit: '%' }
        ]
      },
      { mass_kg: 1 }
    )
    expect(r.items.map((i) => [i.component, i.mass_kg])).toEqual([
      ['CAPB solution', 0.08],
      ['SLES solution', 0.12],
      ['water', 0.8]
    ])
    expect(r.items[0].note).toMatch(/composition of the trade form not stated/)
    expect(r.items[1].note).toMatch(/add up to 27 %, not 100 — booked as dosed/)
    expect(r.block.split).toBeUndefined()
    expect(r.block.closes).toBe(true)
  })

  it("reads a safety data sheet's ranges as reachable, never as closed", () => {
    const r = weigh({
      formulation: { name: 'SDS section 3', kind: 'product', source_url: 'https://maker.example/sds' },
      lines: [
        { name: 'water', amount: null, unit: '%', range: [50, 80] },
        { name: 'sodium laureth sulfate', unit: '%', range: [10, 25] },
        { name: 'cocamidopropyl betaine', unit: '%', range: [5, 10] }
      ]
    })
    expect(r.block.closes).toBeNull()
    expect(r.block.reachable_by_ranges).toBe(true)
    expect(r.block.lines.every((l) => l.share_pct === undefined)).toBe(true)
    expect(r.sentence).toMatch(
      /could not be checked for closure: 3 lines have no amount.*Its ranges can reach the total/
    )
  })

  it('names the ingredients known from the product that the recipe lacks', () => {
    const r = weigh(
      {
        formulation: { name: 'MP-01', kind: 'frame', source_url: PCC },
        lines: [
          { name: 'water', inci: 'AQUA', amount: 84, unit: '%' },
          { name: 'SLES 27 %', inci: 'SODIUM LAURETH SULFATE', amount: 14, unit: '%' },
          { name: 'glycerin', amount: 2, unit: '%' }
        ],
        declared_ingredients: {
          names: ['Aqua', 'Sodium Laureth Sulfate', 'Glycerin', 'Glyceryl Oleate', 'Glycol Distearate'],
          source_url: 'https://shop.example/inci'
        }
      },
      { ingredients: ['Sodium Lactate, Betaine'] }
    )
    expect(r.block.closes).toBe(true)
    expect(r.block.missing_ingredients).toEqual([
      'Sodium Lactate',
      'Betaine',
      'Glyceryl Oleate',
      'Glycol Distearate'
    ])
    // Exact names: a betaine is not covered by cocamidopropyl betaine.
    const capb = weigh({
      formulation: { name: 'x', kind: 'frame', source_url: PCC },
      lines: [
        { name: 'Cocamidopropyl Betaine', amount: 10, unit: '%' },
        { name: 'Benzyl Alcohol', amount: 1, unit: '%' },
        { name: 'water', inci: 'Aqua', amount: 89, unit: '%' }
      ],
      declared_ingredients: { names: ['Aqua (Water)', 'Betaine', 'Alcohol', 'Cocamidopropyl Betaine'] }
    })
    expect(capb.block.missing_ingredients).toEqual(['Betaine', 'Alcohol'])
    expect(r.sentence).toMatch(
      /Known from the product but not in it: Sodium Lactate, Betaine, Glyceryl Oleate/
    )
    // Closing at 100 % says nothing about the missing ones: no lock, but named.
    expect(r.lock).toBeUndefined()
    expect(r.sentence).toMatch(/Shares only, no kg: pass recipe.mass_kg/)
  })

  it('closes a concrete in kg per m3 against its stated density, and does not close one without it', () => {
    const lines = [
      { name: 'cement CEM II', amount: 320, unit: 'kg/m3' },
      { name: 'water', amount: 160, unit: 'kg/m³' },
      { name: 'sand 0/4', amount: 800, unit: 'kg' },
      { name: 'gravel 4/16', amount: 1050, unit: 'kg' }
    ]
    const stated = weigh(
      {
        formulation: {
          name: 'C30/37 mix',
          kind: 'frame',
          source_url: 'https://concrete.example/mix',
          batch: '1 m3',
          total: { amount: 2400, unit: 'kg' }
        },
        lines
      },
      { of: 'concrete', mass_kg: 2400 }
    )
    expect(stated.block.closes).toBe(false)
    expect(stated.block.gap_pct).toBe(2.92)
    expect(stated.block.gap_kg).toBe(70)
    expect(stated.block.denominator).toBe('2400 kg, the stated total of 1 m3')
    // The cement's kilograms are what the recipe prints, not stretched to fill the batch.
    expect(stated.items[0].mass_kg).toBe(320)

    const none = weigh(
      {
        formulation: { name: 'C30/37 mix', kind: 'frame', source_url: 'https://concrete.example/mix' },
        lines
      },
      { of: 'concrete', mass_kg: 2330 }
    )
    expect(none.block.closes).toBeNull()
    expect(none.block.closes_note).toMatch(/states no total mass for its batch/)
    expect(none.block.gap_pct).toBeUndefined()
    expect(none.block.shares_from).toBe('sum_of_lines')
    expect(none.lock).toMatch(/could not be checked for closure/)
  })

  // A live run: a concrete's mix design lists its air voids as a volume.
  it('leaves a line printed in a volume out of a closure the mass lines meet, and not out of one they miss', () => {
    const recipe = (cement: number) => ({
      formulation: {
        name: 'Example 2',
        kind: 'frame',
        source_url: 'https://a.example',
        total: { amount: 2335, unit: 'kg' }
      },
      lines: [
        { name: 'cement', amount: cement, unit: 'kg' },
        { name: 'water', amount: 175, unit: 'kg' },
        { name: 'aggregate', amount: 1795, unit: 'kg' },
        { name: 'air voids', amount: 15, unit: 'dm3' }
      ]
    })
    const air = weigh(recipe(365), { of: 'concrete', mass_kg: 2335 })
    expect(air.block.closes).toBe(true)
    expect(air.block.closes_note).toMatch(/not counted, printed in a volume: air voids/)
    const short = weigh(recipe(200), { of: 'concrete' })
    expect(short.block.closes).toBeNull()
  })

  it('reads parts by weight as having no total of their own', () => {
    const r = weigh(
      {
        formulation: { name: 'Tread compound', kind: 'frame', source_url: 'https://rubber.example/tread' },
        lines: [
          { name: 'natural rubber', amount: 100, unit: 'phr' },
          { name: 'carbon black N330', amount: 50, unit: 'phr' },
          { name: 'zinc oxide', amount: 5, unit: 'phr' }
        ]
      },
      { of: 'tread compound', mass_kg: 1.55 }
    )
    expect(r.block.basis).toBe('parts')
    expect(r.block.closes).toBeNull()
    expect(r.block.closes_note).toBe('parts by weight have no total of their own')
    expect(r.items.map((i) => i.mass_kg)).toEqual([1, 0.5, 0.05])
  })

  it('refuses to add up lines in percent beside lines in kilograms', () => {
    const r = weigh({
      formulation: { name: 'x', source_url: 'https://a.example' },
      lines: [
        { name: 'a', amount: 50, unit: '%' },
        { name: 'b', amount: 0.5, unit: 'kg' }
      ]
    })
    expect(r.block.basis).toBe('mixed')
    expect(r.block.closes).toBeNull()
    expect(r.has_shares).toBe(false)
  })

  it('takes no amount from a line printed in volume', () => {
    const r = weigh({
      formulation: { name: 'x', kind: 'product', source_url: 'https://a.example' },
      lines: [
        { name: 'ethanol', amount: 40, unit: '% v/v' },
        { name: 'water', amount: 60, unit: '%' }
      ]
    })
    expect(r.block.lines[0]).toMatchObject({
      name: 'ethanol',
      note: expect.stringMatching(/not a mass unit/)
    })
    expect(r.block.lines[0].amount).toBeUndefined()
    expect(r.block.closes).toBeNull()
  })

  it('lets the rest carry a line dosed without an amount, and names it — but not a line with only a range', () => {
    const qs = weigh(
      {
        formulation: { name: 'Example 89', kind: 'frame', source_url: 'https://patents.example/89' },
        lines: [
          { name: 'Aqua', unit: '%', rest_to_total: true, note: 'ad 100' },
          { name: 'Sodium Laureth Sulfate', amount: 5, unit: '%' },
          { name: 'Citric Acid', amount: null, unit: '%', note: 'ad pH 5.0' }
        ]
      },
      { mass_kg: 0.5 }
    )
    expect(qs.block.closes).toBe(true)
    expect(qs.block.lines[0]).toMatchObject({ amount: 95, share_pct: 95 })
    expect(qs.block.closes_note).toMatch(/the rest includes Citric Acid, dosed without an amount/)
    // Booked as what it is: the rest's mass holds the citric acid too, so it is never pure water.
    expect(qs.items.map((i) => [i.component, i.mass_kg])).toEqual([
      ['Aqua + Citric Acid', 0.475],
      ['Sodium Laureth Sulfate', 0.025]
    ])
    expect(qs.block.lines[0].carries).toEqual(['Citric Acid'])

    const sds = weigh({
      formulation: { name: 'SDS', kind: 'product', source_url: 'https://maker.example/sds' },
      lines: [
        { name: 'water', unit: '%', rest_to_total: true },
        { name: 'sodium laureth sulfate', unit: '%', range: [10, 25] }
      ]
    })
    expect(sds.block.closes).toBeNull()
    expect(sds.block.closes_note).toMatch(/other lines give only a range or no mass/)
  })

  it('calls a rest a fault when the other lines already reach the total', () => {
    const r = weigh({
      formulation: { name: 'x', kind: 'product', source_url: 'https://a.example' },
      lines: [
        { name: 'water', unit: '%', rest_to_total: true },
        { name: 'a', amount: 70, unit: '%' },
        { name: 'b', amount: 35, unit: '%' }
      ]
    })
    expect(r.block.closes).toBe(false)
    expect(r.block.closes_note).toMatch(/besides the rest "water" already reach 105 of 100 %/)
  })

  it('scales to the contents mass found when all figures agree, and to none when they do not', () => {
    const base = {
      formulation: { name: 'x', kind: 'product', source_url: 'https://a.example' },
      lines: [{ name: 'water', amount: 100, unit: '%' }]
    }
    const agree = weigh({
      ...base,
      contents_mass: [
        { volume_l: 0.5, density_kg_per_l: 1.02 },
        { mass_kg: 0.51, source_url: 'https://b.example' }
      ]
    })
    expect(agree.block).toMatchObject({ mass_kg: 0.51, mass_source: 'researched' })
    const apart = weigh({ ...base, contents_mass: [{ mass_kg: 0.51 }, { mass_kg: 0.75 }] })
    expect(apart.block.mass_kg).toBeUndefined()
    expect(apart.notes.join(' ')).toMatch(/contents masses found disagree.*pass it as recipe.mass_kg/)
  })

  it('locks the verdict when lines beyond the cap could not be handed on', () => {
    const lines = Array.from({ length: 32 }, (_, i) => ({
      name: `ingredient ${i}`,
      amount: 3.125,
      unit: '%'
    }))
    const r = weigh(
      { formulation: { name: 'long', kind: 'product', source_url: 'https://a.example' }, lines },
      { mass_kg: 1 }
    )
    expect(r.block.closes).toBe(true)
    expect(r.items).toHaveLength(30)
    expect(r.lock).toBe('the recipe of liquid soap lists 2 further lines beyond the 30 handed on')
  })

  // A live run: the recipe of a 1-litre comparable soap came with that product's fill, and scaled a 500 ml pouch to 1 kg.
  it("does not scale to the fill printed on a frame formulation's own page", () => {
    const page = 'https://shop.example/comparable-soap-1l'
    const r = weigh({
      formulation: { name: 'Comparable hand soap', kind: 'frame', source_url: page },
      lines: [{ name: 'water', amount: 100, unit: '%' }],
      contents_mass: [{ mass_kg: 1, source_url: page }]
    })
    expect(r.block.mass_kg).toBeUndefined()
    expect(r.notes.join(' ')).toMatch(/1 kg came from the page of the frame formulation .* not used/)
    const own = weigh({
      formulation: { name: 'This soap', kind: 'product', source_url: page },
      lines: [{ name: 'water', amount: 100, unit: '%' }],
      contents_mass: [{ mass_kg: 0.51, source_url: page }]
    })
    expect(own.block.mass_kg).toBe(0.51)
  })

  it('gives no gap where the closure could not be checked, and keeps small shares readable', () => {
    const r = weigh(
      {
        formulation: { name: 'x', kind: 'frame', source_url: 'https://a.example' },
        lines: [
          { name: 'water', unit: '%', range: [70, 85] },
          { name: 'dye', amount: 0.002, unit: '%' }
        ]
      },
      { mass_kg: 1 }
    )
    expect(r.block.closes).toBeNull()
    expect(r.block.gap_pct).toBeUndefined()
    expect(r.block.gap_kg).toBeUndefined()
    expect(r.block.lines[1].share_pct).toBe(0.002)
  })

  // A live run: a weak model wrote a concrete's lines in the parts agent's format.
  it('reads lines written in the parts format, and names the keys of an answer it cannot read', () => {
    const parts = weigh(
      {
        formulation: {
          name: 'C30/37',
          kind: 'frame',
          source_url: 'https://a.example',
          total: { amount: 2400, unit: 'kg' }
        },
        items: [
          { material: 'cement', amount: 350, unit: 'kg' },
          { component: 'water', amount: 170, unit: 'kg' },
          { name: 'aggregate', amount: 1880, unit: 'kg' }
        ]
      },
      { of: 'concrete' }
    )
    expect(parts.block.lines.map((l) => l.name)).toEqual(['cement', 'water', 'aggregate'])
    expect(parts.block.closes).toBe(true)
    const none = weigh(
      { formulation: { name: 'C30/37', source_url: 'https://a.example' }, mix: [{ cement: 350 }] },
      { of: 'concrete' }
    )
    expect(none.lock).toBe(
      'no recipe came back for concrete (no recipe line could be read; the answer carried formulation, mix)'
    )
  })

  it('comes back as a lock with its reason when the recipe leg found nothing', () => {
    const r = weighRecipe(undefined, { of: 'paint', request: {}, error: 'timed out' })
    expect(r.block.closes).toBeNull()
    expect(r.lock).toBe('no recipe came back for paint (timed out)')
  })
})

describe('weighBom with a mixture', () => {
  const part = (component: string, mass_kg: number, more: Partial<BomItem> = {}): BomItem => ({
    component,
    material: 'PE',
    mass_kg,
    source_url: 'https://e.org/' + component,
    ...more
  })
  const legOf = (items: BomItem[], more: Partial<BomLeg> = {}): BomLeg => ({
    items,
    unresolved: [],
    product_masses: [],
    versions_seen: [],
    ...more
  })
  const open = weigh(
    {
      formulation: { name: 'MP-01', kind: 'frame', source_url: PCC },
      lines: [
        { name: 'water', amount: 73.9, unit: '%' },
        { name: 'surfactants', amount: 11.67, unit: '%' },
        { name: 'glycerin', amount: 2, unit: '%' },
        { name: 'additives', amount: 3.55, unit: '%' }
      ]
    },
    { of: 'liquid soap (contents of the pouch)', mass_kg: 0.51 }
  )
  const closed = weigh(
    {
      formulation: { name: 'MP-01', kind: 'frame', source_url: PCC },
      lines: [
        { name: 'water', unit: '%', rest_to_total: true },
        { name: 'SLES 70 %', amount: 12, unit: '%' }
      ]
    },
    { of: 'liquid soap (contents of the pouch)', mass_kg: 0.51 }
  )

  it('locks the verdict on a mixture that does not close, though the parts fit the total', () => {
    const outcomes: LegOutcome[] = [
      { request: 'pouch', leg: legOf([part('pouch', 0.02)]) },
      { request: 'cap', leg: legOf([part('cap', 0.003)]) }
    ]
    const r = weighBom(outcomes, { totalMassKg: 0.535, recipe: open })
    expect(r.sum_kg).toBeCloseTo(0.533, 9)
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(
      /Balance NOT checked: the recipe of liquid soap \(contents of the pouch\) does not close: 8\.88 %/
    )
    expect(r.summary).toMatch(
      /^The recipe of liquid soap .*, does NOT close: 8\.88 % \(0\.045288 kg\) unaccounted\./
    )
    expect(r.summary).toMatch(
      /parts and mixture sum to 0\.533 kg\. Checked against .*so this checks the other parts/
    )
    expect(r.recipe?.closes).toBe(false)
    // The mixture's ingredients are in the items, the parts too — the request statuses are the parts' alone.
    expect(r.items.filter((i) => i.group === 'recipe')).toHaveLength(4)
    expect(r.requests).toEqual([
      { component: 'pouch', status: 'with_mass' },
      { component: 'cap', status: 'with_mass' }
    ])
  })

  it('judges the parts once the mixture closes, the mixture counted at the mass it was scaled to', () => {
    const outcomes: LegOutcome[] = [{ request: 'pouch', leg: legOf([part('pouch', 0.02)]) }]
    const r = weighBom(outcomes, { totalMassKg: 0.53, recipe: closed })
    expect(r.balance_ok).toBe(true)
    expect(r.residual_kg).toBe(0)
  })

  it('keeps transport packaging out of a gross weight, and sales packaging in it', () => {
    const outcomes: LegOutcome[] = [
      {
        request: 'pouch',
        leg: legOf([part('pouch', 0.02)], {
          product_masses: [{ mass_kg: 0.54, basis: 'gross', source_url: 'https://shop.example/p' }]
        })
      },
      { request: 'shrink sleeve', leg: legOf([part('shrink sleeve', 0.01, { packaging: 'sales' })]) },
      { request: 'shipping carton', leg: legOf([part('shipping carton', 0.4, { packaging: 'transport' })]) }
    ]
    const r = weighBom(outcomes, { recipe: closed })
    expect(r.packaging_kg).toBe(0.01)
    expect(r.transport_packaging_kg).toBe(0.4)
    expect(r.residual_kg).toBeCloseTo(0, 9)
    expect(r.balance_ok).toBe(true)
    expect(r.summary).toMatch(/sales packaging 0\.01 kg, transport packaging 0\.4 kg on top/)
  })

  it('does not suspect the water of a drink of being the whole product', () => {
    const drink = weigh(
      {
        formulation: { name: 'Still water', kind: 'product', source_url: 'https://maker.example/drink' },
        lines: [
          { name: 'water', amount: 99, unit: '%' },
          { name: 'minerals', amount: 1, unit: '%' }
        ]
      },
      { of: 'drink', mass_kg: 1 }
    )
    const r = weighBom([{ request: 'bottle', leg: legOf([part('bottle', 0.03)]) }], {
      totalMassKg: 1.03,
      recipe: drink
    })
    expect(r.balance_ok).toBe(true)
    expect(r.note ?? '').not.toMatch(/weighs as much as the whole product/)
  })

  it('sees a tread that includes its compound as an overlap', () => {
    const compound = weigh(
      {
        formulation: { name: 'Tread compound', kind: 'frame', source_url: 'https://rubber.example/tread' },
        lines: [
          { name: 'natural rubber', amount: 60, unit: '%' },
          { name: 'carbon black', amount: 40, unit: '%' }
        ]
      },
      { of: 'tread compound', mass_kg: 1.5 }
    )
    const outcomes: LegOutcome[] = [
      { request: 'tread', leg: legOf([part('tread', 1.6, { includes: ['tread compound'] })]) },
      { request: 'steel cord', leg: legOf([part('steel cord', 0.4)]) }
    ]
    const r = weighBom(outcomes, { totalMassKg: 3.5, recipe: compound })
    expect(r.overlaps).toEqual([{ entry: 'tread', includes: ['tread compound'] }])
    expect(r.balance_ok).toBeNull()
  })

  it('lets a recipe alone be its own check, and says that nothing else was researched', () => {
    const r = weighBom([], { recipe: closed })
    expect(r.balance_ok).toBe(true)
    expect(r.summary).toMatch(
      /Only the recipe was researched, no other part of the product \(a container or packaging would go in components\); the mixture weighs 0\.51 kg\. The recipe's closure is the check — it closes\./
    )
    const shares = weigh({
      formulation: { name: 'MP-01', kind: 'frame', source_url: PCC },
      lines: [{ name: 'water', amount: 100, unit: '%' }]
    })
    const s = weighBom([], { recipe: shares })
    expect(s.balance_ok).toBe(true)
    expect(s.summary).toMatch(/Shares only, no kg/)
  })

  it('cannot weigh parts against a total while the mixture has no mass', () => {
    const shares = weigh({
      formulation: { name: 'MP-01', kind: 'frame', source_url: PCC },
      lines: [{ name: 'water', amount: 100, unit: '%' }]
    })
    const r = weighBom([{ request: 'pouch', leg: legOf([part('pouch', 0.02)]) }], {
      totalMassKg: 0.53,
      recipe: shares
    })
    expect(r.balance_ok).toBeNull()
    expect(r.note).toMatch(/the mixture liquid soap has no mass in kg — pass recipe.mass_kg/)
  })

  it('names a contents mass that belongs to another version of the product as a conflict', () => {
    const soap = weigh(
      {
        formulation: { name: 'MP-01', kind: 'frame', source_url: PCC },
        lines: [{ name: 'water', amount: 100, unit: '%' }],
        contents_mass: [{ mass_kg: 0.51, version: 'EAN 4066447983838', source_url: 'https://shop.example/b' }]
      },
      { of: 'liquid soap' }
    )
    const outcomes: LegOutcome[] = [
      { request: 'pouch', leg: legOf([part('pouch', 0.02, { version: 'EAN 4070765029765' })]) }
    ]
    const r = weighBom(outcomes, { totalMassKg: 0.53, recipe: soap })
    expect(r.versions?.conflict).toBe(true)
    expect(r.versions?.used?.map((u) => u.entries)).toEqual([
      ['pouch'],
      ['contents of liquid soap (0.51 kg)']
    ])
    expect(r.balance_ok).toBeNull()
  })

  it('leaves a call without a recipe as it was', () => {
    const r = weighBom([{ request: 'pouch', leg: legOf([part('pouch', 0.02)]) }], { totalMassKg: 0.02 })
    expect(r.recipe).toBeUndefined()
    expect(r.summary).toBe(
      '1 of 1 requested components came back with a mass of their own; parts sum to 0.02 kg. Checked against the total you passed (0.02 kg) — the parts add up (residual 0 kg, 0 % of the total, within the 15 % tolerance).'
    )
  })
})
