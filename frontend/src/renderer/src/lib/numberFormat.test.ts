import { describe, expect, it } from 'vitest'
import {
  AUTO_DECIMALS,
  autoDecimals,
  axisScale,
  clampNoise,
  labelNum,
  reportNumber,
  SCIENTIFIC
} from './numberFormat'

/**
 * These four decide what a chart SAYS. Each one exists because of a specific incident recorded in
 * its own comment, so the tests pin those incidents by name rather than inventing round numbers.
 */

describe('autoDecimals', () => {
  it('rounds an exact half to even, as the tables do', () => {
    // JS toFixed says 13 for 12.5 and Python's format says 12: the one value the figure and the table
    // beside it disagreed on. A half that is not exact in binary is not a half.
    expect(reportNumber(12.5, 'en', 0)).toBe('12')
    expect(reportNumber(13.5, 'en', 0)).toBe('14')
    expect(reportNumber(-12.5, 'en', 0)).toBe('-12')
    expect(reportNumber(0.125, 'en', 2)).toBe('0.12')
    expect(reportNumber(1.005, 'en', 2)).toBe('1.00')
    expect(reportNumber(12.5, 'en')).toBe('12.5')
  })

  it('follows the largest value, so one column does not mix precisions', () => {
    // The incident: at a fixed six decimals, 1.69571 printed as "1.695710" — four digits of
    // authority the underlying data does not have.
    expect(autoDecimals([1.69571, 0.0619804])).toBe(2)
    expect(labelNum(1.69571, autoDecimals([1.69571, 0.0619804]))).toBe('1.70')
  })

  it('adds decimals as the series gets smaller, and stops at six', () => {
    // Two significant figures past the leading digit, i.e. 2 - floor(log10(max)).
    expect(autoDecimals([0.5])).toBe(3)
    expect(autoDecimals([0.05])).toBe(4)
    expect(autoDecimals([0.0005])).toBe(6) // the clamp bites here: the formula wants 7
    expect(autoDecimals([0.00011])).toBe(6) // one step above the scientific cut-off
  })

  it('switches to scientific outside the range a fixed notation can carry', () => {
    expect(autoDecimals([1e-5])).toBe(SCIENTIFIC)
    expect(autoDecimals([1e6])).toBe(SCIENTIFIC)
    expect(autoDecimals([999_999])).not.toBe(SCIENTIFIC) // the boundary is inclusive upwards only
  })

  it('never returns a negative count for large-but-not-huge values', () => {
    // 2 - floor(log10(max)) goes negative above 1000; clamping to 0 is what keeps toFixed legal.
    expect(autoDecimals([50_000])).toBe(0)
  })

  it('ignores zeros and non-finite values instead of being defined by them', () => {
    expect(autoDecimals([0, 0, 1.5])).toBe(2)
    expect(autoDecimals([Number.NaN, Number.POSITIVE_INFINITY, 0.05])).toBe(4)
    expect(autoDecimals([])).toBe(2)
    expect(autoDecimals([0])).toBe(2)
  })

  it('keeps its two sentinels distinguishable — they share one integer channel', () => {
    expect(SCIENTIFIC).not.toBe(AUTO_DECIMALS)
    expect(autoDecimals([1e-9])).toBe(SCIENTIFIC)
  })
})

describe('labelNum', () => {
  it('renders the scientific marker with two significant decimals, and zero as zero', () => {
    expect(labelNum(0.0000123, SCIENTIFIC)).toBe('1.23e-5')
    expect(labelNum(0, SCIENTIFIC)).toBe('0')
  })

  it('pads zero to the chosen precision so a column stays aligned', () => {
    expect(labelNum(0, 3)).toBe('0.000')
  })

  it('falls back to scientific when a value is smaller than the precision could show', () => {
    // Without this, 1e-6 at two decimals would print "0.00" — a real number rendered as nothing.
    expect(labelNum(1e-6, 2)).toBe('1.00e-6')
    expect(labelNum(2_000_000, 2)).toBe('2.00e+6')
  })

  it('clamps the decimal count into what toFixed accepts', () => {
    expect(labelNum(1.5, 99)).toBe('1.50000000')
    expect(labelNum(1.5, -7)).toBe('2')
  })

  it('does not pass an unresolved AUTO off as zero decimals', () => {
    // The Results matrix handed the sentinel straight through, and 0.105 came out as "1e-1" — one
    // significant figure, dressed as a deliberate format. Three figures, and the caller should still
    // resolve it against its series.
    expect(labelNum(0.105, AUTO_DECIMALS)).toBe('1.05e-1')
    expect(labelNum(0, AUTO_DECIMALS)).toBe('0')
  })

  it('keeps three significant figures when a value is too small for the chosen decimals', () => {
    // With zero decimals the old form printed `toExponential(0)`: "6e-4" for 0.00063, which says
    // less than the fixed notation it stands in for.
    expect(labelNum(0.00063, 0)).toBe('6.30e-4')
    expect(labelNum(0.105, 0)).toBe('1.05e-1')
    expect(labelNum(33, 0)).toBe('33')
  })
})

describe('axisScale', () => {
  it('leaves an ordinary range alone', () => {
    expect(axisScale([0.5, 1.2, 3])).toEqual({ exp: 0, factor: 1 })
    expect(axisScale([])).toEqual({ exp: 0, factor: 1 })
    expect(axisScale([0, 0])).toEqual({ exp: 0, factor: 1 })
  })

  it('rescales the magnitudes where the nice-tick axis degenerates', () => {
    // Human-toxicity scores of ~1e-12 CTUh: no ticks at all, and the baseline drifting below zero
    // while every bar is positive.
    const { exp, factor } = axisScale([1.4e-12, 3e-12])
    expect(exp).toBe(-12)
    expect(3e-12 * factor).toBeCloseTo(3, 10)
  })

  it('uses the largest magnitude, sign ignored', () => {
    expect(axisScale([-4e-9, 1e-9]).exp).toBe(-9)
  })
})

describe('clampNoise', () => {
  it('zeroes the float-noise sliver that would drag the axis below zero', () => {
    // A ±1e-17 bucket remainder from the aggregation, next to real values of order 1.
    expect(clampNoise([2.5, 1.5, -1e-17])).toEqual([2.5, 1.5, 0])
  })

  it('is relative, so genuinely tiny data survives intact', () => {
    // The same absolute value is NOT noise when the whole series is that small — otherwise this
    // would erase the very data axisScale exists to rescue.
    expect(clampNoise([2e-17, -1e-17])).toEqual([2e-17, -1e-17])
  })

  it('keeps real negative values, which are a result and not an artefact', () => {
    expect(clampNoise([10, -3])).toEqual([10, -3])
  })

  it('survives an all-zero series without dividing by anything', () => {
    expect(clampNoise([0, 0])).toEqual([0, 0])
    expect(clampNoise([])).toEqual([])
  })
})
