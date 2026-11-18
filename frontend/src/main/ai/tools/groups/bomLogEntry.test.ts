import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import type { BomItem, BomLeg } from '../../bomAnswer'
import { weighBom } from '../../bomBalance'
import { parseRecipeAnswer } from '../../bomRecipe'
import { weighRecipe } from '../../recipeBalance'
import { bomLogEntry } from './bomLogEntry'
import { researchTools } from './research'

const leg = (l: Partial<BomLeg>): BomLeg => ({
  items: [],
  unresolved: [],
  product_masses: [],
  versions_seen: [],
  ...l
})
const item = (component: string, mass_kg: number, more: Partial<BomItem> = {}): BomItem => ({
  component,
  material: '',
  mass_kg,
  ...more
})

const researchBom = researchTools.find((t) => t.spec.function.name === 'research_bom')!

const run = async (result: unknown, args: Record<string, unknown> = { product: 'rack' }) => {
  const posts: Array<{ path: string; body: any }> = []
  const out = await researchBom.run(args, {
    api: async (_m: string, path: string, body: any) => (posts.push({ path, body }), { added: 1 }),
    ui: async () => ({}),
    activeDb: 'demo-model',
    research: async () => result
  } as unknown as ToolCtx)
  return { posts: posts.filter((p) => p.path === '/api/v1/provenance/research'), out }
}

describe('the research log entry of a bill-of-materials call', () => {
  it('is written for a call that found no mass at all, with what it could not settle', async () => {
    const result = {
      product: 'rack',
      ...weighBom([
        {
          request: 'frame',
          leg: leg({ unresolved: [{ component: 'frame', reason: 'no_mass', note: 'not published' }] })
        },
        { request: 'feet', error: 'timed out' }
      ]),
      evidence: [],
      sources: []
    }
    const { posts } = await run(result, { product: 'rack', context: 'Atlas, NL', total_mass_kg: 13 })
    expect(posts).toHaveLength(1)
    const [entry] = posts[0].body.entries
    expect(entry.question).toBe('Bill of materials: rack')
    expect(entry.findings).toEqual([])
    // The given total first: it is the figure the check was made against.
    expect(entry.context).toBe('total mass given: 13 kg; Atlas, NL')
    expect(entry.bom_check.summary).toMatch(/0 of 2 requested components/)
    expect(entry.bom_check.requests).toEqual([
      { component: 'frame', status: 'no_mass' },
      { component: 'feet', status: 'failed' }
    ])
    expect(entry.bom_check.unresolved[0]).toEqual({
      component: 'frame',
      reason: 'no_mass',
      note: 'not published'
    })
  })

  it('keeps a part’s derivation and whether its page came from the search, and the totals and versions', () => {
    const EAN459 = 'EAN 5400431601459'
    const EAN480 = 'EAN 5400431601480'
    const result = weighBom([
      {
        request: 'boards',
        leg: leg({
          items: [
            item('5 Holzböden (HDF, 5 mm)', 7.65, {
              count: 5,
              mass_each_kg: 1.53,
              version: EAN459,
              source_url: 'https://www.praxis.nl/x/10119671',
              note: '0.9 × 0.4 × 0.005 m × 850 kg/m³ = 1.53 kg per board',
              cited_by_search: false
            })
          ]
        })
      },
      {
        request: 'total',
        leg: leg({
          product_masses: [
            { mass_kg: 13, basis: 'net', version: EAN480, source_url: 'https://www.praxis.nl/x/10322182' },
            { mass_kg: 24, basis: 'unknown', version: 'Atlas 175 HDF4' }
          ],
          versions_seen: [{ version: 'EAN 5400431601435', mass_kg: 13.1, sold_by: 'Hubo' }]
        })
      }
    ])
    const entry = bomLogEntry({ product: 'rack' }, result) as any
    expect(entry.findings).toHaveLength(1)
    expect(entry.findings[0]).toMatchObject({
      text: '5 Holzböden (HDF, 5 mm) (5 pieces): 7.65 kg',
      component: '5 Holzböden (HDF, 5 mm)',
      mass_kg: 7.65,
      note: '0.9 × 0.4 × 0.005 m × 850 kg/m³ = 1.53 kg per board',
      version: EAN459,
      cited_by_search: false
    })
    expect(entry.bom_check.totals).toEqual([
      { mass_kg: 13, basis: 'net', version: EAN480, source: 'https://www.praxis.nl/x/10322182' },
      { mass_kg: 24, basis: 'unknown', version: 'Atlas 175 HDF4' }
    ])
    expect(entry.bom_check.versions.conflict).toBe(true)
    expect(entry.bom_check.versions.used.map((u: any) => u.version)).toContain(EAN459)
    expect(entry.bom_check.versions.seen).toEqual([
      { version: 'EAN 5400431601435', mass_kg: 13.1, sold_by: 'Hubo' }
    ])
    expect(entry.context).toBeUndefined()
  })

  it('writes nothing for an answer that is no check, and the result still comes back', async () => {
    expect(bomLogEntry({ product: 'rack' }, { error: 'no provider' } as any)).toBeNull()
    expect(bomLogEntry({ product: 'rack' }, null)).toBeNull()
    const { posts, out } = await run({ error: 'no provider' })
    expect(posts).toEqual([])
    expect(JSON.parse(out as string).error).toBe('no provider')
  })
})

