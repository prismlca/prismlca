import { describe, expect, it } from 'vitest'
import { plainFinding, plainReason } from './findingText'

describe('why a chapter could not be finished, in the author’s words', () => {
  it('names the finding that stopped it, not an advisory one before it', () => {
    expect(
      plainReason([
        { kind: 'repaired_literal', detail: 'bound to {{x}}' },
        { kind: 'literal_number', detail: 'Write it as {{parameters.3.amount}}' }
      ])
    ).toMatch(/^A number is typed into the text/)
  })

  it('keeps the check’s own words for a kind it has no sentence for', () => {
    expect(plainFinding({ kind: 'something_new', detail: 'raw detail' })).toBe('raw detail')
    expect(plainReason([])).toBe('It was not stored.')
  })
})
