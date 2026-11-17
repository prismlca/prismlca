import { describe, expect, it } from 'vitest'

import { afterReviewNote, outcomesAnswer, reviewerIdentity } from './reviewAnswer'

describe('who reviewed', () => {
  it('tells a self-review from a second model, and claims nothing without the chat model', () => {
    expect(reviewerIdentity('vendor/m1', 'vendor/m1')).toEqual({ reviewer: 'vendor/m1', self_review: true })
    expect(reviewerIdentity('vendor/m2', 'vendor/m1')).toEqual({ reviewer: 'vendor/m2', self_review: false })
    expect(reviewerIdentity('vendor/m2', undefined)).toEqual({ reviewer: 'vendor/m2' })
    expect(reviewerIdentity(undefined, 'vendor/m1')).toEqual({})
  })

  it('never calls a self-review independent, and names a second model as one', () => {
    const self = afterReviewNote({ reviewer: 'vendor/m1', self_review: true })
    expect(self).toContain('vendor/m1, the model you run on')
    expect(self).toContain('not an independent review')
    expect(self).toContain('it does not go into critical_review')
    const other = afterReviewNote({ reviewer: 'vendor/m2', self_review: false })
    expect(other).toContain('second opinion from another AI model (vendor/m2)')
    expect(other).not.toContain('self-review')
    expect(afterReviewNote({})).toContain('second opinion from an AI reviewer')
    for (const n of [self, other]) expect(n).toContain('[{id, finding, resolution')
  })
})

describe('the answer to recorded outcomes', () => {
  it('names the findings without an outcome and what to do about them', () => {
    const out = outcomesAnswer({
      recorded: 8,
      findings: 11,
      no_outcome_yet: [
        { id: 'F4', finding: 'packaging film' },
        { id: 'F9', finding: 'tyres' },
        { id: 'F11', finding: 'lifetime' }
      ],
      without_id: 1,
      unknown_ids: ['F14']
    })
    expect(out.note).toContain("3 of the review's 11 findings have no recorded outcome yet")
    expect(out.note).toContain('do not report the review as settled')
    expect(out.note).toContain('1 of your recorded outcomes name no id')
    expect(out.note).toContain('The review has no finding F14')
    expect(out.no_outcome_yet).toHaveLength(3)
  })

  it('stays quiet when every finding has one, and says when the review had no ids', () => {
    expect(outcomesAnswer({ recorded: 2, findings: 2, no_outcome_yet: [] }).note).toBeUndefined()
    expect(outcomesAnswer({ recorded: 2, tagged: false }).note).toMatch(/did not tag its findings/)
    expect(outcomesAnswer({ error: 'no review on record' } as never)).toEqual({
      error: 'no review on record'
    })
  })
})
