import { describe, expect, it } from 'vitest'
import type { BomItem } from '../bomAnswer'
import type { RecipeLineOut } from '../recipeBalance'
import type { BomResult } from '../researchBom'
import { REFERENCE_PRODUCTS, SOAP_INCI } from './reference'
import {
  accuracy,
  bomIntegrity,
  carryingFindings,
  carryingFromParts,
  citationGate,
  estimatesHedged,
  fitsLabel,
  labelFound,
  lookupsIn,
  otherVersionKeptApart,
  partValues,
  partsSumWithin,
  referenceGates,
  SKIPPED_FOR_BUDGET,
  summarise,
  type ReferencePart,
  type RunRecord
} from './score'

const item = (component: string, mass_kg: number, more: Partial<BomItem> = {}): BomItem => ({
  component,
  material: 'steel',
  mass_kg,
  source_url: `https://example.org/${encodeURIComponent(component)}`,
  ...more
})

const result = (more: Partial<BomResult> = {}): BomResult => ({
  product: 'p',
  summary: '',
  coverage: { requested: 0, with_mass: 0 },
  items: [],
  unresolved: [],
  sum_kg: 0,
  balance_ok: null,
  evidence: [],
  sources: [],
  ...more
})

const part = (id: string, match: RegExp, more: Partial<ReferencePart> = {}): ReferencePart => ({
  id,
  label: id,
  match,
  where: 'items',
  accept: [[1, 2]],
  basis: 'sourced',
  climateShare: 10,
  note: '',
  ...more
})

const ref = (name: string) => REFERENCE_PRODUCTS.find((p) => p.name === name)!

describe('partValues', () => {
  it('gives each entry to the first part it matches and sums a part split into entries', () => {
    const parts = [part('wheel', /rad|wheel/i), part('small', /achse|lager|axle/i)]
    const v = partValues(
      parts,
      result({
        items: [item('Rad mit Kugellager', 2), item('Achse (Lager)', 0.2), item('Achse (Schrauben)', 0.1)]
      })
    )
    expect(v.get('wheel')!.value).toBe(2)
    expect(v.get('small')!.value).toBe(0.3)
  })

  it('gives packaging only to a packaging part, and a recipe ingredient to none of the parts', () => {
    const parts = [part('frame', /karton|frame/i), part('pack', /karton/i, { packaging: true })]
    const v = partValues(
      parts,
      result({
        items: [item('Karton', 0.4, { packaging: 'sales' }), item('frame', 1, { group: 'recipe' })]
      })
    )
    expect(v.get('frame')!.value).toBeNull()
    expect(v.get('pack')!.value).toBe(0.4)
  })

  it('reads a recipe line by its INCI name, and a trade form booked as its constituents by the constituent', () => {
    const parts = [
      part('sles', /laureth/i, { where: 'recipe' }),
      part('salt', /sodium chloride/i, { where: 'recipe' })
    ]
    const lines: RecipeLineOut[] = [
      {
        name: 'Texapon N70',
        share_pct: 12,
        trade_form: {
          name: 'Texapon N70',
          split: true,
          constituents: [
            { name: 'Sodium Laureth Sulfate', pct: 70, share_pct: 8.4 },
            { name: 'Aqua', pct: 30, share_pct: 3.6 }
          ]
        }
      },
      { name: 'Salz', inci: 'SODIUM CHLORIDE', share_pct: 2.5 }
    ]
    const v = partValues(parts, result({ recipe: { of: 'soap', lines, closes: true, closes_note: '' } }))
    expect(v.get('sles')!.value).toBe(8.4)
    expect(v.get('salt')!.value).toBe(2.5)
  })

  it('gives every constituent of a split trade form to its own part, and a blend line to none', () => {
    const parts = [
      part('sles', /laureth/i, { where: 'recipe' }),
      part('capb', /cocamidopropyl/i, { where: 'recipe' })
    ]
    const split: RecipeLineOut = {
      name: 'Surfactant blend',
      share_pct: 20,
      trade_form: {
        name: 'Blend X',
        split: true,
        constituents: [
          { name: 'Sodium Laureth Sulfate', pct: 40, share_pct: 8 },
          { name: 'Cocamidopropyl Betaine', pct: 10, share_pct: 2 },
          { name: 'Aqua', pct: 50, share_pct: 10 }
        ]
      }
    }
    const blend: RecipeLineOut = {
      name: 'Sodium Laureth Sulfate (and) Cocamidopropyl Betaine',
      inci: 'Sodium Laureth Sulfate, Cocamidopropyl Betaine, Coco-Glucoside',
      share_pct: 8
    }
    const of = (lines: RecipeLineOut[]) =>
      partValues(parts, result({ recipe: { of: 's', lines, closes: true, closes_note: '' } }))
    const v = of([split])
    expect([v.get('sles')!.value, v.get('capb')!.value]).toEqual([8, 2])
    const b = of([blend])
    expect([b.get('sles')!.value, b.get('capb')!.value]).toEqual([null, null])
  })
})

