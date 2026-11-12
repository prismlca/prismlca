import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { MAX_BATCH_QUERIES, MIN_LIMIT, liftReserved, markOwnDatasets } from './read'
import { RESULT_HARD_MAX_CHARS, capToolResult } from '../../resultBudget'

type Hit = { name: string; database: string; library?: boolean; score: number }
const hits = (): Hit[] => [
  { name: 'a', database: 'ecoinvent-3.12-cutoff', score: 0.9 },
  { name: 'b', database: 'My processes', score: 0.8 },
  { name: 'c', database: 'ecoinvent-3.12-cutoff', score: 0.7 }
]

describe('liftReserved', () => {
  const answer = (): Record<string, unknown> => ({
    hits: [
      { name: 'a', database: 'ecoinvent-3.12-cutoff' },
      { name: 'b', database: 'ecoinvent-3.12-cutoff' },
      { name: 'lib', database: 'My processes', reserved: true },
      { name: 'bafu', database: 'bafu-2026-v1', reserved: true }
    ]
  })

  it('carries the reserved rows where the context budget cannot reach them', () => {
    // An over-long tool result is shortened from the END of its longest list, and the reserved rows
    // sit at the end of `hits` — measured, every one of them vanished from every query of a
    // ten-query batch. They exist precisely to be seen, so they leave the list that gets cut.
    const a = answer()
    liftReserved(a)
    expect((a.hits as unknown[]).map((h: any) => h.name)).toEqual(['a', 'b'])
    expect(a.also_present).toEqual([
      { database: 'My processes', hits: [{ name: 'lib', database: 'My processes' }] },
      { database: 'bafu-2026-v1', hits: [{ name: 'bafu', database: 'bafu-2026-v1' }] }
    ])
    expect(a.also_present_note).toMatch(/Not matches/)
  })

  it('leaves an answer without reserved rows exactly as it was', () => {
    const a: Record<string, unknown> = { hits: [{ name: 'a', database: 'ecoinvent-3.12-cutoff' }] }
    liftReserved(a)
    expect(a.also_present).toBeUndefined()
    expect(a.also_present_note).toBeUndefined()
    expect(() => liftReserved({ error: 'nope' })).not.toThrow()
  })

  it('keeps the field too short to ever be the list that gets shortened', () => {
    const many = {
      hits: Array.from({ length: 12 }, (_, i) => ({
        name: `r${i}`,
        database: 'My processes',
        reserved: true
      }))
    }
    liftReserved(many)
    expect((many as any).also_present[0].hits).toHaveLength(3)
  })
})

describe('search_background batch size', () => {
  const tool = readTools.find((t) => t.spec.function.name === 'search_background')!

  it('refuses a batch wider than it can answer completely, and says how to split it', () => {
    // Not a style rule: a tool result holds 120,000 characters and one query of sixteen hits is
    // 10,400-19,600 of them. Wider batches were measured losing whole queries in silence (7 of 12).
    const queries = Array.from({ length: MAX_BATCH_QUERIES + 1 }, (_, i) => `material ${i}`)
    const api = vi.fn<ToolCtx['api']>(async () => ({ hits: [] }))
    return tool.run({ queries }, { api } as unknown as ToolCtx).then((out) => {
      expect(String(out)).toMatch(new RegExp(`send at most ${MAX_BATCH_QUERIES}`))
      expect(api).not.toHaveBeenCalled()
    })
  })

  it('asks for fewer regions per hit in a batch than for a single query', async () => {
    const api = vi.fn<ToolCtx['api']>(async () => ({ hits: [] }))
    const ctx = { api, backgroundDbs: ['ecoinvent-3.12-cutoff'] } as unknown as ToolCtx
    await tool.run({ queries: ['steel', 'aluminium'] }, ctx)
    // Twelve regions per hit are 77 % of a batch's payload, and the model is still sifting.
    expect((api.mock.calls[0][2] as Record<string, unknown>).variants_cap).toBe(3)
    api.mockClear()
    await tool.run({ query: 'steel' }, ctx)
    expect((api.mock.calls[0][2] as Record<string, unknown>).variants_cap).toBeUndefined()
  })
})

describe('markOwnDatasets', () => {
  const ctx = (libraries: string[]): ToolCtx => ({ libraryDbs: libraries }) as unknown as ToolCtx

  it("marks the user's own datasets in the shape the backend actually returns", () => {
    // `hits`, not `results`. This read `results` until 10.09.2026, so the flag the tool
    // description promises the model was never set — and the test asserted it against a
    // hand-built shape no endpoint produces, which is why nothing caught it.
    const answer = { hits: hits() }
    markOwnDatasets(answer, ctx(['My processes']))
    expect(answer.hits.map((h) => h.library ?? false)).toEqual([false, true, false])
  })

  it('does nothing without a released library, and survives an unexpected shape', () => {
    const none = { hits: hits() }
    markOwnDatasets(none, ctx([]))
    expect(none.hits.some((h) => h.library)).toBe(false)
    expect(() => markOwnDatasets({ error: 'nope' }, ctx(['My processes']))).not.toThrow()
  })
})

