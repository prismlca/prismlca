import { describe, expect, it } from 'vitest'
import { subjectRows } from './subjectRows'

const base = {
  activeDb: 'm',
  acts: [
    { code: 'a', name: 'Pack' },
    { code: 'b', name: 'Bottle' }
  ],
  subjSel: { a: true },
  baselineOn: true,
  scenarios: [
    { id: 's1', name: 'Cold' },
    { id: 's2', name: 'Hot' }
  ],
  scenSel: { s1: true, s2: true },
  otherModels: [],
  bgSubjects: []
}

describe('subjectRows', () => {
  it('is the baseline plus each ticked process under each ticked scenario', () => {
    expect(subjectRows(base).map((r) => r.label)).toEqual(['Pack', 'Cold', 'Hot'])
    expect(subjectRows({ ...base, baselineOn: false })).toHaveLength(2)
  })

  it('names a scenario row by process and scenario once there are several processes', () => {
    const rows = subjectRows({ ...base, subjSel: { a: true, b: true }, scenSel: { s1: true } })
    expect(rows.map((r) => r.label)).toEqual(['Pack', 'Bottle', 'Pack · Cold', 'Bottle · Cold'])
  })

  it('adds the enabled processes of other models and database activities only', () => {
    const rows = subjectRows({
      ...base,
      scenSel: {},
      otherModels: [
        { database: 'other', code: 'x', name: 'Other pack' },
        { database: 'off', code: 'y', name: 'Switched off', enabled: false }
      ],
      bgSubjects: [{ database: 'ei', code: 'z', name: 'PET', geography: 'RER' } as never]
    })
    expect(rows.map((r) => r.label)).toEqual(['Pack', 'Other pack — other', 'PET [RER]'])
  })
})