describe('accuracy', () => {
  it('weights each part by the climate share it carries, 1 inside, falling to 0 at half a bound beyond', () => {
    const parts = [
      part('a', /a/, { accept: [[10, 12]], climateShare: 75 }),
      part('b', /b/, { accept: [[1, 2]], climateShare: 25 })
    ]
    // a inside; b 25 % above its upper bound → 0.5
    const v = partValues(parts, result({ items: [item('a', 11), item('b', 2.5)] }))
    const acc = accuracy(v)
    expect(acc.parts.map((p) => p.score)).toEqual([1, 0.5])
    expect(acc.score).toBe(0.875)
  })

  it('scores a part that did not come back 0', () => {
    const parts = [part('a', /a/, { climateShare: 50 }), part('gone', /gone/, { climateShare: 50 })]
    const acc = accuracy(partValues(parts, result({ items: [item('a', 1.5)] })))
    expect(acc.parts.map((p) => p.score)).toEqual([1, 0])
    expect(acc.score).toBe(0.5)
  })

  it('reads a surfactant as the substance, and as dosed only when it is dosed as a trade form', () => {
    const parts = [
      part('sles', /laureth/i, { where: 'recipe', accept: [[6, 12]], acceptAsDosed: [[24, 36]] })
    ]
    const score = (line: RecipeLineOut) =>
      accuracy(
        partValues(parts, result({ recipe: { of: 's', lines: [line], closes: true, closes_note: '' } }))
      ).score
    // 30 % of the substance itself is ~3.7 times the active matter of 30 % of a 27-% solution
    expect(score({ name: 'Sodium Laureth Sulfate', share_pct: 30 })).toBe(0)
    expect(score({ name: 'Sodium Laureth Sulfate', share_pct: 8.5 })).toBe(1)
    const dosed = { name: 'SLES 27 %', split: false, note: 'composition of the trade form not stated' }
    expect(score({ name: 'Sodium Laureth Sulfate', share_pct: 30, trade_form: dosed })).toBe(1)
    expect(score({ name: 'Sodium Laureth Sulfate', share_pct: 8.5, trade_form: dosed })).toBe(0)
  })
})