import { normaliseActivityTypes, readTools } from './read'
import { vi } from 'vitest'

describe('normaliseActivityTypes', () => {
  it('reads codes and words, once each, and names the three that exist for anything else', () => {
    expect(normaliseActivityTypes(['M', 'market', 'Market group', 'production'])).toEqual({
      types: ['M', 'G', 'P']
    })
    expect(normaliseActivityTypes(undefined)).toEqual({ types: [] })
    expect(normaliseActivityTypes('m')).toEqual({ types: ['M'] })
    const bad = normaliseActivityTypes(['X'])
    expect('error' in bad && bad.error).toMatch(/"P" \(production\), "M" \(market\) or "G"/)
  })
})

describe('search_background filters', () => {
  const tool = readTools.find((t) => t.spec.function.name === 'search_background')!
  const run = async (args: Record<string, unknown>) => {
    const api = vi.fn<ToolCtx['api']>(async () => ({ results: [] }))
    await tool.run(args, { api, ui: vi.fn(), activeDb: 'M', backgroundDbs: ['eco'] } as unknown as ToolCtx)
    return api.mock.calls.map((c) => c[2] as Record<string, unknown>)
  }

  it('sends activity types and the geo-collapse switch only when given', async () => {
    const [plain] = await run({ query: 'steel' })
    expect(plain).not.toHaveProperty('activity_types')
    expect(plain).not.toHaveProperty('collapse_geo')
    const [filtered] = await run({ query: 'steel', activity_types: ['market'], collapse_geo: false })
    expect(filtered.activity_types).toEqual(['M'])
    expect(filtered.collapse_geo).toBe(false)
  })

  it('lets a query in a batch carry its own types', async () => {
    const bodies = await run({
      queries: [{ query: 'steel', activity_types: ['P'] }, 'glass'],
      activity_types: ['M']
    })
    expect(bodies.map((b) => b.activity_types)).toEqual([['P'], ['M']])
  })

  it('refuses an unknown type before searching', async () => {
    const api = vi.fn<ToolCtx['api']>(async () => ({ results: [] }))
    const out = JSON.parse(
      (await tool.run({ query: 'steel', activity_types: ['waste'] }, {
        api,
        ui: vi.fn(),
        activeDb: 'M',
        backgroundDbs: ['eco']
      } as unknown as ToolCtx)) as string
    )
    expect(out.error).toMatch(/Unknown activity type "waste"/)
    expect(api).not.toHaveBeenCalled()
  })
})

