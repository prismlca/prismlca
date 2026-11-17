import { describe, expect, it } from 'vitest'
import { HEAT_RANGE, HEAT_STOPS, heatColor, heatLabel } from './heat'

/**
 * The one heat scale in the app. Its colours ARE the reading — low, middling, high — so both places
 * that draw a heatmap must use these stops: the Results table cell by cell, and the report figure
 * through `HEAT_RANGE` on echarts' visualMap. They have drifted apart twice.
 */
describe('heatColor', () => {
  it('runs green → amber → red across the range', () => {
    expect(heatColor(0)).toBe('rgb(232, 240, 216)')
    expect(heatColor(0.5)).toBe('rgb(255, 224, 138)')
    expect(heatColor(1)).toBe('rgb(230, 126, 100)')
  })

  it('interpolates between the stops rather than stepping', () => {
    expect(heatColor(0.25)).toBe('rgb(244, 232, 177)')
  })

  it('clamps outside 0..1 instead of running off the ramp', () => {
    expect(heatColor(-5)).toBe(heatColor(0))
    expect(heatColor(5)).toBe(heatColor(1))
  })
})

describe('HEAT_RANGE', () => {
  it('is the same ramp, in the form echarts’ visualMap wants', () => {
    // The report figure hands these three to echarts and lets it interpolate. If they ever stop
    // being derived from HEAT_STOPS, the PDF and the screen part ways again.
    expect(HEAT_RANGE).toHaveLength(HEAT_STOPS.length)
    expect(HEAT_RANGE[0]).toBe(heatColor(0))
    expect(HEAT_RANGE[HEAT_RANGE.length - 1]).toBe(heatColor(1))
  })
})

describe('heatLabel', () => {
  it('is the share in whole percent', () => {
    expect(heatLabel(4.2, 1)).toBe('100%')
    expect(heatLabel(1.3, 0.314)).toBe('31%')
    expect(heatLabel(0, 0)).toBe('0%')
  })

  it('keeps the sign of a credit, which the colour alone does not show', () => {
    expect(heatLabel(-4.2, 1)).toBe('−100%')
    expect(heatLabel(-1.3, 0.314)).toBe('−31%')
  })

  it('drops the sign where the share rounds to nothing', () => {
    expect(heatLabel(-0.001, 0.004)).toBe('0%')
  })
})