describe('integrity gates', () => {
  const ok = (r: BomResult) => Object.fromEntries(bomIntegrity(r).map((g) => [g.id, g.ok]))

  it('holds a clean list', () => {
    expect(ok(result({ items: [item('a', 1)], all_sourced: true }))).toEqual({
      sourced: true,
      'no-ghosts': true,
      'honest-balance': null
    })
  })

  it('misses a figure without a page that is not marked, and all_sourced that disagrees', () => {
    expect(ok(result({ items: [item('a', 1, { source_url: undefined })] })).sourced).toBe(false)
    expect(ok(result({ items: [item('a', 1, { unsourced: true })], all_sourced: true })).sourced).toBe(false)
    expect(
      ok(result({ items: [item('a', 1, { source_url: undefined, unsourced: true })], all_sourced: false }))
        .sourced
    ).toBe(true)
  })

  it('misses a zero-mass ghost and a judged list with open parts', () => {
    expect(ok(result({ items: [item('a', 0)] }))['no-ghosts']).toBe(false)
    const open = { unresolved: [{ component: 'b', reason: 'no_mass' as const }] }
    expect(ok(result({ ...open, balance_ok: true }))['honest-balance']).toBe(false)
    expect(ok(result({ ...open, balance_ok: null }))['honest-balance']).toBe(true)
  })

  it('counts an estimate claimed as certain against honesty', () => {
    const parts = [part('frame', /frame/, { basis: 'estimate' })]
    const sure = partValues(parts, result({ items: [item('frame', 7, { confidence: 'high' })] }))
    const hedged = partValues(parts, result({ items: [item('frame', 7, { confidence: 'low' })] }))
    expect(estimatesHedged(sure).ok).toBe(false)
    expect(estimatesHedged(hedged).ok).toBe(true)
    expect(estimatesHedged(partValues(parts, result())).ok).toBeNull()
  })
})

