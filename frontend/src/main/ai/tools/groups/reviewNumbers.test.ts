import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { numbersFingerprint, rememberJudged, withTextOnlyNote } from './reviewNumbers'
import { reviewTools } from './review'

const model = (amount: number, comment: string, more: Record<string, unknown> = {}) => [
  {
    code: 'mix',
    name: 'Soap recipe',
    unit: 'kilogram',
    comment,
    exchanges: [
      {
        uid: 'u1',
        type: 'technosphere',
        amount,
        formula: 'm_water',
        comment: `${comment} (exchange)`,
        input: { database: 'ei', code: 'water', name: 'water' }
      }
    ],
    ...more
  }
]
const params = (value: number, description = 'from the label') => [
  { name: 'm_water', amount: value, formula: null, unit: 'kg', description }
]

describe('the numbers a review judged', () => {
  it('ignore comments and names, and see amounts, formulas, inputs, tags and parameter values', () => {
    const base = numbersFingerprint(model(0.377, 'old'), params(0.377))
    expect(numbersFingerprint(model(0.377, 'reworded', { name: 'Recipe' }), params(0.377, 'new note'))).toBe(
      base
    )
    expect(numbersFingerprint(model(0.4, 'old'), params(0.377))).not.toBe(base)
    expect(numbersFingerprint(model(0.377, 'old'), params(0.4))).not.toBe(base)
    expect(
      numbersFingerprint(
        model(0.377, 'old', { tags: [{ dimension: 'Phase', value: 'Production' }] }),
        params(0.377)
      )
    ).not.toBe(base)
  })
})

describe('outcomes recorded as fixed after a mere rewording', () => {
  const answer = (id: string) => ({ id, recorded: 2, fixed: 2, rejected: 0, open: 0 })

  it('get a note naming the findings', async () => {
    rememberJudged('r-text', numbersFingerprint(model(0.377, 'old'), params(0.377)))
    const out = await withTextOnlyNote(
      answer('r-text'),
      [
        { id: 'F2', finding: 'the water figure is not sourced', resolution: 'fixed' },
        { id: 'F4', finding: 'the recipe comment contradicts the amount', resolution: 'fixed' },
        { id: 'F5', finding: 'proxy', resolution: 'rejected', reason: 'no better dataset' }
      ],
      async () => [model(0.377, 'reworded'), params(0.377, 'source: label')]
    )
    expect(out.note).toMatch(/^You recorded findings F2, F4 as fixed, but since that review no amount/)
    // The counter-case is in the note itself: a finding about the text is rightly fixed by the text.
    expect(out.note).toMatch(/A finding about the text itself .* is fixed by the new text/)
  })

  it('stay as they are when a number changed', async () => {
    rememberJudged('r-number', numbersFingerprint(model(0.377, 'old'), params(0.377)))
    const out = await withTextOnlyNote(
      answer('r-number'),
      [{ id: 'F2', finding: 'the water figure is wrong', resolution: 'fixed' }],
      async () => [model(0.42, 'old'), params(0.42)]
    )
    expect(out).not.toHaveProperty('note')
  })

  it('are not compared for a review this session did not run, or without a fixed outcome', async () => {
    const never = async (): Promise<[unknown, unknown]> => {
      throw new Error('must not read the model')
    }
    expect(
      await withTextOnlyNote(answer('r-unknown'), [{ id: 'F1', finding: 'x', resolution: 'fixed' }], never)
    ).not.toHaveProperty('note')
    rememberJudged('r-open', 'fp')
    expect(
      await withTextOnlyNote(answer('r-open'), [{ id: 'F1', finding: 'x', resolution: 'open' }], never)
    ).not.toHaveProperty('note')
  })

  it('keep the note the answer already had', async () => {
    rememberJudged('r-both', numbersFingerprint(model(1, 'a'), params(1)))
    const out = await withTextOnlyNote(
      { ...answer('r-both'), note: '1 of the review’s 3 findings have no recorded outcome yet.' },
      [{ finding: 'the label is wrong', resolution: 'fixed' }],
      async () => [model(1, 'b'), params(1)]
    )
    expect(out.note).toMatch(
      /^1 of the review’s 3 findings .* You recorded finding "the label is wrong" as fixed/
    )
  })
})

describe('review_model end to end', () => {
  it('remembers the numbers of a review and compares them when outcomes come in', async () => {
    let state = { acts: model(0.377, 'old'), params: params(0.377) }
    const ctx = {
      chatId: 'c1',
      api: async (method: string, path: string) => {
        if (method === 'GET' && path.startsWith('/api/v1/model/activities/')) return state.acts
        if (method === 'GET' && path.startsWith('/api/v1/params')) return state.params
        if (method === 'POST' && path === '/api/v1/provenance/review') return { id: 'r-e2e' }
        if (method === 'POST' && path === '/api/v1/provenance/review/resolutions')
          return { id: 'r-e2e', recorded: 1, fixed: 1, rejected: 0, open: 0 }
        throw new Error('not in this test')
      },
      ui: async () => ({}),
      review: async () => ({
        text: '[F1] water',
        outcome: 'ok' as const,
        reasoning_chars: 0,
        attempts: 1,
        ms: 1
      })
    } as unknown as ToolCtx
    await reviewTools[0].run({ database: 'Soap' }, ctx)
    state = { acts: model(0.377, 'reworded'), params: params(0.377, 'new source') }
    const fixed = {
      resolutions: [{ id: 'F1', finding: 'water figure', resolution: 'fixed' }],
      database: 'Soap'
    }
    expect(JSON.parse(String(await reviewTools[0].run(fixed, ctx))).note).toMatch(/finding F1 as fixed/)
    state = { acts: model(0.4, 'reworded'), params: params(0.4) }
    expect(JSON.parse(String(await reviewTools[0].run(fixed, ctx)))).not.toHaveProperty('note')
  })
})
