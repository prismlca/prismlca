import { describe, expect, it } from 'vitest'
import { agreeingFactors, MAX_COMPARED, sortCompareFlows, type CfFlow } from './lciaCompare'

const row = (flow: string, unit: string, factors: (number | null)[], categories = ['air']): CfFlow => ({
  flow,
  categories,
  unit,
  factors
})

describe('the factor comparison', () => {
  it('compares three indicators at most', () => {
    expect(MAX_COMPARED).toBe(3)
  })

  it('marks the factors that agree within a row, and never a blank', () => {
    expect(agreeingFactors([1, 1, 2])).toEqual([true, true, false])
    expect(agreeingFactors([27.9, 27.9, 27.9])).toEqual([true, true, true])
    expect(agreeingFactors([1, 2, 3])).toEqual([false, false, false])
    expect(agreeingFactors([null, null, 5])).toEqual([false, false, false])
    // The last bits of floating point are not a difference a reader can see.
    expect(agreeingFactors([0.1 + 0.2, 0.3, null])).toEqual([true, true, false])
  })

  it('sorts text by name and factors by value, blanks last both ways', () => {
    const rows = [
      row('methane', 'kg', [27.9, null]),
      row('Carbon dioxide', 'kg', [1, 1]),
      row('dinitrogen', 'g', [273, 265])
    ]
    const names = (rs: CfFlow[]): string[] => rs.map((r) => r.flow)
    expect(names(sortCompareFlows(rows, { key: 'flow', dir: 1 }))).toEqual([
      'Carbon dioxide',
      'dinitrogen',
      'methane'
    ])
    expect(names(sortCompareFlows(rows, { key: 'unit', dir: 1 }))[0]).toBe('dinitrogen')
    expect(names(sortCompareFlows(rows, { key: 'cf:0', dir: -1 }))).toEqual([
      'dinitrogen',
      'methane',
      'Carbon dioxide'
    ])
    expect(names(sortCompareFlows(rows, { key: 'cf:1', dir: 1 }))).toEqual([
      'Carbon dioxide',
      'dinitrogen',
      'methane'
    ])
    expect(names(sortCompareFlows(rows, { key: 'cf:1', dir: -1 }))).toEqual([
      'dinitrogen',
      'Carbon dioxide',
      'methane'
    ])
    expect(sortCompareFlows(rows, null)).toBe(rows)
  })
})