describe('reference checks', () => {
  it('keeps the other version apart only when its mass carries its own reference', () => {
    const check = otherVersionKeptApart(12.8, 13.2, /4\s*mm|601480/i)
    const v = new Map()
    expect(
      check(
        result({
          totals_found: [{ mass_kg: 13, basis: 'unknown', version: 'EAN 5400431601480 (HDF 4 mm)' }]
        }),
        v
      )
    ).toBe(true)
    expect(
      check(result({ totals_found: [{ mass_kg: 13, basis: 'unknown', version: 'EAN 5400431601459' }] }), v)
    ).toBe(false)
    expect(
      check(result({ versions: { conflict: false, seen: [{ version: 'black', mass_kg: 13.1 }] } }), v)
    ).toBe(true)
    expect(check(result({ totals_found: [{ mass_kg: 14.1, basis: 'unknown' }] }), v)).toBeNull()
  })

  it('misses the other version when its figures are used, however well its total is named', () => {
    const check = otherVersionKeptApart(12.8, 13.2, /4\s*mm|601480/i)
    const named = [{ mass_kg: 13, basis: 'unknown' as const, version: 'EAN 5400431601480 (HDF 4 mm)' }]
    const boards = item('5 Fachböden', 5.75, { version: 'verzinkt (5400431601480)' })
    expect(check(result({ totals_found: named, items: [boards] }), new Map())).toBe(false)
    const used = {
      mass_kg: 24,
      basis: 'unknown' as const,
      source: 'researched' as const,
      version: 'GTIN 5400431601480'
    }
    expect(check(result({ total_used: used }), new Map())).toBe(false)
    const thirteen = { mass_kg: 13, basis: 'unknown' as const, source: 'researched' as const }
    expect(check(result({ total_used: thirteen }), new Map())).toBe(false)
  })

  it('misses parts heavier than the product even while some are open, but waits for the rest below', () => {
    const check = partsSumWithin(10, 16)
    const open = { unresolved: [{ component: 'x', reason: 'no_mass' as const }] }
    expect(check(result({ ...open, items: [item('steel', 17)] }), new Map())).toBe(false)
    expect(check(result({ ...open, items: [item('steel', 6)] }), new Map())).toBeNull()
    expect(check(result({ items: [item('steel', 6)] }), new Map())).toBe(false)
    expect(
      check(
        result({ items: [item('steel', 6), item('box', 9, { packaging: 'sales' }), item('b', 6)] }),
        new Map()
      )
    ).toBe(true)
  })

  const soapLines: RecipeLineOut[] = [
    { name: 'Aqua', inci: 'AQUA', share_pct: 55, rest_to_total: true },
    { name: 'Sodium Laureth Sulfate', inci: 'SODIUM LAURETH SULFATE', share_pct: 30 },
    { name: 'Cocamidopropyl Betaine', share_pct: 7 },
    { name: 'Sodium Chloride', share_pct: 2.4 },
    { name: 'Sodium Benzoate, Potassium Sorbate', share_pct: 0.6 }
  ]
  const missing = SOAP_INCI.filter((n) => !/AQUA|LAURETH|COCAMIDO|CHLORIDE|BENZOATE|SORBATE/.test(n))

  it('finds the printed list when lines and the named missing ingredients account for it', () => {
    const recipe = {
      of: 'soap',
      lines: soapLines,
      closes: true,
      closes_note: '',
      missing_ingredients: missing
    }
    expect(labelFound(SOAP_INCI, 0.8)(result({ recipe }), new Map())).toBe(true)
    expect(
      labelFound(SOAP_INCI, 0.8)(result({ recipe: { ...recipe, missing_ingredients: [] } }), new Map())
    ).toBe(false)
  })

  it('lets a recipe fit the label until ingredients the label lacks pass the limit', () => {
    const main = ['AQUA', 'SODIUM LAURETH SULFATE', 'SODIUM CHLORIDE', 'COCAMIDOPROPYL BETAINE']
    const fits = (lines: RecipeLineOut[]) =>
      fitsLabel(
        SOAP_INCI,
        main,
        2
      )(result({ recipe: { of: 's', lines, closes: true, closes_note: '' } }), new Map())
    expect(fits(soapLines)).toBe(true)
    expect(fits([...soapLines, { name: 'Sodium Lauroyl Sarcosinate', share_pct: 5 }])).toBe(false)
    expect(fits(soapLines.filter((l) => l.name !== 'Sodium Chloride'))).toBe(false)
  })

  it('reads a blend written as one line by each of its names', () => {
    const main = ['AQUA', 'SODIUM LAURETH SULFATE', 'COCAMIDOPROPYL BETAINE']
    const lines: RecipeLineOut[] = [
      { name: 'Aqua', inci: 'Aqua', share_pct: 91.5 },
      {
        name: 'Sodium Laureth Sulfate (and) Cocamidopropyl Betaine',
        inci: 'Sodium Laureth Sulfate, Cocamidopropyl Betaine, Coco-Glucoside',
        share_pct: 8
      },
      { name: 'Cocamide DEA', share_pct: 0.5 }
    ]
    const recipe = { of: 's', lines, closes: true, closes_note: '' }
    expect(fitsLabel(SOAP_INCI, main, 2)(result({ recipe }), new Map())).toBe(true)
    expect(fitsLabel(SOAP_INCI, main, 0.4)(result({ recipe }), new Map())).toBe(false)
  })

  it('weighs a trade form by its constituents, and leaves a share it cannot know unknown', () => {
    const main = ['AQUA', 'SODIUM LAURETH SULFATE']
    const fits = (lines: RecipeLineOut[]) =>
      fitsLabel(
        SOAP_INCI,
        main,
        2
      )(result({ recipe: { of: 's', lines, closes: true, closes_note: '' } }), new Map())
    const water: RecipeLineOut = { name: 'Aqua', inci: 'AQUA', share_pct: 70 }
    const texapon = (sarcosinate: number): RecipeLineOut => ({
      name: 'Texapon X',
      share_pct: 30,
      trade_form: {
        name: 'Texapon X',
        split: true,
        constituents: [
          { name: 'Sodium Laureth Sulfate', pct: 30, share_pct: 9 },
          { name: 'Sodium Lauroyl Sarcosinate', pct: 10, share_pct: sarcosinate },
          { name: 'Aqua', pct: 60, share_pct: 21 - sarcosinate + 3 }
        ]
      }
    })
    // the main ingredient is found inside the trade form; its unlisted constituent counts by its own share
    expect(fits([water, texapon(1)])).toBe(true)
    expect(fits([water, texapon(3)])).toBe(false)
    // a blend of a listed and an unlisted name: how much is unlisted is not known
    const blend: RecipeLineOut = { name: 'Sodium Laureth Sulfate, Sodium Lauroyl Sarcosinate', share_pct: 10 }
    expect(fits([water, { name: 'Sodium Laureth Sulfate', share_pct: 9 }, blend])).toBeNull()
    // an unlisted line without a share is unknown too, unless the known part already passes the limit
    const dye: RecipeLineOut = { name: 'CI 19140' }
    expect(fits([water, { name: 'Sodium Laureth Sulfate', share_pct: 9 }, dye])).toBeNull()
    expect(
      fits([water, { name: 'Sodium Laureth Sulfate', share_pct: 9 }, dye, { name: 'PEG-7', share_pct: 3 }])
    ).toBe(false)
  })
})

