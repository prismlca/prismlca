import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { researchTools } from './research'

/**
 * The figure check's record on its way through research_web: into the model's research log, beside the question
 * it was made for, and never into what the model reads (it reads the verdicts on the findings themselves).
 */
const researchWeb = researchTools.find((t) => t.spec.function.name === 'research_web')!

const answer = (o: { question: string; context?: string }) => ({
  question: o.question,
  findings: [
    {
      text: `Rate 60 % (https://blog.example/${o.context ?? 'x'})`,
      sources: [`https://blog.example/${o.context ?? 'x'}`],
      check: { status: 'not_found' }
    }
  ],
  sources: [`https://blog.example/${o.context ?? 'x'}`],
  unsourced_dropped: 0,
  evidence: [],
  web_check: { trigger: { findings: 1, weak: 1, direct: 0 }, figures: [], made_for: o.context ?? 'x' }
})

function run(args: Record<string, unknown>) {
  const posts: Array<{ path: string; body: any }> = []
  const ctx = {
    api: async (_m: string, path: string, body: any) => (posts.push({ path, body }), {}),
    ui: async () => ({}),
    activeDb: 'demo-model',
    maxResearchQuestions: 4,
    researchWeb: async (o: { question: string; context?: string }) => answer(o)
  } as unknown as ToolCtx
  return researchWeb.run(args, ctx).then((out) => ({ out: JSON.parse(out as string), posts }))
}

describe('research_web and the figure check', () => {
  it('logs the check with its question and keeps it out of the answer', async () => {
    const { out, posts } = await run({ question: 'rate?' })
    expect(out).not.toHaveProperty('web_check')
    expect(out.findings[0].check).toEqual({ status: 'not_found' })
    const entry = posts.find((p) => p.path === '/api/v1/provenance/research')!.body.entries[0]
    expect(entry.web_check.made_for).toBe('x')
  })

  it('gives each of two questions with the same text but another context its own check', async () => {
    const { out, posts } = await run({
      detailed_questions: [
        { question: 'recycling rate?', context: 'Germany' },
        { question: 'recycling rate?', context: 'France' }
      ]
    })
    expect(JSON.stringify(out)).not.toMatch(/web_check/)
    const entries = posts.find((p) => p.path === '/api/v1/provenance/research')!.body.entries
    expect(entries.map((e: any) => e.web_check.made_for)).toEqual(['Germany', 'France'])
  })
})
