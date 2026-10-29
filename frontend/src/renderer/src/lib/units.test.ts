import { describe, expect, it } from 'vitest'
import { shortUnit } from './units'

describe('shortUnit', () => {
  it('maps known ecoinvent units to their international short form', () => {
    expect(shortUnit('kilogram')).toBe('kg')
    expect(shortUnit('kilowatt hour')).toBe('kWh')
    expect(shortUnit('square meter')).toBe('m²')
    expect(shortUnit('cubic meter')).toBe('m³')
    expect(shortUnit('litre')).toBe('L')
    expect(shortUnit('ton kilometer')).toBe('tkm')
    expect(shortUnit('square meter-year')).toBe('m²a')
  })

  it('is case-insensitive and trims', () => {
    expect(shortUnit('Kilo Becquerel')).toBe('kBq')
    expect(shortUnit('  megajoule ')).toBe('MJ')
  })

  it('includes the pre-emptive future units', () => {
    expect(shortUnit('gram')).toBe('g')
    expect(shortUnit('gigajoule')).toBe('GJ')
    expect(shortUnit('mile')).toBe('mi')
    expect(shortUnit('ton')).toBe('t')
  })

  it('falls back to the long form, ellipsised past 7 chars', () => {
    expect(shortUnit('unit')).toBe('unit')
    expect(shortUnit('guest night')).toBe('guest n…')
    expect(shortUnit('EUR2005')).toBe('EUR2005') // exactly 7 → not cut
  })

  it('returns null for empty input', () => {
    expect(shortUnit(null)).toBeNull()
    expect(shortUnit('')).toBeNull()
  })
})
