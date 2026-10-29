import { describe, expect, it } from 'vitest'
import { describeRule, ruleChoices, ruleViolation, toNumber, type ParamRule } from './ParamRule'

/**
 * The same rules the backend enforces, checked on this side too — because the point of the feature is that a
 * wrong value is refused *where it is typed*, with the field still on screen. If the two sides disagree, one
 * of them lets a value through and the other explains a field that changed back for no visible reason.
 */
describe('parameter rules', () => {
  it('reads a rule the way the backend words it', () => {
    expect(describeRule({} as ParamRule)).toBe('any number')
    expect(describeRule({ kind: 'positive' })).toBe('greater than 0')
    expect(describeRule({ kind: 'negative' })).toBe('less than 0')
    // One open end *is* the "at least" / "at most" rule — there is no separate kind for it.
    expect(describeRule({ kind: 'range', min: 0 })).toBe('at least 0')
    expect(describeRule({ kind: 'range', max: 1 })).toBe('at most 1')
    expect(describeRule({ kind: 'range', min: 0, max: 1 })).toBe('between 0 and 1')
    expect(describeRule({ kind: 'list', values: [0.25, 0.5] })).toBe('one of 0.25, 0.5')
  })

  it('refuses what the rule forbids and nothing else', () => {
    expect(ruleViolation({ kind: 'positive' }, 0)).toBeTruthy() // positive means > 0
    expect(ruleViolation({ kind: 'positive' }, 0.1)).toBeNull()
    expect(ruleViolation({ kind: 'negative' }, 0)).toBeTruthy()
    expect(ruleViolation({ kind: 'negative' }, -2)).toBeNull()
    expect(ruleViolation({ kind: 'range', min: 0, max: 1 }, 1)).toBeNull() // inclusive
    expect(ruleViolation({ kind: 'range', min: 0, max: 1 }, 1.5)).toBeTruthy()
    expect(ruleViolation({ kind: 'range', max: 1 }, -99)).toBeNull() // no lower bound
    expect(ruleViolation({ kind: 'list', values: [0.25, 0.5] }, 0.5)).toBeNull()
    expect(ruleViolation({ kind: 'list', values: [0.25, 0.5] }, 0.3)).toBeTruthy()
    // Nothing typed yet is not a violation, and no rule forbids nothing.
    expect(ruleViolation({ kind: 'positive' }, null)).toBeNull()
    expect(ruleViolation(undefined, -5)).toBeNull()
    // Floats do not compare exactly — the same tolerance the backend applies.
    expect(ruleViolation({ kind: 'range', min: 0, max: 1 }, 0.9999999999999999)).toBeNull()
    expect(ruleViolation({ kind: 'list', values: [0.1] }, 0.1 + 2e-17)).toBeNull()
  })

  it('hands a list its choices', () => {
    expect(ruleChoices({ kind: 'list', values: [1, 2] })).toEqual([1, 2])
    expect(ruleChoices({ kind: 'positive' })).toEqual([])
  })

  it('treats one open end as one bound, not as a zero', () => {
    // The bug this replaces: choosing "Range" pre-filled `min: 0`, so setting only an upper bound left a
    // lower one nobody typed and "at most 1" quietly became "between 0 and 1".
    expect(ruleViolation({ kind: 'range', max: 1 }, -50)).toBeNull()
    expect(ruleViolation({ kind: 'range', min: 0 }, 1e9)).toBeNull()
    expect(describeRule({ kind: 'range', max: 1 })).toBe('at most 1')
  })

  it('accepts a comma decimal, because half of Europe types one', () => {
    expect(toNumber('0,5')).toBe(0.5)
    expect(toNumber(' 2 ')).toBe(2)
    expect(toNumber('')).toBeNull()
    expect(toNumber('abc')).toBeNull()
  })
})
