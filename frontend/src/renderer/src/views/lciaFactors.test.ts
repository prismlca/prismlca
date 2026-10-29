import { describe, expect, it } from 'vitest'

import { filterFactorFlows, sortFactorFlows, type Flow } from './lciaFactors'

const flow = (name: string, categories: string[], cf: number): Flow => ({
  ref: name,
  flow: name,
  categories,
  unit: 'kilogram',
  cf
})

const rows = [
  flow('Methane, fossil', ['air', 'urban air close to ground'], 29.8),
  flow('carbon dioxide, fossil', ['air'], 1),
  flow('Dinitrogen monoxide', ['air', 'lower stratosphere'], 273),
  flow('Ammonia', ['water'], 0)
]

describe('filterFactorFlows', () => {
  it('matches name and categories, ignoring case', () => {
    expect(filterFactorFlows(rows, 'FOSSIL').map((r) => r.flow)).toEqual([
      'Methane, fossil',
      'carbon dioxide, fossil'
    ])
    expect(filterFactorFlows(rows, 'stratosphere').map((r) => r.flow)).toEqual(['Dinitrogen monoxide'])
  })

  it('keeps every row for an empty or blank query', () => {
    expect(filterFactorFlows(rows, '  ')).toBe(rows)
  })
})

describe('sortFactorFlows', () => {
  it('sorts names without regard to case, both ways', () => {
    const up = sortFactorFlows(rows, { key: 'flow', dir: 1 }).map((r) => r.flow)
    expect(up).toEqual(['Ammonia', 'carbon dioxide, fossil', 'Dinitrogen monoxide', 'Methane, fossil'])
    expect(sortFactorFlows(rows, { key: 'flow', dir: -1 }).map((r) => r.flow)).toEqual([...up].reverse())
  })

  it('sorts factors by value, not as text', () => {
    expect(sortFactorFlows(rows, { key: 'cf', dir: 1 }).map((r) => r.cf)).toEqual([0, 1, 29.8, 273])
  })

  it('keeps the stored order for equal categories and without a sort', () => {
    const tied = [flow('b', ['air'], 1), flow('a', ['air'], 2)]
    expect(sortFactorFlows(tied, { key: 'categories', dir: 1 }).map((r) => r.flow)).toEqual(['b', 'a'])
    expect(sortFactorFlows(rows, null)).toBe(rows)
  })
})
