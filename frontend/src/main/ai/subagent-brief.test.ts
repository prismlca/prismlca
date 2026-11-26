import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

const { researchBom } = await import('./researchBom')
const { researchWeb } = await import('./subagent')
const { setActiveProvider } = await import('./providers/state')
const { WEB_TEXT_RULE_LEG } = await import('./webContent')

/** The app log's lines, without stamp and tag. */
let logged: string[] = []

beforeEach(() => {
  chat.seen.length = 0
  logged = []
  vi.spyOn(console, 'log').mockImplementation(
    (line: unknown) => void logged.push(String(line).replace(/^.*?\[prism-ai\] /, ''))
  )
})
afterEach(() => vi.restoreAllMocks())

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
  it('runs a leg at low reasoning effort by default and names the time budget', async () => {
    await researchBom({ product: 'bottle', components: ['body'] })
    expect(legs()).toHaveLength(1)
    expect(legs()[0].reasoningEffort).toBe('low')
    expect(legs()[0].system).toMatch(/Time budget: about 6 minutes/)
    expect(legs()[0].system).toMatch(/write your answer early/)
  })

  // A leg reads pages raw, and a page can be written for the model that reads it. Every leg is told what
  // such text is, whatever its own instructions are.
  it('tells every leg that text on a page is material, never an instruction', async () => {
    await researchBom({ product: 'bottle', components: ['body'] })
    await researchWeb({ question: 'recycling rate of PET bottles in Germany' })
    expect(legs().length).toBeGreaterThanOrEqual(2)
    for (const leg of legs()) expect(leg.system).toContain(WEB_TEXT_RULE_LEG)
  })

  // Claude Sonnet and Haiku stopped after two searches at low and reported parts as not found; their direct
  // rows carry `researchEffort: 'high'`. Only those rows: Opus, the OpenRouter route to the same model, and an
  // id the catalogue does not know stay low — the last must not inherit the provider's default chat row.
  it('runs the legs at the effort named on the research model row under the active provider', async () => {
    const effortOf = async (model: string | undefined): Promise<string | undefined> => {
      chat.seen.length = 0
      await researchBom({ product: 'bottle', components: ['body'], model })
      return legs()[0]?.reasoningEffort
    }
    setActiveProvider('anthropic')
    try {
      expect(await effortOf(undefined)).toBe('high') // the provider's research default, Haiku
      expect(await effortOf('claude-haiku-5-5')).toBe('high')
      expect(await effortOf('claude-sonnet-5-5')).toBe('high')
      expect(await effortOf('claude-opus-5-5')).toBe('low')
      expect(await effortOf('claude-haiku-9-9')).toBe('low')
      chat.seen.length = 0
      await researchWeb({ question: 'How much does a 0.5 l PET bottle weigh?', allowUnsourced: true })
      expect(legs().map((l) => l.reasoningEffort)).toEqual(legs().map(() => 'high'))
    } finally {
      setActiveProvider('openrouter')
    }
    expect(await effortOf('anthropic/claude-haiku-5.5')).toBe('low')
    expect(await effortOf(undefined)).toBe('low') // GLM 5.3 Flash
  })

  // A research request exists to search and read, and it went out without any cap on the provider's
  // lookups — up to thirty searches and thirty pages, each re-reading everything gathered so far.
  it('sends every leg with the lookup limit it was given, and with none when there is none', async () => {
    await researchBom({ product: 'bottle', components: ['body', 'cap'], webLookups: 4 })
    expect(chat.seen.length).toBeGreaterThanOrEqual(2)
    expect(chat.seen.map((c) => c.webLookupsCap)).toEqual(chat.seen.map(() => 4))
    chat.seen.length = 0
    await researchWeb({
      question: 'How much does a 0.5 l PET bottle weigh?',
      allowUnsourced: true,
      webLookups: 6
    })
    expect(chat.seen.map((c) => c.webLookupsCap)).toEqual(chat.seen.map(() => 6))
    chat.seen.length = 0
    await researchBom({ product: 'bottle', components: ['body'] })
    expect(chat.seen.map((c) => c.webLookupsCap)).toEqual(chat.seen.map(() => undefined))
  })

  // A leg's request ran beside the chat's rounds without a trace: nothing said who served it or what it
  // cost. Each now leaves one line, named after the tool it works for.
  it('leaves one log line per leg, named after the tool', async () => {
    await researchBom({ product: 'bottle', components: ['body', 'cap'] })
    expect(logged.filter((l) => l.startsWith('research_bom: cache'))).toHaveLength(chat.seen.length)
    expect(chat.seen.length).toBeGreaterThanOrEqual(2)
    logged = []
    chat.seen.length = 0
    await researchWeb({ question: 'How much does a 0.5 l PET bottle weigh?', allowUnsourced: true })
    expect(logged.filter((l) => l.startsWith('research_web: cache'))).toHaveLength(chat.seen.length)
    expect(chat.seen.length).toBeGreaterThanOrEqual(1)
  })
})