describe('the research log entry of a part with other figures', () => {
  // The health check reads a finding as a part to book when it carries a component and a mass, or when its text ends
  // on "<mass> kg" (older entries); an alternative must be neither, or it is named as never booked.
  const BOM_TEXT = /^(.+?)(?:\s*\([^)]*\))?:\s*([0-9]+(?:\.[0-9]+)?)\s*kg\s*$/

  it('logs each alternative with its own page as a documented figure, after the masses to book', () => {
    const weighed = weighBom([
      {
        request: 'pouch',
        leg: leg({
          items: [
            item('Nachfüllbeutel', 0.0102, {
              material: 'PET/PE',
              source_url: 'https://e.org/alufrei',
              alternatives: [
                {
                  mass_kg: 0.0103,
                  material: 'PET/ALU/PE',
                  source_url: 'https://e.org/alu',
                  note: 'barrier variant'
                },
                { mass_kg: 0.012 }
              ]
            })
          ]
        })
      }
    ])
    const entry = bomLogEntry(
      { product: 'refill pouch' },
      { ...weighed, product: 'refill pouch', sources: [], evidence: [] }
    )!
    const findings = entry.findings as Array<Record<string, unknown>>
    // The counted figure stays the part to book, and names its other figures: a booking of one of them books it too.
    expect(findings[0]).toMatchObject({
      component: 'Nachfüllbeutel',
      mass_kg: 0.0102,
      alternatives_kg: [0.0103, 0.012]
    })
    expect(findings.map((f) => f.text)).toEqual([
      'Nachfüllbeutel (PET/PE): 0.0102 kg',
      'Alternative figure for "Nachfüllbeutel": 0.0103 kg (PET/ALU/PE) — not counted (the research counted 0.0102 kg)'
    ])
    const alt = findings[1]
    expect(alt).toEqual({
      text: alt.text,
      sources: ['https://e.org/alu'],
      note: 'barrier variant'
    })
    expect(String(alt.text)).not.toMatch(BOM_TEXT)
  })
})

