import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { MAX_BATCH_QUERIES, liftReserved, markOwnDatasets } from './read'

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
