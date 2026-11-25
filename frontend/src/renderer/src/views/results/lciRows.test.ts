import { describe, expect, it } from 'vitest'
import { filterLciRows, lciExport, lciRows, sortLciRows } from './lciRows'
import { resultsWorkbook, splitLabel } from './resultsWorkbook'
import type { Matrix, Picked, StackedData } from './types'

const KEY = 'EF v3.1 · climate change · GWP100'
const PICKED: Picked[] = [
  {
    key: KEY,
    method: KEY.split(' · '),
    family: 'EF v3.1',
    label: 'climate change',
    detail: 'GWP100',
    unit: 'kg'
  }
]
const MATRIX: Matrix = {
  methods: [{ key: KEY, unit: 'kg', method: KEY.split(' · ') }],
  subjects: [
    { label: 'Baseline', database: 'fg', code: 'b', scores: { [KEY]: 1.1 }, inventory: { '1': 1.1, '2': 4 } },
    {
      label: 'efficient',
      database: 'fg',
      code: 'b',
      scenario: 's1',
      scores: { [KEY]: 0.6 },
      inventory: { '1': 0.6, '3': -0.25 }
    }
  ],
  flows: {
    '1': {
      name: 'Carbon dioxide, fossil',
      categories: ['air', 'urban air close to ground'],
      unit: 'kilogram'
    },
    '2': { name: 'water', categories: ['natural resource', 'in water'], unit: 'cubic meter' },
    '3': { name: 'Carbon dioxide, fossil', categories: ['air'], unit: 'kilogram' }
  }
}

describe('the rows of the LCI table', () => {
  it('are one per flow any subject exchanges, with a 0 where a subject does not', () => {
    const rows = lciRows(MATRIX)
    expect(rows.map((r) => [r.flow, r.categories.join(' / '), r.amounts])).toEqual([
      // By name, case ignored, then by compartment: "air" before "air / urban air close to ground".
      ['Carbon dioxide, fossil', 'air', [0, -0.25]],
      ['Carbon dioxide, fossil', 'air / urban air close to ground', [1.1, 0.6]],
      ['water', 'natural resource / in water', [4, 0]]
    ])
  })

  it('are none when the run computed no inventory', () => {
    expect(lciRows({ ...MATRIX, flows: undefined })).toEqual([])
  })

  it('filter by flow name or compartment, ignoring case', () => {
    const rows = lciRows(MATRIX)
    expect(filterLciRows(rows, 'WATER').map((r) => r.flow)).toEqual(['water'])
    expect(filterLciRows(rows, 'urban').map((r) => r.amounts)).toEqual([[1.1, 0.6]])
    expect(filterLciRows(rows, '  ')).toBe(rows)
  })

  it('sort by a subject amount with its sign, and by text', () => {
    const rows = lciRows(MATRIX)
    expect(sortLciRows(rows, { key: 's:1', dir: 1 }).map((r) => r.amounts[1])).toEqual([-0.25, 0, 0.6])
    expect(sortLciRows(rows, { key: 's:0', dir: -1 }).map((r) => r.amounts[0])).toEqual([4, 1.1, 0])
    expect(sortLciRows(rows, { key: 'unit', dir: -1 }).map((r) => r.unit)[0]).toBe('kilogram')
    expect(sortLciRows(rows, null)).toBe(rows)
  })

  it('export with a column per subject, in the order given', () => {
    const rows = sortLciRows(lciRows(MATRIX), { key: 's:0', dir: -1 })
    const out = lciExport(MATRIX, rows)
    expect(out.subjects).toEqual(['Baseline', 'efficient'])
    expect(out.flows[0]).toEqual({
      flow: 'water',
      categories: ['natural resource', 'in water'],
      unit: 'cubic meter',
      amounts: [4, 0]
    })
  })
})

describe('the Results workbook', () => {
  const keyOf = (s: { code: string }): string => s.code

  it('carries the inventory of the same subjects, every flow in name order', () => {
    const wb = resultsWorkbook(MATRIX, PICKED, null, keyOf)
    expect(wb.subjects).toEqual([
      { label: 'Baseline', scores: { [KEY]: 1.1 } },
      { label: 'efficient', scores: { [KEY]: 0.6 } }
    ])
    expect(wb.group_header).toBeNull()
    expect(wb.inventory?.subjects).toEqual(['Baseline', 'efficient'])
    expect(wb.inventory?.flows.map((f) => f.amounts)).toEqual([
      [0, -0.25],
      [1.1, 0.6],
      [4, 0]
    ])
  })

  it('has no inventory sheet when the run computed none', () => {
    expect(resultsWorkbook({ ...MATRIX, flows: undefined }, PICKED, null, keyOf).inventory).toBeNull()
  })

  it('comes apart per part of each subject when split, leaving out parts a subject does not have', () => {
    const data: StackedData = {
      dimensions: ['isic'],
      keys: { isic: ['C', 'D'] },
      labels: { isic: { C: 'Manufacturing', D: 'Electricity' } },
      subjects: [
        {
          label: 'Baseline',
          database: 'fg',
          code: 'b',
          methods: {
            [KEY]: { total: 1.1, unit: 'kg', dims: { isic: [{ key: 'C', impact: 1.1, share: 1 }] } }
          }
        }
      ]
    }
    const label = (k: string): string => data.labels!.isic[k] ?? k
    const wb = resultsWorkbook(MATRIX, PICKED, { data, keys: ['C', 'D'], by: 'isic', label }, keyOf)
    expect(wb.group_header).toBe('ISIC classification')
    expect(wb.subjects).toEqual([
      { label: 'Baseline', group: 'Manufacturing', scores: { [KEY]: 1.1 } },
      { label: 'Baseline', group: 'Total', total: true, scores: { [KEY]: 1.1 } }
    ])
    // A split with no keys is the plain sheet.
    expect(
      resultsWorkbook(MATRIX, PICKED, { data, keys: [], by: 'isic', label }, keyOf).group_header
    ).toBeNull()
  })

  it('names the split column after the choice', () => {
    expect(splitLabel('cpc')).toBe('CPC classification')
    expect(splitLabel('tag:Life-cycle phase')).toBe('Life-cycle phase')
  })
})
