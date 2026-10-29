import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat } from './test/fakeStream'

/**
 * A sub-agent shares no history with the parent conversation — that isolation is the point, but it
 * also means anything the parent does not forward is simply gone. These tests pin that the brief
 * actually carries the product, the caller-supplied context and the total mass into every research
 * leg, and that legs run per component. The scripted stream lives in test/fakeStream.ts; every leg
 * is answered with the same one-item BOM.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())
chat.alwaysDelta = true
chat.fallbackText = '[{"component":"x","material":"PET","mass_kg":0.01,"source_url":"https://e.org"}]'

/** The question each research leg was asked (its last message). */
const asked = (): string[] => chat.seen.map((c) => String(c.messages.at(-1)?.content ?? ''))
/** The system brief and effort each leg ran under. */
const legs = (): Array<{ system: string; reasoningEffort?: string }> =>
  chat.seen.map((c) => ({ system: String(c.messages[0]?.content ?? ''), reasoningEffort: c.reasoningEffort }))

const { researchBom } = await import('./subagent')

beforeEach(() => {
  chat.seen.length = 0
})

describe('researchBom brief', () => {
  it('forwards product, context and total mass to the research leg', async () => {
    await researchBom({
      product: '0.5 l PET water bottle',
      context: 'German market, 2025, single-use, height 21 cm',
      totalMassKg: 0.022
    })
    expect(asked()).toHaveLength(1)
    expect(asked()[0]).toContain('0.5 l PET water bottle')
    expect(asked()[0]).toContain('German market, 2025, single-use, height 21 cm')
    expect(asked()[0]).toContain('0.022')
  })

  it('omits the context and mass lines when the caller has none', async () => {
    await researchBom({ product: 'thing' })
    expect(asked()[0]).toContain('thing')
    expect(asked()[0]).not.toContain('Known specifics')
    expect(asked()[0]).not.toContain('Total product mass')
  })

  it('runs one leg per named component and caps them', async () => {
    const r = await researchBom({
      product: 'bottle',
      context: 'PET, 0.5 l',
      components: ['body', 'cap', 'label'],
      totalMassKg: 0.03
    })
    expect(asked()).toHaveLength(3)
    expect(asked().every((q) => q.includes('PET, 0.5 l'))).toBe(true)
    expect(asked().map((q) => /ONLY the component "(.+?)"/.exec(q)?.[1])).toEqual(['body', 'cap', 'label'])
    expect(r.items).toHaveLength(3)
    expect(r.sources).toEqual(['https://e.org'])

    chat.seen.length = 0
    await researchBom({ product: 'x', components: Array.from({ length: 20 }, (_, i) => `c${i}`) })
    expect(asked().length).toBeLessThanOrEqual(8) // hard cap keeps the cost bounded
  })

  it('reports a failed mass balance rather than hiding it', async () => {
    const r = await researchBom({ product: 'bottle', components: ['body'], totalMassKg: 5 })
    expect(r.balance_ok).toBe(false)
    expect(r.note).toMatch(/off/)
  })

  // The two levers against the budget-eater found by the first eval run (2026-08-29): GLM 5.3
  // defaults to reasoning effort "max" and spent a whole leg thinking without writing a line. A
  // research leg is retrieval work, so it runs at LOW effort and is told its wall-clock budget.
  it('runs every leg at low reasoning effort and names the time budget', async () => {
    await researchBom({ product: 'bottle', components: ['body'] })
    expect(legs()).toHaveLength(1)
    expect(legs()[0].reasoningEffort).toBe('low')
    expect(legs()[0].system).toMatch(/Time budget: about 6 minutes/)
    expect(legs()[0].system).toMatch(/write your answer early/)
  })
})
