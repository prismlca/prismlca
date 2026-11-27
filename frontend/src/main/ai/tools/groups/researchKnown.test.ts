/**
 * research_bom's `known_parts` at the tool: what it refuses, that weighing a list needs no web, and what a known
 * part's page is held against — the chat's lookups, the user's addresses and the model's research log.
 */
import { describe, expect, it, vi } from 'vitest'
import { researchTools } from './research'
import { researchBom } from '../../researchBom'
import type { ToolCtx } from '../context'

const tool = researchTools.find((t) => t.spec.function.name === 'research_bom')!

const LOG = [
  {
    question: 'Bill of materials: wheelbarrow',
    findings: [{ text: 'tub: 11 kg', sources: ['https://log.example/tub'], cited_by_search: true }]
  }
]

function ctx(over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    api: vi.fn(async (method: string) => (method === 'GET' ? LOG : {})),
    ui: vi.fn(),
    activeDb: 'Barrow',
    research: vi.fn(async (o) => researchBom(o)),
    webLookups: () => [{ searches: [{ results: [{ url: 'https://shop.example/frame' }] }] }],
    researchAnswers: () => [{ evidence: [{ url: 'https://maker.example/sheet.pdf' }] }],
    ...over
  }
}

const run = async (a: Record<string, unknown>, c: ToolCtx): Promise<Record<string, any>> =>
  JSON.parse((await tool.run(a, c)) as string)

describe('research_bom known_parts', () => {
  it('weighs a list the chat already has without any research — and logs it with origins', async () => {
    const c = ctx()
    const r = await run(
      {
        product: 'wheelbarrow',
        total_mass_kg: 20,
        known_parts: [
          { component: 'tub', mass_kg: 11, source_url: 'https://log.example/tub' },
          { component: 'frame', mass_kg: 6.5, source_url: 'https://shop.example/frame' },
          { component: 'wheel', mass_kg: 2.3, source_url: 'https://maker.example/sheet.pdf' },
          { component: 'grips', mass_kg: 0.2, stated_by_user: true }
        ]
      },
      c
    )
    expect(r.error).toBeUndefined()
    expect(r.balance_ok).toBe(true)
    // Each page is backed: by the log, by the chat's search, by a research answer's evidence.
    expect(r.items.filter((i: any) => i.source_url).map((i: any) => i.cited_by_search)).toEqual([
      true,
      true,
      true
    ])
    const post = (c.api as ReturnType<typeof vi.fn>).mock.calls.find((call) => call[0] === 'POST')!
    expect(post[1]).toBe('/api/v1/provenance/research')
    const origins = post[2].entries[0].findings.map((f: any) => f.origin)
    expect(origins).toEqual(['assistant', 'assistant', 'assistant', 'user'])
  })

  it('is refused with the web off, like any call of it — the tool is not offered then', async () => {
    const c = ctx({ webSearchAllowed: false })
    for (const args of [
      { product: 'wheelbarrow', components: ['axle'], known_parts: [{ component: 'tub', mass_kg: 11 }] },
      { product: 'wheelbarrow', known_parts: [{ component: 'tub', mass_kg: 11 }] }
    ])
      expect((await run(args, c)).error).toMatch(/Web search is switched off/)
    expect(c.research).not.toHaveBeenCalled()
  })

  it('refuses a part sent as known and as a component, and a list it cannot read', async () => {
    const c = ctx()
    const twice = await run(
      { product: 'wheelbarrow', components: ['Frame'], known_parts: [{ component: 'frame', mass_kg: 6 }] },
      c
    )
    expect(twice.error).toMatch(/"frame" stands under "known_parts" and under "components"/)
    const bad = await run({ product: 'wheelbarrow', known_parts: '[{"component":"tub"}]' }, c)
    expect(bad.error).toMatch(/arrived as ONE string/)
    expect(c.research).not.toHaveBeenCalled()
  })

  it('reads no log when no part is known', async () => {
    const c = ctx({ research: vi.fn(async () => ({ summary: 'ok', items: [] })) })
    await run({ product: 'wheelbarrow', components: ['tub'] }, c)
    expect((c.api as ReturnType<typeof vi.fn>).mock.calls.some((call) => call[0] === 'GET')).toBe(false)
    expect((c.research as ReturnType<typeof vi.fn>).mock.calls[0][0].known).toBeUndefined()
  })
})
