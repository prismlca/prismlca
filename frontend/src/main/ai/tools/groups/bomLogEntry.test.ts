import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import type { BomItem, BomLeg } from '../../bomAnswer'
import { weighBom } from '../../bomBalance'
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
