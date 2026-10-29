import { describe, expect, it } from 'vitest'
import { sortFlows, sortRanked } from './FlowSort'

const rows = [
  { amount: 2, input: { name: 'steel' } },
  { amount: -10, input: { name: 'Carbon dioxide' } },
  { amount: 0.5, input: { name: 'water' } },
  { amount: 4, input: { name: null } }
]
const names = (r: typeof rows): Array<string | null> => r.map((x) => x.input.name)

describe('sortFlows', () => {
  it('keeps the exchange order without a sort', () => {
    expect(sortFlows(rows, null)).toBe(rows)
  })

  it('sorts by name both ways, a missing name first', () => {
    expect(names(sortFlows(rows, 'A–Z'))).toEqual([null, 'Carbon dioxide', 'steel', 'water'])
    expect(names(sortFlows(rows, 'Z–A'))).toEqual(['water', 'steel', 'Carbon dioxide', null])
  })

  it('sorts by the size of the amount, so a negative output is not put last', () => {
    expect(sortFlows(rows, '9–1').map((x) => x.amount)).toEqual([-10, 4, 2, 0.5])
    expect(sortFlows(rows, '1–9').map((x) => x.amount)).toEqual([0.5, 2, 4, -10])
  })

  it('leaves the list it was given untouched', () => {
    sortFlows(rows, 'A–Z')
    expect(names(rows)).toEqual(['steel', 'Carbon dioxide', 'water', null])
  })
})

describe('sortRanked', () => {
  const ranked = [{ flow: 'methane' }, { flow: 'Carbon dioxide' }, { flow: 'water' }]
  const flows = (r: typeof ranked): string[] => r.map((x) => x.flow)

  it('keeps the delivered order for 9–1 and reverses it for 1–9', () => {
    expect(sortRanked(ranked, '9–1', (f) => f.flow)).toBe(ranked)
    expect(flows(sortRanked(ranked, '1–9', (f) => f.flow))).toEqual(['water', 'Carbon dioxide', 'methane'])
  })

  it('sorts by name both ways and leaves the input alone', () => {
    expect(flows(sortRanked(ranked, 'A–Z', (f) => f.flow))).toEqual(['Carbon dioxide', 'methane', 'water'])
    expect(flows(sortRanked(ranked, 'Z–A', (f) => f.flow))).toEqual(['water', 'methane', 'Carbon dioxide'])
    expect(flows(ranked)).toEqual(['methane', 'Carbon dioxide', 'water'])
  })
})
