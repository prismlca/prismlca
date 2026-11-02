import { describe, expect, it } from 'vitest'
import {
  breakNote,
  curveValues,
  defaultRange,
  limitedNote,
  linspace,
  runState,
  signedPct,
  sortedEntries,
  swing,
  violates
} from './helpers'
import type { SensInput, TornadoEntry, TornadoResult } from './types'

const entry = (
  param: string,
  low: number[],
  high: number[],
  extra: Partial<TornadoEntry> = {}
): TornadoEntry => ({
  param,
  base: 1,
  low_value: 0.9,
  high_value: 1.1,
  low,
  high,
  ...extra
})

describe('what a tornado bar says', () => {
  it('sorts by the swing of the indicator on screen, not of the first one', () => {
    const r = {
      baseline: [1.5, 10],
      entries: [entry('a', [1, 10], [2, 10.1]), entry('b', [1, 10], [1.5, 15])]
    } as TornadoResult
    expect(sortedEntries(r, 0).map((e) => e.param)).toEqual(['a', 'b'])
    expect(sortedEntries(r, 1).map((e) => e.param)).toEqual(['b', 'a'])
  })

  it('ranks a parameter that moves the result the same way on both sides by how far it moves it', () => {
    const r = {
      baseline: [10],
      entries: [entry('small', [9.8], [10.2]), entry('even', [11], [11])]
    } as TornadoResult
    expect(sortedEntries(r, 0).map((e) => e.param)).toEqual(['even', 'small'])
    expect(swing(r.entries[1], 0, 10)).toBe(1)
  })

  it('prints a percentage with a real minus and fewer decimals from 1 % up', () => {
    expect(signedPct(11.111)).toBe('+11.1 %')
    expect(signedPct(-0.0652)).toBe('−0.07 %')
    expect(signedPct(0)).toBe('0 %')
  })

  it('names how far a rule let a side move, or the neighbouring values of a list', () => {
    const share = entry('return_rate', [0], [0], {
      base: 0.97,
      low_value: 0.873,
      high_value: 1,
      limited: { high: 'between 0 and 1' }
    })
    expect(limitedNote(share)).toBe('return_rate +3.1 % (to 1), between 0 and 1')
    const choice = entry('choice', [0], [0], {
      base: 0.5,
      low_value: 0.25,
      high_value: 1,
      limited: { low: 'one of 0.25, 0.5, 1', high: 'one of 0.25, 0.5, 1' }
    })
    expect(limitedNote(choice)).toBe('choice: the next allowed values 0.25 and 1 (one of 0.25, 0.5, 1)')
  })
})

describe('a step that breaks another parameter’s rule', () => {
  it('names the side, the parameter it moved and the rule', () => {
    const e = entry('eol_plastic_inc', [0], [0], {
      base: 0.95,
      breaks: { high: [{ param: 'eol_plastic_rec', value: -0.045, allowed: 'between 0 and 1' }] }
    })
    expect(breakNote(e, 0.1)).toBe(
      'eol_plastic_inc +10 % takes eol_plastic_rec to -0.045 (allowed: between 0 and 1)'
    )
    expect(breakNote(e, 0.004)).toContain('+0.4 % takes')
  })
})

describe('the values a curve may run through', () => {
  const input = (rule: SensInput['rule']): SensInput => ({ name: 'share', value: 0.5, unit: '', rule })

  it('spaces the points evenly, ends included, without float dust', () => {
    expect(linspace(0, 1, 11)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1])
  })

  it('refuses an end the rule forbids before anything is computed', () => {
    const r = curveValues(input({ kind: 'range', min: 0, max: 1 }), 0.5, 1.2, 5)
    expect(r.values).toBeNull()
    expect(r.error).toBe('1.2 is not allowed: share must be at most 1.')
  })

  it('takes a list rule’s values as the points, whatever the range says', () => {
    expect(curveValues(input({ kind: 'list', values: [1, 0.25, 0.5] }), 0, 9, 11).values).toEqual([
      0.25, 0.5, 1
    ])
    expect(curveValues(input({ kind: 'list', values: [4.186] }), 0, 9, 11).values).toBeNull()
  })

  it('proposes a range around the value that the rule allows', () => {
    const rate = { ...input({ kind: 'range', min: 0, max: 1 }), value: 0.97 }
    expect(defaultRange(rate)).toEqual({ from: 0.485, to: 1 })
    expect(curveValues(rate, 0.485, 1, 11).error).toBeNull()
    expect(defaultRange({ ...input({}), value: -2 })).toEqual({ from: -3, to: -1 })
    expect(defaultRange({ ...input({ kind: 'range', min: 2, max: 5 }), value: 0 })).toEqual({
      from: 2,
      to: 5
    })
    // Rounded before the cut, so the end never lands just past the rule.
    expect(defaultRange({ ...input({ kind: 'range', max: 0.1234567 }), value: 0.12 }).to).toBe(0.1234567)
  })

  it('mirrors the backend rule check', () => {
    expect(violates({ kind: 'positive' }, 0)).toBe('must be greater than 0')
    expect(violates({ kind: 'range', min: 0, max: 1 }, 1 + 1e-12)).toBeNull()
    expect(violates({}, -5)).toBeNull()
  })
})

describe('whether a stored run still answers the card', () => {
  const stored = { result: {}, startedAt: '2026-11-01T20:00:00+00:00', seconds: 88, key: 'k' }
  it('is fresh for the same settings and no later model change', () => {
    expect(runState(stored, 'k', false)).toBe('fresh')
  })
  it('is outdated by a change since the run, whatever the settings', () => {
    expect(runState(stored, 'other', true)).toBe('model')
  })
  it('does not call a run current when the check failed', () => {
    expect(runState(stored, 'k', null, true)).toBe('unknown')
  })
  it('says the settings changed when they did', () => {
    expect(runState(stored, 'other', null)).toBe('settings')
    expect(runState(null, 'k', null)).toBe('none')
  })
})
