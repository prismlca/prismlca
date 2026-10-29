import { describe, expect, it } from 'vitest'
import { fmtSig } from './settings'

describe('fmtSig', () => {
  it('renders empty for missing values and 0 for zero', () => {
    expect(fmtSig(null, 3)).toBe('')
    expect(fmtSig(undefined, 3)).toBe('')
    expect(fmtSig(Number.NaN, 3)).toBe('')
    expect(fmtSig(0, 3)).toBe('0')
  })

  it('rounds to the requested significant figures', () => {
    expect(fmtSig(123.456, 3)).toBe('123')
    expect(fmtSig(0.0012345, 2)).toBe('0.0012')
  })

  it('switches to exponential for very small magnitudes (ODP-scale values stay visible)', () => {
    expect(fmtSig(1.234e-8, 3)).toBe('1.23e-8')
  })

  it('switches to exponential for very large magnitudes', () => {
    expect(fmtSig(1234567, 3)).toBe('1.23e+6')
  })

  it('drops trailing zeros in exponential notation, as the fixed notation does', () => {
    expect(fmtSig(0.00005, 6)).toBe('5e-5')
    expect(fmtSig(0.0005, 6)).toBe('0.0005')
    expect(fmtSig(1.2e-5, 4)).toBe('1.2e-5')
    expect(fmtSig(1.05e-5, 3)).toBe('1.05e-5')
    expect(fmtSig(-3e7, 6)).toBe('-3e+7')
  })

  it('chooses the notation on the rounded value', () => {
    expect(fmtSig(999999, 4)).toBe('1e+6')
    expect(fmtSig(1000000, 4)).toBe('1e+6')
    expect(fmtSig(0.000099996, 4)).toBe('0.0001')
  })

  it('never turns a finite value into Infinity by rounding it up', () => {
    expect(fmtSig(1.79e308, 2)).toBe('1.8e+308')
    expect(fmtSig(-1.79e308, 2)).toBe('-1.8e+308')
  })

  it('clamps the digit count to a sane range', () => {
    expect(fmtSig(1.23456789, 0)).toBe('1') // digits < 1 → 1 sig fig
    expect(fmtSig(123.456, 99)).toBe('123.456') // digits > 12 → capped, no crash
  })
})
