import { describe, expect, it } from 'vitest'
import { parseRecipeAnswer, type RecipeRequest } from './bomRecipe'
import { inciEntries, listNames } from './inciList'
import { weighRecipe } from './recipeBalance'

/**
 * A product's printed ingredient list — the one the caller passed or the one the recipe leg found — read into its
 * names, and a recipe covered against them. The list says which ingredients the recipe lacks; the recipe's shares
 * are not held against the order the list prints them in.
 */
const weigh = (answer: unknown, request: RecipeRequest = {}) =>
  weighRecipe(parseRecipeAnswer(answer), { of: 'liquid soap', request })

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
/** The liquid soap of the mid-November test series: glycerin at 2 %, the betaine the label lists before it at 1.05 %. */
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

describe('the printed ingredient list a recipe is covered against', () => {
  it('names what the recipe lacks of a passed INCI list, and holds its shares against no order', () => {
    const r = weigh(frame(), { inci_list: LABEL, mass_kg: 0.5 })
    expect(r.block.missing_ingredients).toEqual(['Parfum', 'Glyceryl Oleate'])
    // Glycerin heavier than the betaine listed before it is no finding: the result carries no comparison.
    expect(r.block).not.toHaveProperty('inci_order')
    expect(r.sentence).not.toMatch(/contradict|order of/)
    expect(r.sentence).toMatch(
      /^The recipe of liquid soap, "Liquid soap MP-01" \(a frame formulation, not this product's own\), closes: .* Known from the product but not in it: Parfum, Glyceryl Oleate\. Scaled to 0\.5 kg/
    )
    expect(r.block.closes).toBe(true)
    expect(r.lock).toBeUndefined()
  })

  it('covers the recipe against a list the leg found, whatever the leg says about its kind', () => {
    const found = { names: LABEL, source_url: DM }
    for (const declared of [found, { ...found, kind: 'inci', product: 'Balea Liquid Soap' }, LABEL]) {
      const r = weigh(frame(declared))
      expect(r.block.missing_ingredients).toEqual(['Parfum', 'Glyceryl Oleate'])
      expect(r.block).not.toHaveProperty('inci_order')
    }
    expect(weigh(frame(found)).block.declared_source).toBe(DM)
    // What the leg says beside the names and the page is not kept.
    expect(
      parseRecipeAnswer(frame({ ...found, kind: 'inci', product: 'Balea Liquid Soap' })).declared
    ).toEqual({
      names: LABEL,
      source_url: DM
    })
  })

  it('takes the list the caller passed instead of the one found', () => {
    // The found list is of an older version of the product: a preservative more.
    const older = { names: [...LABEL.slice(0, 5), 'Phenoxyethanol'], source_url: DM }
    const r = weigh(frame(older), { inci_list: LABEL })
    // The older list's extra ingredient is not "known from the product", and its page is not the list's source.
    expect(r.block.missing_ingredients).toEqual(['Parfum', 'Glyceryl Oleate'])
    expect(r.block.declared_source).toBeUndefined()
  })

  it("covers an entry by the INCI name the leg wrote on a trade form's constituent", () => {
    const blend = (inci?: string) =>
      weigh(
        {
          formulation: { name: 'x', kind: 'frame', source_url: PCC },
          lines: [
            { name: 'Aqua', amount: 86, unit: '%' },
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
      ).block.missing_ingredients
    expect(blend('Glycerin')).toBeUndefined()
    // Without it the datasheet's name covers nothing: the entry is reported, for the reader to recognise.
    expect(blend()).toEqual(['Glycerin'])
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
  })
})

/**
 * An INCI name may carry a slash or a bracket of its own ("Caprylic/Capric Triglyceride", "Butyrospermum Parkii
 * (Shea) Butter"), so a printed name is read whole. It names one ingredient twice only in the names of both
 * nomenclatures ("Aqua (Water)", "Parfum/Fragrance") and in a bracket that ends it ("Titanium Dioxide (CI 77891)").
 */
describe('the names that cover an entry of the list', () => {
  /** What the recipe's lines — names, with an INCI name where given — leave missing of a list. */
  const missing = (
    lines: Array<string | { name: string; inci: string }>,
    list: string[],
    as: 'inci_list' | 'ingredients' = 'inci_list'
  ) =>
    weigh(
      {
        formulation: { name: 'x', kind: 'frame', source_url: PCC },
        lines: lines.map((l) => ({ ...(typeof l === 'string' ? { name: l } : l), amount: 1, unit: '%' }))
      },
      { [as]: list }
    ).block.missing_ingredients ?? []
  const SLASHED = [
    'Dimethicone/Vinyl Dimethicone Crosspolymer',
    'Acrylates/C10-30 Alkyl Acrylate Crosspolymer',
    'Caprylic/Capric Triglyceride',
    'Butyrospermum Parkii (Shea) Butter'
  ]

  it('covers no name by a part of it: the recipe lacks a crosspolymer though it has dimethicone', () => {
    expect(missing(['Dimethicone', 'Acrylates', 'Capric Triglyceride', 'Shea'], SLASHED)).toEqual(SLASHED)
    // The other way round neither: a crosspolymer in the recipe is no dimethicone.
    expect(missing(['Dimethicone/Vinyl Dimethicone Crosspolymer'], ['Dimethicone'])).toEqual(['Dimethicone'])
  })

  it('covers a name with a slash or a bracket inside it by the whole name, spelling aside', () => {
    const lines = [
      { name: 'Silicone elastomer blend', inci: 'DIMETHICONE / VINYL DIMETHICONE CROSSPOLYMER' },
      'Carbomer 980',
      { name: 'MCT oil', inci: 'Caprylic/capric triglyceride' },
      { name: 'Shea butter', inci: 'Butyrospermum Parkii (Shea) Butter' }
    ]
    expect(missing(lines, SLASHED)).toEqual(['Acrylates/C10-30 Alkyl Acrylate Crosspolymer'])
  })

  it('covers water, perfume and flavour under the name of either nomenclature', () => {
    const both = [
      'Aqua (Water)',
      'Parfum (Fragrance)',
      'Aroma/Flavor',
      'Aqua/Water/Eau',
      'Fragrance (Parfum)'
    ]
    expect(missing(['water', 'Parfum', 'Flavor'], both)).toEqual([])
    expect(missing(['Aqua', 'Fragrance', 'Aroma'], both)).toEqual([])
    // One name on either side is enough: INCI's "Aqua" is the recipe's water.
    expect(missing(['Water (Aqua)', 'fragrance', 'flavour'], ['Aqua', 'Parfum', 'Aroma'])).toEqual([])
    // A name that only contains one of them is another ingredient.
    expect(missing(['Rose water', 'Fragrance oil'], ['Aqua', 'Parfum'])).toEqual(['Aqua', 'Parfum'])
    expect(missing(['Water'], ['Rosa Damascena Flower Water'])).toEqual(['Rosa Damascena Flower Water'])
  })

  it('reads a closed bracket that ends a name as its second name, an open one as the start of its parts', () => {
    const list = ['Titanium Dioxide (CI 77891)', 'CI 77491 (Iron Oxides)', 'Tocopherol (Vitamin E)']
    expect(missing(['Titanium dioxide', 'Iron oxides', 'Vitamin E'], list)).toEqual([])
    expect(missing(['CI 77891', 'CI 77491', 'Tocopherol'], list)).toEqual([])
    // The recipe's own names are read alike: its yellow iron oxides are the label's iron oxides.
    expect(missing(['Iron oxides (yellow)'], ['Iron Oxides'])).toEqual([])
    // Two names that share only their brackets are two ingredients.
    expect(missing(['CI 77492 (Iron Oxides)'], ['CI 77491 (Iron Oxides)'])).toEqual([
      'CI 77491 (Iron Oxides)'
    ])
    expect(missing(['Cocoa Butter (organic)'], ['Shea Butter (organic)'])).toEqual(['Shea Butter (organic)'])
    // The full stop that ends a list, or an asterisk for organic, does not hide the bracket.
    expect(missing(['Aqua', 'Titanium dioxide'], ['Aqua, Titanium Dioxide (CI 77891).'])).toEqual([])
    expect(missing(['Glycerin', 'Tocopherol'], ['Glycerin, Tocopherol (Vitamin E)*'])).toEqual([])
    // A list cut inside a bracket: the chocolate is the name before it; the sugar of the dough is no chocolate.
    const cookie = (lines: string[]) =>
      missing(lines, ['Wheat Flour, Chocolate (Sugar, Cocoa Mass, Butter, Sugar'], 'ingredients')
    expect(cookie(['Wheat flour', 'Butter', 'Sugar'])).toEqual(['Chocolate (Sugar', 'Cocoa Mass'])
    expect(cookie(['Wheat flour', 'Butter', 'Sugar', 'Chocolate', 'Cocoa mass'])).toEqual([])
  })
})

/**
 * A bracket holds one entry's names together: what a compound is made of ("Chocolate (Sugar, Cocoa Mass)",
 * Regulation (EU) No 1169/2011, Art. 18), or the colour index numbers of one colourant. Only the bracket around a
 * "may contain" part holds names of their own.
 */
describe('the commas inside a bracket of the list', () => {
  const missing = (lines: string[], list: string[], as: 'inci_list' | 'ingredients') =>
    weigh(
      {
        formulation: { name: 'x', kind: 'frame', source_url: PCC },
        lines: lines.map((name) => ({ name, amount: 1, unit: '%' }))
      },
      { [as]: list }
    )

  it('splits a list at no comma inside a bracket it closes, wherever the caller split it', () => {
    expect(
      inciEntries(['Wheat Flour, Chocolate (Sugar, Cocoa Mass, Emulsifier (Soy Lecithin)), Butter, Sugar'])
    ).toEqual(['Wheat Flour', 'Chocolate (Sugar, Cocoa Mass, Emulsifier (Soy Lecithin))', 'Butter', 'Sugar'])
    expect(inciEntries(['Mica, Iron Oxides (CI 77491, CI 77492), 1,2-Hexanediol.'])).toEqual([
      'Mica',
      'Iron Oxides (CI 77491, CI 77492)',
      '1,2-Hexanediol.'
    ])
    // A caller that split the list inside the bracket sent one entry in two pieces.
    expect(inciEntries(['Wheat Flour', 'Chocolate (Sugar', 'Cocoa Mass)', 'Butter'])).toEqual([
      'Wheat Flour',
      'Chocolate (Sugar, Cocoa Mass)',
      'Butter'
    ])
    // A bracket the list never closes holds nothing together.
    expect(inciEntries(['Flour, Chocolate (Sugar, Cocoa Mass, Butter'])).toEqual([
      'Flour',
      'Chocolate (Sugar',
      'Cocoa Mass',
      'Butter'
    ])
  })

  it('still reads the names of a bracketed "may contain" part one by one', () => {
    const names = (list: string) =>
      listNames(inciEntries([list])).map((n) => `${n.name}${n.may ? ' (may)' : ''}`)
    expect(names('Glycerin, Phenoxyethanol (+/- Mica, CI 77891)')).toEqual([
      'Glycerin',
      'Phenoxyethanol',
      'Mica (may)',
      'CI 77891 (may)'
    ])
    // A heading in the bracket, or before it, is no name.
    for (const list of [
      'Glycerin, [Peut contenir/May contain: Mica, CI 77891].',
      'Glycerin, (May contain: Mica, CI 77891)',
      'Glycerin, Kann enthalten [+/-: Mica, CI 77891]'
    ])
      expect(names(list), list).toEqual(['Glycerin', 'Mica (may)', 'CI 77891 (may)'])
    // A colourant of several index numbers inside the part is one name.
    expect(names('Phenoxyethanol [+/- Mica, Iron Oxides (CI 77491, CI 77492)]')).toEqual([
      'Phenoxyethanol',
      'Mica (may)',
      'Iron Oxides (CI 77491, CI 77492) (may)'
    ])
  })

  it('reports a compound ingredient whole, and covers it by its name', () => {
    const list = ['Wheat Flour, Chocolate (Sugar, Cocoa Mass), Butter, Sugar']
    const r = missing(['Wheat flour', 'Butter', 'Sugar'], list, 'ingredients')
    expect(r.block.missing_ingredients).toEqual(['Chocolate (Sugar, Cocoa Mass)'])
    expect(r.sentence).toMatch(/Known from the product but not in it: Chocolate \(Sugar, Cocoa Mass\)\./)
    // What the chocolate is made of is no ingredient of the cookie of its own.
    const all = ['Wheat flour', 'Butter', 'Sugar', 'Chocolate']
    expect(missing(all, list, 'ingredients').block.missing_ingredients).toBeUndefined()
    expect(
      missing(['Chocolate'], ['Chocolate (Sugar, Cocoa Mass, Emulsifier (Soy Lecithin))'], 'ingredients')
        .block.missing_ingredients
    ).toBeUndefined()
  })

  it('reads a bracket of any other list than an INCI list as what the entry is made of, never as its name', () => {
    const left = (lines: string[], list: string[], as: 'inci_list' | 'ingredients') =>
      missing(lines, list, as).block.missing_ingredients ?? []
    // The sugar and cocoa mass of the dough are no chocolate, the milk of a sauce no cheese.
    const food = ['Chocolate (Sugar, Cocoa Mass)', 'Cheese (Milk)', 'Tomatoes (45%)']
    expect(left(['Sugar', 'Cocoa mass', 'Milk', 'Tomatoes'], food, 'ingredients')).toEqual([
      'Chocolate (Sugar, Cocoa Mass)',
      'Cheese (Milk)'
    ])
    expect(left(['Chocolate', 'Cheese', 'Tomatoes'], food, 'ingredients')).toEqual([])
    // An INCI list's bracket of one name is a second name for the entry, as before — also when the caller put the
    // name on both lists.
    expect(left(['CI 77891'], ['Titanium Dioxide (CI 77891)'], 'inci_list')).toEqual([])
    const both = weigh(
      {
        formulation: { name: 'x', kind: 'frame', source_url: PCC },
        lines: [{ name: 'CI 77891', amount: 1, unit: '%' }]
      },
      {
        ingredients: ['Titanium Dioxide (CI 77891)', 'Mica'],
        inci_list: ['Mica', 'Titanium Dioxide (CI 77891)']
      }
    )
    expect(both.block.missing_ingredients).toEqual(['Mica'])
  })

  it("reads the list the leg found, a cosmetic's or a food's, as a list of unknown kind", () => {
    const found = (lines: string[], names: string[]) =>
      weigh({
        formulation: { name: 'x', kind: 'frame', source_url: PCC },
        lines: lines.map((name) => ({ name, amount: 1, unit: '%' })),
        declared_ingredients: { names, source_url: DM }
      }).block.missing_ingredients ?? []
    // A bracket of one name is a second name: the label's titanium dioxide is the recipe's CI 77891.
    expect(found(['CI 77891'], ['Titanium Dioxide (CI 77891)'])).toEqual([])
    // Of several names it is what the entry is made of: the dough's sugar and cocoa mass are no chocolate, nor two
    // index numbers a colourant the label names otherwise.
    const label = ['Wheat Flour, Chocolate (Sugar, Cocoa Mass), Iron Oxides (CI 77491, CI 77492)']
    expect(found(['Wheat flour', 'Sugar', 'Cocoa mass', 'CI 77491', 'CI 77492'], label)).toEqual([
      'Chocolate (Sugar, Cocoa Mass)',
      'Iron Oxides (CI 77491, CI 77492)'
    ])
    expect(found(['Wheat flour', 'Chocolate', 'Iron oxides'], label)).toEqual([])
  })

  it('covers an INCI name whose bracket holds the names of its parts by all of them, or by its own name', () => {
    const list = ['Iron Oxides (CI 77491, CI 77492)']
    const left = (lines: string[]) => missing(lines, list, 'inci_list').block.missing_ingredients ?? []
    expect(left(['CI 77491', 'CI 77492'])).toEqual([])
    expect(left(['Iron oxides'])).toEqual([])
    expect(left(['Iron Oxides (CI 77491, CI 77492)'])).toEqual([])
    // The yellow alone leaves the red missing.
    expect(left(['CI 77492'])).toEqual(list)
    // A part of a part counts like any part: "Iron Oxides (CI 77491)" covers its share.
    expect(left(['Iron Oxides (CI 77491)', 'CI 77492'])).toEqual([])
  })
})

/**
 * A product sold in several shades may list every colourant of the range behind "+/-" or "may contain"
 * (Regulation (EC) No 1223/2009, Art. 19(1)(g)): a shade has some of them, so a recipe lacks none of them.
 */
describe('the "may contain" part of an INCI list', () => {
  const FOUNDATION = {
    formulation: { name: 'Liquid foundation F-12', kind: 'frame', source_url: PCC },
    lines: [
      { name: 'Aqua', amount: null, unit: '%', rest_to_total: true },
      { name: 'Cyclopentasiloxane', amount: 12, unit: '%' },
      { name: 'Dimethicone', amount: 3, unit: '%' },
      { name: 'Glycerin', amount: 2, unit: '%' },
      { name: 'Mica', amount: 4, unit: '%' },
      { name: 'Titanium dioxide', inci: 'CI 77891', amount: 5, unit: '%' },
      { name: 'Iron oxides (yellow)', inci: 'CI 77492', amount: 1.5, unit: '%' },
      { name: 'Phenoxyethanol', amount: 0.8, unit: '%' }
    ]
  }
  const OILS = ['Aqua', 'Cyclopentasiloxane', 'Dimethicone', 'Glycerin', 'Phenoxyethanol']

  it('reports a colourant printed without the marker as missing: it is in the product', () => {
    const r = weigh(FOUNDATION, { inci_list: [...OILS, 'Mica', 'CI 77891', 'CI 77492', 'CI 77491'] })
    expect(r.block.missing_ingredients).toEqual(['CI 77491'])
  })

  it('never reports a name behind "+/-" as missing, and covers the name before the marker', () => {
    // Sent as one string, the marker and the bracket sit inside entries: "Phenoxyethanol [+/- Mica", "CI 77499]".
    const r = weigh(FOUNDATION, {
      inci_list: [`${OILS.join(', ')} [+/- Mica, CI 77891, CI 77492, CI 77491, CI 77499]`]
    })
    expect(r.block.missing_ingredients).toBeUndefined()
    // The name before the marker is still held to the recipe.
    const without = { ...FOUNDATION, lines: FOUNDATION.lines.filter((l) => l.name !== 'Phenoxyethanol') }
    expect(
      weigh(without, { inci_list: [`${OILS.join(', ')} [+/- Mica, CI 77891]`] }).block.missing_ingredients
    ).toEqual(['Phenoxyethanol'])
  })

  it('reads the marker however the label prints it: alone, in several languages, as "may contain"', () => {
    // The last three as a model passed them, the marker before every entry.
    const each = (marker: string) => ['Mica', 'CI 77891', 'CI 77491'].map((n) => `${marker} ${n}`)
    for (const tail of [
      ['+/-', 'Mica', 'CI 77891', 'CI 77491'],
      ['May contain/Peut contenir (+/-): Mica', 'CI 77891', 'CI 77491'],
      ['MAY CONTAIN: Mica', 'CI 77891', 'CI 77491.'],
      ['(±) Mica', 'CI 77891', 'CI 77491'],
      each('+/- MAY CONTAIN:'),
      each('MAY CONTAIN/PEUT CONTENIR/PUEDE CONTENER:'),
      each('[+/-]')
    ]) {
      // CI 77491 is in no line of the recipe: only its place behind the marker keeps it from being reported.
      const r = weigh(FOUNDATION, { inci_list: [...OILS, ...tail] })
      expect(r.block.missing_ingredients, tail[0]).toBeUndefined()
    }
  })

  it('reads the names of the list without their markers, and keeps the colon of a lake', () => {
    expect(
      listNames(['Glycerin', 'Phenoxyethanol [+/- Mica', 'C.I. 15850:1', 'Iron Oxides (CI 77491)]'])
    ).toEqual([
      { name: 'Glycerin', may: false },
      { name: 'Phenoxyethanol', may: false },
      { name: 'Mica', may: true },
      { name: 'C.I. 15850:1', may: true },
      { name: 'Iron Oxides (CI 77491)', may: true }
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
  })
})
