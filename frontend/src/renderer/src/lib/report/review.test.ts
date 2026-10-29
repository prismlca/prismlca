import { describe, expect, it } from 'vitest'
import { reviewPendingCount, reviewRefusal } from './staleness'

// The author's approval of the report: how many chapters are new since it, and what the export says. The backend decides `review` per chapter; this side only has to count honestly.
describe('reviewPendingCount', () => {
  const sections = [
    { id: 'a', text: 'Written by a model, not yet released.' },
    { id: 'b', text: 'Written by a model and released.' },
    { id: 'c', text: 'Written by hand.' },
    { id: 'd', text: '' }
  ]

  it('counts only chapters with text that the check reports as pending', () => {
    const stale = {
      a: { review: 'pending' },
      b: { review: 'released' },
      c: { review: null },
      d: { review: 'pending' } // no text: nothing to release
    }
    expect(reviewPendingCount(sections, stale)).toBe(1)
  })

  it('is zero before the check has answered — the check, not this side, decides what is pending', () => {
    expect(reviewPendingCount(sections, {})).toBe(0)
  })
})

describe('reviewRefusal', () => {
  it('reads in the singular and the plural, and says what to do', () => {
    expect(reviewRefusal(1)).toMatch(/^1 chapter is new since you last approved the report/)
    expect(reviewRefusal(3)).toMatch(/^3 chapters are new since you last approved the report/)
    expect(reviewRefusal(3)).toContain('approve the report, or export anyway')
  })
})