describe('the reference products', () => {
  it('give every component they ask for to one of their parts', () => {
    for (const p of REFERENCE_PRODUCTS) {
      const items = p.call.components.map((c) => item(c, 1))
      const v = partValues(p.parts, result({ items }))
      const placed = [...v.values()].reduce((s, x) => s + x.items.length, 0)
      expect(placed, p.name).toBe(items.length)
    }
  })

  it('give each wheelbarrow component the part it names', () => {
    const p = ref('ref-wheelbarrow')
    const v = partValues(p.parts, result({ items: p.call.components.map((c) => item(c, 1)) }))
    const owner = (c: string) => [...v.values()].find((x) => x.items.some((i) => i.component === c))!.part.id
    expect(p.call.components.map(owner)).toEqual(['tub', 'frame', 'wheel', 'wheel', 'handles', 'small'])
  })

  it('score a result that matches the reference as accurate and every gate met', () => {
    const p = ref('ref-wheelbarrow')
    const r = result({
      items: [
        item('Mulde (150 l, Stahlblech)', 11, { material: 'Stahlblech verzinkt' }),
        item('Rahmen/Holme (Stahlrohr)', 6.8, { material: 'Stahlrohr, tauchlackiert', confidence: 'low' }),
        item('Luftreifen mit Schlauch', 1.4, { material: 'Gummi' }),
        item('Stahlfelge', 0.9, { material: 'Stahlblech, lackiert' }),
        item('Buchenholzgriffe (2 Stück)', 0.22, { material: 'Buche' }),
        item('Achse, Lager, Schrauben, Standfüße', 0.45, { material: 'Stahl', confidence: 'medium' })
      ],
      totals_found: [{ mass_kg: 20.7, basis: 'net' }],
      total_used: { mass_kg: 20.7, basis: 'net', source: 'researched' },
      all_sourced: true,
      balance_ok: true
    })
    const v = partValues(p.parts, r)
    expect(accuracy(v).score).toBe(1)
    const gates = referenceGates(p.gates, r, v)
    expect(gates.filter((g) => g.ok === false).map((g) => g.id)).toEqual([])
    // nothing is open, so whether an open list stays unjudged does not arise
    expect(gates.filter((g) => g.ok === null).map((g) => g.id)).toEqual(['honest-balance'])
  })
})

