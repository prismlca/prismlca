import { describe, expect, it } from 'vitest'
import { filterFlows } from './FlowSearch'

const rows = [
  { amount: 1, input: { name: 'Carbon dioxide, fossil', location: null, categories: ['air', 'urban air'] } },
  { amount: 2, input: { name: 'market for electricity, low voltage', location: 'DE' } },
  { amount: 3, input: { name: 'Water', location: null, categories: ['water', 'surface water'] } },
  { amount: 4, input: { name: null, location: 'CH' } }
]

describe('filterFlows', () => {
  it('keeps every flow for an empty or blank query', () => {
    expect(filterFlows(rows, '')).toBe(rows)
    expect(filterFlows(rows, '   ')).toBe(rows)
  })

  it('matches the name regardless of case', () => {
    expect(filterFlows(rows, 'ELECTRICITY').map((r) => r.amount)).toEqual([2])
  })

  it('matches the location and the compartment too', () => {
    expect(filterFlows(rows, 'ch').map((r) => r.amount)).toEqual([4])
    expect(filterFlows(rows, 'urban').map((r) => r.amount)).toEqual([1])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterFlows(rows, 'steel')).toEqual([])
  })
})
