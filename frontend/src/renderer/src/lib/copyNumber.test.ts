import { describe, expect, it } from 'vitest'
import { clipboardNumber, decimalSeparator } from './copyNumber'

describe('a number for the clipboard', () => {
  it('takes the decimal separator of the regional format', () => {
    expect(decimalSeparator('de-DE')).toBe(',')
    expect(decimalSeparator('en-GB')).toBe('.')
    expect(decimalSeparator('not a locale!')).toBe('.')
  })

  it('keeps every digit, groups nothing and writes an exponent the way spreadsheets do', () => {
    expect(clipboardNumber(0.1 + 0.2, ',')).toBe('0,30000000000000004')
    expect(clipboardNumber(1234567.5, ',')).toBe('1234567,5')
    expect(clipboardNumber(1.2e-7, ',')).toBe('1,2E-7')
    expect(clipboardNumber(-3.5e21, '.')).toBe('-3.5E+21')
    expect(clipboardNumber(42, ',')).toBe('42')
  })
})
