import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat } from '../test/fakeStream'

/**
 * The literature: the introduction and the interpretation may search the web when the report allows
 * it. The brief says whether (`literature`), the caller binds the researcher, and a chapter makes at
 * most `RESEARCH_CALLS` such calls — each one a fan of paid searches that takes minutes.
 */
vi.mock('../client', async () => (await import('../test/fakeStream')).clientModuleMock())
chat.alwaysDelta = true
chat.gateCallsOnTools = true
chat.defaultUsage = { cost: 0.0004, prompt_tokens: 900 }
chat.defaultFinish = 'stop'
chat.fallbackText = 'A chapter.'

const { writeSection } = await import('../reportWriter')
const { RESEARCH_CALLS, writerTools } = await import('./lookups')
const { writerSystem } = await import('./messages')

const brief = {
  kind: 'introduction',
  title: 'Introduction',
  language: 'English',
  prompt: 'Write the introduction.',
  literature: true,
  study: { goal: 'Screen a carrier bag', functional_unit: 'one bag' },
  data: { activity: { name: 'bag', database: 'm', code: 'c' }, results: [] }
}

const call = (name: string, args: Record<string, unknown>, id: string) => ({
  id,
  name,
  arguments: JSON.stringify(args)
})
const offered = (i = 0): string[] =>
  ((chat.seen[i]?.tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name)

let recorded: unknown[] = []
const api = async (_m: string, path: string, body?: unknown): Promise<unknown> => {
  if (path === '/api/v1/provenance/research') recorded.push(body)
  return { activity: { name: 'bag' } }
}
const researchWeb = vi.fn(async (o: { question: string }) => ({
  question: o.question,
  findings: [
    { text: 'Directive (EU) 2015/720 limits lightweight bags.', sources: ['https://eur-lex.europa.eu'] }
  ],
  sources: ['https://eur-lex.europa.eu'],
  unsourced_dropped: 0,
  evidence: []
}))

beforeEach(() => {
  chat.rounds = []
  chat.seen.length = 0
  recorded = []
  researchWeb.mockClear()
})

describe('searching the literature', () => {
  it('belongs to the chapter only when the brief allows it and a researcher is bound', async () => {
    expect(writerTools('introduction', true)).toContain('research_web')
    expect(writerTools('introduction')).not.toContain('research_web')
    await writeSection({ brief, api, activeDb: 'm', researchWeb })
    expect(offered()).toContain('research_web')
    chat.seen.length = 0
    // Allowed by the report, but nobody bound a researcher to this run: no web.
    await writeSection({ brief, api, activeDb: 'm' })
    expect(offered()).not.toContain('research_web')
    chat.seen.length = 0
    await writeSection({ brief: { ...brief, literature: false }, api, activeDb: 'm', researchWeb })
    expect(offered()).not.toContain('research_web')
  })

  it('records what it found with the study, keeps it as evidence, and stops after the allowance', async () => {
    chat.rounds = [
      ...Array.from({ length: RESEARCH_CALLS + 1 }, (_, i) => ({
        calls: [call('research_web', { question: `question ${i}` }, `r${i}`)]
      })),
      { text: 'The introduction.' }
    ]
    const out = await writeSection({ brief, api, activeDb: 'm', researchWeb })
    expect(researchWeb).toHaveBeenCalledTimes(RESEARCH_CALLS)
    expect(recorded).toHaveLength(RESEARCH_CALLS)
    expect(out.lookups.filter((l) => l.name === 'research_web')).toHaveLength(RESEARCH_CALLS)
    // The refused call is told why, and costs nothing.
    const refusal = chat.seen.at(-1)?.messages.at(-1)
    expect(String(refusal?.content)).toContain('No more web research for this chapter')
  })

  it('tells the writer it may quote a researched figure — and only when it may search', () => {
    expect(writerSystem(brief, true, true)).toContain('One exception: a figure from a research finding')
    expect(writerSystem(brief, true, false)).not.toContain('research finding')
  })
})
