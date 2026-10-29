import { describe, expect, it } from 'vitest'

import { chapterLabel } from './ReportSections'

describe('a chapter is named to the author, never numbered by its slug', () => {
  // The run that found this: the correction dialog offered to correct "interpretation_checks", and
  // the multi-chapter one headed its blocks LCIA and CONTRIBUTION. None of those chapters had ever
  // been renamed, so their title was empty and the display fell through to the raw kind (V173).
  it('uses the title the author gave the chapter', () => {
    expect(chapterLabel({ kind: 'lcia', title: 'Results' })).toBe('Results')
  })

  it('names an untouched chapter by its kind’s label, not its slug', () => {
    expect(chapterLabel({ kind: 'interpretation_checks', title: '' })).toBe('Interpretation checks')
    expect(chapterLabel({ kind: 'lcia', title: '' })).toBe('Impact assessment')
    expect(chapterLabel({ kind: 'contribution', title: '' })).toBe('Contribution')
    // The document heads an untitled written chapter "Interpretation"; the list must not call it something else.
    expect(chapterLabel({ kind: 'prose', title: '' })).toBe('Interpretation')
  })

  it('treats a whitespace title as no title — a blank heading names nothing', () => {
    expect(chapterLabel({ kind: 'lcia', title: '   ' })).toBe('Impact assessment')
    expect(chapterLabel({ kind: 'lcia' })).toBe('Impact assessment')
  })

  it('trims the title it does use, so the heading does not start with a space', () => {
    expect(chapterLabel({ kind: 'lcia', title: '  Results ' })).toBe('Results')
  })

  it('falls back to the raw kind for a kind it does not know — better than an empty heading', () => {
    expect(chapterLabel({ kind: 'something_new', title: '' })).toBe('something_new')
  })
})