describe('search_background limit and what the cut left out (V462, V463)', () => {
  const tool = readTools.find((t) => t.spec.function.name === 'search_background')!
  const call = async (args: Record<string, unknown>, answer: () => unknown = () => ({ hits: [] })) => {
    const api = vi.fn<ToolCtx['api']>(async () => answer())
    const out = await tool.run(args, { api, backgroundDbs: ['eco'] } as unknown as ToolCtx)
    return {
      bodies: api.mock.calls.map((c) => c[2] as Record<string, unknown>),
      out: JSON.parse(String(out))
    }
  }

  it('raises a limit below eight to eight, says so, and asks for what the cut left out', async () => {
    const low = await call({ query: 'gizmo', limit: 5 })
    expect(low.bodies[0]).toMatchObject({ limit: MIN_LIMIT, limit_cap: MIN_LIMIT, beyond_limit: true })
    expect(low.out.limit_raised_to).toBe(8)
    // A limit at or above the minimum is the model's to set, and nothing is said about it.
    const high = await call({ query: 'gizmo', limit: 12 })
    expect(high.bodies[0]).toMatchObject({ limit: 12, limit_cap: 12, beyond_limit: true })
    expect(high.out).not.toHaveProperty('limit_raised_to')
    // Without a limit the defaults hold, and so does their scaling ceiling.
    const none = await call({ query: 'gizmo' })
    expect(none.bodies[0]).toMatchObject({ limit: 25, limit_cap: 40 })
    expect(none.out).not.toHaveProperty('limit_raised_to')
  })

  it('reads 0 as "not set", in a batch too, where a query may carry its own limit', async () => {
    const zero = await call({ query: 'gizmo', limit: 0 })
    expect(zero.bodies[0]).toMatchObject({ limit: 25, limit_cap: 40 })
    expect(zero.out).not.toHaveProperty('limit_raised_to')
    const batch = await call({
      filtered_queries: [{ query: 'a', limit: 3 }, { query: 'b', limit: 0 }, { query: 'c' }],
      limit: 4
    })
    expect(batch.bodies.map((b) => [b.limit, b.limit_cap])).toEqual([
      [8, 8],
      [8, 8], // 0 falls back to the call-level 4, which is raised
      [8, 8]
    ])
    expect(batch.out.results.map((r: any) => r.result.limit_raised_to)).toEqual([8, 8, 8])
  })

  it('caps both query lists in the schema, the run-time refusal staying as the fallback', () => {
    const props = (tool.spec.function.parameters as any).properties
    expect(props.queries.maxItems).toBe(MAX_BATCH_QUERIES)
    expect(props.filtered_queries.maxItems).toBe(MAX_BATCH_QUERIES)
    expect(props.limit.description).toContain('Minimum 8.')
    expect(props.geographies.description).toContain(
      'The limit cuts this queue; the 2 best hits outside come back under outside_region.'
    )
    expect(props.geographies.description).not.toContain('Nothing is dropped')
  })

  it('counts the rows it shows, not the ones moved to also_present', () => {
    const a = {
      count: 5,
      hits: [
        { name: 'a', database: 'eco' },
        { name: 'lib', database: 'My processes', reserved: true }
      ]
    }
    liftReserved(a)
    expect(a.count).toBe(1)
  })

  it('marks library rows under outside_region like hits', () => {
    const answer = {
      hits: hits(),
      outside_region: [
        { name: 'o', database: 'My processes', score: 0.6 } as Hit,
        { name: 'p', database: 'ecoinvent-3.12-cutoff', score: 0.5 } as Hit
      ]
    }
    markOwnDatasets(answer, { libraryDbs: ['My processes'] } as unknown as ToolCtx)
    expect(answer.outside_region.map((h) => h.library ?? false)).toEqual([true, false])
  })

  it('hands the region to the warnings, so an outside hit that scores higher is said in words', async () => {
    const { out } = await call({ query: 'gizmo sulfonate', geographies: ['RER'], limit: 5 }, () => ({
      weak_match: true,
      hits: [{ name: 'market for leachate', geography: 'RER', score: 0.42, weak: true }],
      outside_region: [{ name: 'market for gizmo sulfonate', geography: 'GLO', score: 0.62 }]
    }))
    expect(out.warnings[0]).toMatch(/^Nothing in the RER list/)
    expect(out.warnings[1]).toMatch(/^Outside RER: market for gizmo sulfonate \[GLO\] scores 0\.62/)
  })

  it('six worst-case queries keep every query and its outside rows within the result budget', async () => {
    // The worst case behind MAX_BATCH_QUERIES: sixteen market hits carrying their supplier mix, about
    // 19 600 characters a query. The two outside rows, the note and the count add ~3 % on top; the budget
    // then shortens the longest list — the hits — and never the two rows that exist to be seen.
    const code = (i: number): string => i.toString(16).padStart(32, '0')
    const long = 'market for gizmo sulfonate, linear, petrochemical, technical grade'
    const answer = () => ({
      query: 'q',
      count: 16,
      weak_match: false,
      hits: Array.from({ length: 16 }, (_, i) => ({
        code: code(i),
        name: `${long} ${i}`,
        geography: 'RER',
        product: `${long.slice(11)} ${i}`,
        unit: 'kilogram',
        activity_type: 'M',
        score: 0.61,
        weak: false,
        database: 'ecoinvent-3.12-cutoff',
        variants: ['GLO', 'RER', 'RoW'].map((g, j) => ({
          code: code(100 + j),
          geography: g,
          database: 'ecoinvent-3.12-cutoff'
        })),
        variants_total: 14,
        treatment: false,
        suppliers: Array.from({ length: 4 }, (_, j) => ({
          name: `gizmo sulfonate production, linear, petrochemical, route ${j}`,
          location: 'RER',
          share: 0.2512,
          code: code(200 + j)
        }))
      })),
      outside_region: [0, 1].map((j) => ({
        name: `${long} outside ${j}`,
        geography: 'GLO',
        code: code(300 + j),
        database: 'ecoinvent-3.12-cutoff',
        product: `${long.slice(11)} outside ${j}`,
        unit: 'kilogram',
        score: 0.6
      })),
      outside_region_note: '2 best outside RER; more may exist.',
      more: '6+ similar in RER, 14+ outside'
    })
    const perQuery = JSON.stringify(answer()).length
    expect(perQuery).toBeGreaterThan(19_000)
    const queries = Array.from({ length: MAX_BATCH_QUERIES }, (_, i) => `gizmo ${i}`)
    const { out } = await call({ queries, geographies: ['RER'] }, answer)
    const capped = capToolResult(JSON.stringify(out))
    const parsed = JSON.parse(capped.text)
    expect(parsed.results).toHaveLength(MAX_BATCH_QUERIES)
    for (const r of parsed.results) expect(r.result.outside_region).toHaveLength(2)
    expect(capped.text.length).toBeLessThanOrEqual(RESULT_HARD_MAX_CHARS)
  })
})