describe('what the judge reads', () => {
  it('takes per part the heaviest sourced entry, by the climate share the part carries, with its note', () => {
    const parts = [part('small', /screw/, { climateShare: 1 }), part('tub', /tub/, { climateShare: 48 })]
    const v = partValues(
      parts,
      result({
        items: [item('screw', 0.1), item('tub', 11, { note: 'spare part weight' }), item('tub rim', 0.5)]
      })
    )
    const c = carryingFromParts(v, result())
    expect(c.map((f) => f.text)).toEqual([
      "tub (steel): 11 kg. The researcher's note: spare part weight",
      'screw (steel): 0.1 kg'
    ])
  })

  it('lets a formulation line stand on the formulation’s page, and hands on a carrying part without any page', () => {
    const parts = [
      part('sles', /laureth/i, { where: 'recipe', climateShare: 27 }),
      part('pouch', /pouch/, { climateShare: 18 })
    ]
    const r = result({
      items: [item('pouch', 0.012, { source_url: undefined, unsourced: true })],
      recipe: {
        of: 'soap',
        formulation: { name: 'Frame MP-01', kind: 'frame', source_url: 'https://example.org/mp-01' },
        lines: [{ name: 'Sodium Laureth Sulfate', share_pct: 8.5 }],
        closes: true,
        closes_note: ''
      }
    })
    const c = carryingFromParts(partValues(parts, r), r)
    expect(c.map((f) => [f.text, f.sources])).toEqual([
      [
        'Sodium Laureth Sulfate: 8.5 % of the mixture, from the formulation "Frame MP-01"',
        ['https://example.org/mp-01']
      ],
      ['pouch (steel): 0.012 kg', []]
    ])
  })

  it('prefers web findings that carry a figure', () => {
    const f = (text: string) => ({ text, sources: ['https://example.org'] })
    expect(carryingFindings([f('no figure'), f('42 %'), f('7 years')]).map((x) => x.text)).toEqual([
      '42 %',
      '7 years'
    ])
    expect(carryingFindings([f('a'), f('b')], 1).map((x) => x.text)).toEqual(['a'])
  })

  it('turns verdicts into one gate, unreadable pages deciding nothing', () => {
    expect(citationGate(['supports', 'partly']).ok).toBe(true)
    expect(citationGate(['supports', 'not_on_page']).ok).toBe(false)
    expect(citationGate(['page_unreadable', 'judge_failed']).ok).toBeNull()
    // a judging cut short by the budget is not scored, whatever it read before
    expect(citationGate(['supports', SKIPPED_FOR_BUDGET]).ok).toBeNull()
  })
})

describe('lookups and the tally', () => {
  it('reads web lookups from both report shapes', () => {
    expect(
      lookupsIn({ server_tool_use_details: { web_search_requests: 2, tool_calls_executed: 2 } })
    ).toEqual({
      search: 2,
      fetch: 0
    })
    expect(lookupsIn({ server_tool_use: { web_search_requests: 3, web_fetch_requests: 1 } })).toEqual({
      search: 3,
      fetch: 1
    })
    expect(lookupsIn({ cost: 0.01 })).toBeNull()
  })

  it('gives each gate its hit rate per scenario and cap, leaving out n/a and stopped runs', () => {
    const run = (lookups: number, ok: Array<boolean | null>, more: Partial<RunRecord> = {}): RunRecord => ({
      scenario: 's',
      lookups,
      repeat: 1,
      ms: 1000,
      usd: 0.1,
      judgeUsd: 0,
      // the cap holds per tool: two searches and two fetches do not reach a cap of four
      webRequests: [
        { search: lookups, fetch: 0 },
        { search: 2, fetch: 2 }
      ],
      gates: ok.map((o, i) => ({ id: `g${i}`, kind: 'fact', label: '', ok: o })),
      accuracy: 0.5,
      ...more
    })
    const s = summarise([
      run(4, [true, null]),
      run(4, [false, true], { accuracy: 0.9 }),
      run(4, [false, false], { error: 'stopped at the run ceiling' }),
      run(8, [true, true])
    ])
    expect(s).toHaveLength(2)
    const four = s.find((x) => x.lookups === 4)!
    expect(four.runs).toBe(3)
    expect(four.errors).toBe(1)
    expect(four.gates.map((g) => [g.id, g.hits, g.of])).toEqual([
      ['g0', 1, 2],
      ['g1', 1, 1]
    ])
    expect(four.accuracy).toEqual({ mean: 0.7, min: 0.5, max: 0.9 })
    expect(four.atCap).toEqual({ requests: 3, of: 6 })
    expect(s.find((x) => x.lookups === 8)!.atCap).toEqual({ requests: 1, of: 2 })
    expect(four.lookupsMax).toBe(4)
  })
})
