import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { TOOL_BY_NAME } from '../index'
import { reviewLogFact } from './reviewLogFact'

const REVIEWS = '/api/v1/provenance/review'

/** A backend with a review log and a study endpoint; records every call. */
function backend(reviews: unknown, opts: { failPost?: boolean; failLog?: boolean } = {}) {
  const calls: { method: string; path: string; body?: any }[] = []
  const ctx: ToolCtx = {
    api: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      if (path.startsWith(REVIEWS)) {
        if (opts.failLog) throw new Error('log unreadable')
        return reviews
      }
      if (method === 'GET') return { limitations: [{ text: 'already recorded' }] }
      if (opts.failPost) throw new Error('Unknown critical-review answer')
      return { ok: true }
    },
    ui: async () => ({}),
    activeDb: 'm',
    model: 'test-model'
  }
  return { ctx, calls }
}

const set = async (ctx: ToolCtx, args: Record<string, unknown>) =>
  JSON.parse((await TOOL_BY_NAME.model_info.run({ action: 'set', ...args }, ctx)) as string)

describe('what the review log holds, said where a review claim is written', () => {
  it('says that no AI review is on record, without asking for one and without touching a review by people', async () => {
    const fact = await reviewLogFact(backend([]).ctx, 'm', true)
    expect(fact).toMatch(/No review by PrismLCA's AI reviewer is recorded for this model/)
    expect(fact).toMatch(/not a request to run a review/)
    expect(fact).toMatch(/A review by people.*stays as it is/)
    // It names the reviewer, not the chat's tool, which an MCP client does not have.
    expect(fact).not.toMatch(/review_model/)
  })

  it('reads an empty log as "not recorded", never as "did not happen"', async () => {
    // A finished review whose recording failed, and a log file that could not be read, both answer [] —
    // so a claim is not called untrue on that alone; the writer keeps it if it saw the review's result.
    const fact = await reviewLogFact(backend([]).ctx, 'm', false)
    expect(fact).toMatch(/nothing on record confirms it: keep it only if you saw that review return a result/)
    expect(fact).not.toMatch(/not true|never (ran|happened)|rewrite it/)
  })

  it('names how many reviews are on record and the latest, and the field rule only for critical_review', async () => {
    const log = [
      { id: 'a', created: '2026-11-14T18:00:00Z' },
      { id: 'b', created: '2026-11-15T18:30:00Z', partial: true }
    ]
    const withField = await reviewLogFact(backend(log).ctx, 'm', true)
    expect(withField).toMatch(/has 2 reviews on record for this model, the latest from 2026-11-15/)
    expect(withField).toMatch(/cut short at its deadline/)
    expect(withField).toMatch(
      /not a critical review under ISO 14044, and is not mentioned in critical_review/
    )

    const limitationsOnly = await reviewLogFact(backend([log[0]]).ctx, 'm', false)
    expect(limitationsOnly).toMatch(/has 1 review on record for this model, the latest from 2026-11-14\.$/)
    expect(limitationsOnly).not.toMatch(/critical_review|cut short/)
  })

  it('says nothing when the log cannot be read, rather than claiming it is empty', async () => {
    expect(await reviewLogFact(backend([], { failLog: true }).ctx, 'm', true)).toBeUndefined()
    expect(await reviewLogFact(backend({ detail: 'not a list' }).ctx, 'm', true)).toBeUndefined()
  })
})

describe('model_info set carries the fact', () => {
  it('beside a written critical_review, and the study is saved as before', async () => {
    const { ctx, calls } = backend([])
    const out = await set(ctx, { critical_review: 'An AI second opinion was obtained.' })
    expect(out.ok).toBe(true)
    expect(out.review_log).toMatch(/No review by PrismLCA's AI reviewer/)
    expect(calls.find((c) => c.path === '/api/v1/study')?.body.critical_review).toBe(
      'An AI second opinion was obtained.'
    )
    expect(calls.some((c) => c.path === `${REVIEWS}?database=m`)).toBe(true)
  })

  it('beside limitations appended with add_limitations', async () => {
    const { ctx } = backend([{ id: 'a', created: '2026-11-15T18:00:00Z' }])
    const out = await set(ctx, { add_limitations: [{ text: 'An open finding of the AI review.' }] })
    expect(out.review_log).toMatch(/has 1 review on record/)
    expect(out.review_log).not.toMatch(/critical_review/)
  })

  it('not for other fields, nor for a padded empty critical_review', async () => {
    const { ctx, calls } = backend([])
    const out = await set(ctx, { goal: 'Compare two packagings.', critical_review: '', limitations: [] })
    expect(out.review_log).toBeUndefined()
    expect(calls.some((c) => c.path.startsWith(REVIEWS))).toBe(false)
  })

  it('a write the backend refuses is reported as before and reads no log', async () => {
    const { ctx, calls } = backend([], { failPost: true })
    await expect(set(ctx, { critical_review: 'x' })).rejects.toThrow(/Unknown critical-review answer/)
    expect(calls.some((c) => c.path.startsWith(REVIEWS))).toBe(false)
  })
})
