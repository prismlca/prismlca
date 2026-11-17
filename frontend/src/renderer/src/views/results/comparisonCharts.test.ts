import { describe, expect, it } from 'vitest'
import { comparisonCharts } from './comparisonCharts'

const base = { selectedSubjects: 1, indicators: 3, view: 'normalized' as const }

describe('comparisonCharts', () => {
  it('draws none of the normalized charts over one subject in the results', () => {
    expect(comparisonCharts({ ...base, resultSubjects: 1, selectedSubjects: 2 })).toEqual({
      compared: false,
      showRadar: false,
      canNormalize: false,
      normalized: false
    })
  })

  it('draws all of them from two subjects and three indicators on', () => {
    expect(comparisonCharts({ ...base, resultSubjects: 2 })).toEqual({
      compared: true,
      showRadar: true,
      canNormalize: true,
      normalized: true
    })
  })

  it('wants three indicators for the radar and two for the switch', () => {
    expect(comparisonCharts({ ...base, resultSubjects: 2, indicators: 2 })).toMatchObject({
      compared: true,
      showRadar: false,
      canNormalize: true
    })
    expect(comparisonCharts({ ...base, resultSubjects: 2, indicators: 1 })).toMatchObject({
      compared: true,
      canNormalize: false,
      normalized: false
    })
  })

  it('lets the ticked subjects decide the switch until there are results', () => {
    expect(comparisonCharts({ ...base, resultSubjects: null, selectedSubjects: 2 })).toEqual({
      compared: false,
      showRadar: false,
      canNormalize: true,
      normalized: true
    })
    expect(comparisonCharts({ ...base, resultSubjects: null, selectedSubjects: 1 }).canNormalize).toBe(false)
  })

  it('shows the Normalized chart only when it is the chosen view', () => {
    const r = comparisonCharts({ ...base, resultSubjects: 2, view: 'charts' })
    expect(r.canNormalize).toBe(true)
    expect(r.normalized).toBe(false)
  })
})
