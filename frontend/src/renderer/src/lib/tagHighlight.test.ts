import { describe, expect, it } from 'vitest'
import { groupsOnCanvas } from './tagHighlight'

const groups = [
  { name: 'Life-cycle phase', color: '#1', values: ['Production', 'Use', 'End-of-life'] },
  { name: 'Component', color: '#2', values: ['Hose', 'Wheels'] },
  { name: 'Only elsewhere', color: '#3', values: ['x'] }
]
const node = (...tags: [string, string][]) => ({
  data: { tags: tags.map(([dimension, value]) => ({ dimension, value })) }
})

describe('groupsOnCanvas', () => {
  it('keeps only groups and values a box on the canvas carries, in workspace order', () => {
    const got = groupsOnCanvas(groups, [
      node(['Life-cycle phase', 'Use'], ['Component', 'Hose']),
      node(['Life-cycle phase', 'Production']),
      { data: {} } // a background reference: no tags at all
    ])
    expect(got.map((g) => [g.name, g.values])).toEqual([
      ['Life-cycle phase', ['Production', 'Use']],
      ['Component', ['Hose']]
    ])
  })

  it('offers nothing on a canvas without tags', () => {
    expect(groupsOnCanvas(groups, [{ data: {} }])).toEqual([])
  })
})
