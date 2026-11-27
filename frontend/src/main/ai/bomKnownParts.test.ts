import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat } from './test/fakeStream'
import { knownPartsArg } from './bomKnownParts'
import { chatRecord, onChatRecord } from './bomChatRecord'
import type { LegOutcome } from './bomBalance'
import { bomLogEntry } from './tools/groups/bomLogEntry'

/**
 * Parts the chat already has a mass for, given to research_bom as `known_parts`: read, weighed with the researched
 * ones, held against the chat's own record of pages, and logged with their origin.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())
chat.alwaysDelta = true

const { researchBom } = await import('./researchBom')

const answer = (o: unknown): { text: string } => ({ text: JSON.stringify(o) })
const known = (raw: unknown): LegOutcome[] => {
  const k = knownPartsArg(raw)
  if (!Array.isArray(k)) throw new Error(String(k))
  return k
}

beforeEach(() => {
  chat.seen.length = 0
  chat.rounds = []
  chat.fallbackText = ''
})

describe('knownPartsArg', () => {
  it('reads one outcome per part, marked known, with the origin on its figure', () => {
    const k = known([
      { component: 'tub', material: 'steel', mass_kg: 11, source_url: 'https://shop.example/tub' },
      { component: 'grips', material: 'beech', count: 2, mass_each_kg: 0.114, stated_by_user: true }
    ])
    expect(k.map((o) => [o.request, o.known])).toEqual([
      ['tub', true],
      ['grips', true]
    ])
    expect(k[0].leg?.items[0]).toMatchObject({ mass_kg: 11, origin: 'assistant' })
    // A piece mass is multiplied by its count, by the same rule as a researched entry.
    expect(k[1].leg?.items[0]).toMatchObject({ mass_kg: 0.228, count: 2, origin: 'user' })
  })

  it('keeps a known part without a mass as an open one, never as a figure', () => {
    const k = known([{ component: 'screws', material: 'steel' }])
    expect(k[0].leg?.items).toEqual([])
    expect(k[0].leg?.unresolved).toEqual([
      expect.objectContaining({ component: 'screws', reason: 'no_mass' })
    ])
  })

  it('refuses what it cannot read, and says what to send instead', () => {
    expect(knownPartsArg('[{"component":"tub"}]')).toMatch(/arrived as ONE string/)
    expect(knownPartsArg({ component: 'tub' })).toMatch(/must be an array of objects/)
    expect(knownPartsArg([{ mass_kg: 3 }])).toMatch(/"known_parts\[0\]" has no "component"/)
    expect(knownPartsArg(Array.from({ length: 25 }, (_, i) => ({ component: `p${i}`, mass_kg: 1 })))).toMatch(
      /at most 24 — group the small parts/
    )
    expect(
      knownPartsArg([
        { component: 'Frame', mass_kg: 5 },
        { component: ' frame ', mass_kg: 5 }
      ])
    ).toMatch(/names "frame" twice \(entries 0 and 1\)/)
    expect(knownPartsArg(undefined)).toBeUndefined()
    expect(knownPartsArg([])).toBeUndefined()
  })
})

describe('weighing known parts', () => {
  const list = [
    { component: 'tub', material: 'steel', mass_kg: 11, source_url: 'https://shop.example/tub' },
    {
      component: 'frame',
      material: 'steel tube',
      mass_kg: 6.4,
      note: '2 × 1.9 m tube 34 × 1.5 mm at 7850 kg/m³'
    },
    { component: 'wheel', material: 'rubber, steel', mass_kg: 2.5, stated_by_user: true },
    { component: 'grips', material: 'beech', mass_kg: 0.23, source_url: 'https://invented.example/grips' }
  ]
  const pages = chatRecord([{ searches: [{ results: [{ url: 'https://shop.example/tub' }] }] }], [], [])

  it('with nothing to research, runs no leg, weighs the whole list and judges it against the total', async () => {
    const r = await researchBom({
      product: 'wheelbarrow',
      totalMassKg: 20.7,
      known: known(list),
      onChatRecord: (url) => onChatRecord(pages, url)
    })
    expect(chat.seen).toHaveLength(0)
    expect(r.sum_kg).toBeCloseTo(20.13, 6)
    expect(r.balance_ok).toBe(true)
    expect(r.requests).toEqual([])
    expect(r.coverage).toEqual({ requested: 0, with_mass: 0, known: 4 })
    expect(r.summary).toMatch(
      /^4 known parts given, nothing researched; parts sum to 20\.13 kg\. Checked against/
    )
    // Sources: a page on the chat's record, one on none, a derivation without a page, a figure the user stated.
    const by = Object.fromEntries(r.items.map((i) => [i.component, i]))
    expect(by.tub).toMatchObject({ cited_by_search: true, origin: 'assistant' })
    expect(by.grips).toMatchObject({ cited_by_search: false, origin: 'assistant' })
    expect(by.frame).toMatchObject({ unsourced: true, origin: 'assistant' })
    expect(by.wheel.unsourced).toBeUndefined()
    expect(r.unsourced).toEqual(['frame'])
    // The result's sources name the backed page, not the one no lookup returned.
    expect(r.sources).toContain('https://shop.example/tub')
    expect(r.sources).not.toContain('https://invented.example/grips')
    expect(r.note).toMatch(/1 known part's source_url is backed by no lookup/)
  })

  it('beside researched components: the legs research only those, and the balance covers both', async () => {
    chat.rounds = [
      answer({
        items: [
          { component: 'axle and bolts', material: 'steel', mass_kg: 0.4, source_url: 'https://e.org/a' }
        ]
      })
    ]
    const r = await researchBom({
      product: 'wheelbarrow',
      totalMassKg: 20.7,
      components: ['axle and bolts'],
      known: known(list),
      onChatRecord: (url) => onChatRecord(pages, url)
    })
    expect(chat.seen).toHaveLength(1)
    const question = String(chat.seen[0].messages.at(-1)?.content)
    expect(question).toMatch(/Already known, not to be researched: "tub", "frame", "wheel", "grips"\./)
    expect(r.requests).toEqual([{ component: 'axle and bolts', status: 'with_mass' }])
    expect(r.sum_kg).toBeCloseTo(20.53, 6)
    expect(r.balance_ok).toBe(true)
    expect(r.summary).toMatch(
      /^1 of 1 requested components came back with a mass of their own, beside 4 known parts given/
    )
    // The researched part is held against the researchers' citations, not the chat's record.
    expect(r.items.find((i) => i.component === 'axle and bolts')?.origin).toBeUndefined()
  })

  it('never researches a known part that came without a mass: it stays open and the verdict waits for it', async () => {
    const r = await researchBom({
      product: 'wheelbarrow',
      totalMassKg: 20.7,
      known: known([...list, { component: 'paint' }])
    })
    expect(chat.seen).toHaveLength(0)
    expect(r.balance_ok).toBeNull()
    expect(r.unresolved.map((u) => u.component)).toEqual(['paint'])
  })

  it('beside a recipe: only the mixture is researched, and the summary does not say nothing was', async () => {
    chat.rounds = [
      answer({
        formulation: { name: 'MP-01', kind: 'frame', source_url: 'https://pcc.example/mp01.pdf' },
        lines: [
          { name: 'water', amount: null, unit: '%', rest_to_total: true },
          { name: 'glycerin', amount: 2, unit: '%' }
        ]
      })
    ]
    const r = await researchBom({
      product: 'liquid soap refill, 500 ml',
      totalMassKg: 0.52,
      recipe: { of: 'liquid soap', mass_kg: 0.5 },
      known: known([{ component: 'pouch', material: 'PE/PET', mass_kg: 0.02, stated_by_user: true }])
    })
    expect(chat.seen).toHaveLength(1)
    expect(r.summary).toMatch(/1 known part given;/)
    expect(r.summary).not.toMatch(/nothing researched/)
    expect(r.balance_ok).toBe(true)
  })

  it('is logged with its origin; a part the user stated is not marked as lacking a source', async () => {
    const r = await researchBom({
      product: 'wheelbarrow',
      totalMassKg: 20.7,
      known: known(list),
      onChatRecord: (url) => onChatRecord(pages, url)
    })
    const entry = bomLogEntry({ product: 'wheelbarrow', totalMassKg: 20.7 }, r)
    const rows = Object.fromEntries(
      (entry?.findings as Array<Record<string, unknown>>).map((f) => [f.component, f])
    )
    expect(rows.tub).toMatchObject({
      origin: 'assistant',
      sources: ['https://shop.example/tub'],
      cited_by_search: true
    })
    expect(rows.frame).toMatchObject({
      origin: 'assistant',
      unsourced: true,
      note: expect.stringMatching(/7850/)
    })
    expect(rows.wheel).toMatchObject({ origin: 'user', sources: [] })
    expect(rows.wheel.unsourced).toBeUndefined()
    expect(rows.grips).toMatchObject({ cited_by_search: false })
  })
})