describe('the research log entry of a call with a recipe', () => {
  const soap = weighRecipe(
    parseRecipeAnswer({
      formulation: { name: 'MP-01', kind: 'frame', source_url: 'https://pcc.example/mp01.pdf' },
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

  it('logs each substance once — water added and water of the solution as one mass — beside the parts', async () => {
    const result = {
      product: 'soap refill',
      ...weighBom(
        [{ request: 'pouch', leg: leg({ items: [item('pouch', 0.02, { source_url: 'https://e.org/p' })] }) }],
        {
          recipe: soap
        }
      )
    }
    const { posts } = await run(result, { product: 'soap refill', recipe: { mass_kg: 0.5 } })
    const entry = posts[0].body.entries[0]
    expect(entry.findings.map((f: { text: string }) => f.text)).toEqual([
      'pouch: 0.02 kg',
      'water (91.9 %): 0.4595 kg',
      'sodium laureth sulfate (8.1 %): 0.0405 kg'
    ])
    expect(entry.findings[1]).toMatchObject({
      component: 'water',
      mass_kg: 0.4595,
      sources: ['https://pcc.example/mp01.pdf', 'https://supplier.example/sles27.pdf'],
      note: 'recipe of liquid soap (MP-01); 0.35 kg as dosed + 0.1095 kg from SLES 27 % solution'
    })
    expect(entry.bom_check.recipe).toMatchObject({
      of: 'liquid soap',
      closes: true,
      gap_pct: 0,
      split: ['SLES 27 % solution']
    })
  })

  it("logs where the recipe contradicts the order of the product's INCI list, one sentence each", async () => {
    const reversed = weighRecipe(
      parseRecipeAnswer({
        formulation: { name: 'MP-01', kind: 'frame', source_url: 'https://pcc.example/mp01.pdf' },
        lines: [
          { name: 'Aqua', amount: 90, unit: '%' },
          { name: 'Glycerin', amount: 2, unit: '%' },
          { name: 'Cocamidopropyl Betaine', amount: 8, unit: '%' }
        ]
      }),
      { of: 'liquid soap', request: { inci_list: ['Aqua', 'Glycerin', 'Cocamidopropyl Betaine'] } }
    )
    const { posts } = await run({ product: 'soap', ...weighBom([], { recipe: reversed }) })
    expect(posts[0].body.entries[0].bom_check.recipe.inci_order).toEqual([
      'Glycerin (no. 2) is listed before Cocamidopropyl Betaine (no. 3), but the recipe gives 2 % against 8 %'
    ])
    // In the order, nothing is logged: an empty list would only be dropped on the way.
    const { posts: inOrder } = await run({ product: 'soap', ...weighBom([], { recipe: soap }) })
    expect(inOrder[0].body.entries[0].bom_check.recipe).not.toHaveProperty('inci_order')
  })

  it('logs shares without a mass as text the health check does not read', async () => {
    const shares = weighRecipe(
      parseRecipeAnswer({
        formulation: { name: 'MP-01', kind: 'frame', source_url: 'https://pcc.example/mp01.pdf' },
        lines: [
          { name: 'water', amount: 88, unit: '%' },
          { name: 'SLES 70 %', amount: 12, unit: '%' }
        ]
      }),
      { of: 'liquid soap', request: {} }
    )
    const { posts } = await run({ product: 'soap', ...weighBom([], { recipe: shares }) })
    const findings = posts[0].body.entries[0].findings
    expect(findings).toEqual([
      {
        text: 'water: 88 % of liquid soap',
        sources: ['https://pcc.example/mp01.pdf'],
        note: 'recipe of liquid soap (MP-01)'
      },
      {
        text: 'SLES 70 %: 12 % of liquid soap',
        sources: ['https://pcc.example/mp01.pdf'],
        note: 'recipe of liquid soap (MP-01)'
      }
    ])
  })

  it('refuses a recipe sent as a string, naming how it arrived, and passes a real one through', async () => {
    let passed: unknown
    const call = (args: Record<string, unknown>) =>
      researchBom.run(args, {
        api: async () => ({}),
        ui: async () => ({}),
        research: async (o: unknown) => ((passed = o), { summary: 'x', items: [] })
      } as unknown as ToolCtx)
    const refused = JSON.parse(
      String(await call({ product: 'soap', recipe: '{"of": "soap", "mass_kg": 0.5}' }))
    )
    expect(refused.error).toMatch(/"recipe" arrived as ONE string, not an object/)
    expect(passed).toBeUndefined()
    const bad = JSON.parse(String(await call({ product: 'soap', recipe: { ingredients: 'Aqua, Glycerin' } })))
    expect(bad.error).toMatch(/"recipe.ingredients" arrived as ONE string, not an array/)
    const inci = JSON.parse(String(await call({ product: 'soap', recipe: { inci_list: 'Aqua, Glycerin' } })))
    expect(inci.error).toMatch(/"recipe.inci_list" arrived as ONE string, not an array/)
    await call({ product: 'soap', recipe: { inci_list: ['Aqua', ' ', 'Glycerin'] } })
    expect(passed).toMatchObject({ recipe: { inci_list: ['Aqua', 'Glycerin'] } })
    const mass = JSON.parse(String(await call({ product: 'soap', recipe: { mass_kg: '0.5' } })))
    expect(mass.error).toMatch(/"recipe.mass_kg" arrived as "0.5"/)
    await call({ product: 'soap', recipe: { of: ' liquid soap ', mass_kg: 0.5, ingredients: ['Aqua', ' '] } })
    expect(passed).toMatchObject({ recipe: { of: 'liquid soap', mass_kg: 0.5, ingredients: ['Aqua'] } })
    // 0 is padding, as in a count: left out, not refused.
    await call({ product: 'soap', recipe: { of: 'liquid soap', mass_kg: 0 } })
    expect(passed).toMatchObject({ recipe: { of: 'liquid soap' } })
    expect((passed as { recipe: object }).recipe).not.toHaveProperty('mass_kg')
  })
})
