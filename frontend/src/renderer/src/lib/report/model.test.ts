import { describe, expect, it } from 'vitest'
import { unrecordedScope } from './model'

const keys = (study: Record<string, unknown>): string[] => unrecordedScope(study).map(([key]) => key)

describe('unrecordedScope', () => {
  it('names every reportable field of an empty study', () => {
    expect(keys({})).toEqual([
      'functional_unit',
      'geography',
      'reference_year',
      'system_boundaries',
      'cutoff_criteria',
      'allocation',
      'system_allocation',
      'critical_review'
    ])
  })

  it('counts a critical review answered in the choice, "no" included, without a description', () => {
    expect(keys({ critical_review_done: 'no' })).not.toContain('critical_review')
    expect(keys({ critical_review_done: 'yes' })).not.toContain('critical_review')
    expect(keys({ critical_review_done: '' })).toContain('critical_review')
  })

  it('counts a described field and ignores whitespace', () => {
    expect(keys({ functional_unit: '1 kg', critical_review: '  ' })).not.toContain('functional_unit')
    expect(keys({ functional_unit: '1 kg', critical_review: '  ' })).toContain('critical_review')
  })
})
