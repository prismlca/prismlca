import { describe, expect, it } from 'vitest'
import { parseAmount } from './numberFormat'

/**
 * The amount fields, read on every machine the same way.
 *
 * The incident these pin down was measured on 31.08.2026 in this repo's Electron, with real
 * keystrokes: `<input type="number">` hands `0,5` to the app as 0.5 on a German system and as 5 on
 * an English one, because the meaning of a comma was Chromium's locale's to decide. `1.234,5` came
 * out as 1.2345 on both. Nothing in the app could see it happen — the browser reported no bad input,
 * so a silent factor of ten went into the inventory.
 */

/** Spelled out rather than pasted: these are invisible in a diff and a plain space would pass. */
const NBSP = '\u00a0'
const NNBSP = '\u202f'

describe('parseAmount reads a decimal comma', () => {
  it('takes a single separator as the decimal mark, comma or point', () => {
    expect(parseAmount('0,5')).toBe(0.5)
    expect(parseAmount('0.5')).toBe(0.5)
    expect(parseAmount('1,25')).toBe(1.25)
    expect(parseAmount('-0,5')).toBe(-0.5)
    expect(parseAmount('+2,5')).toBe(2.5)
    // The case that decides the rule: 1.234 kg is an everyday inventory figure, so a lone separator
    // is never read as grouping. Both spellings therefore mean the same number.
    expect(parseAmount('1,234')).toBe(1.234)
    expect(parseAmount('1.234')).toBe(1.234)
  })

  it('accepts the shorthands people actually type', () => {
    expect(parseAmount(',5')).toBe(0.5)
    expect(parseAmount('.5')).toBe(0.5)
    expect(parseAmount('5,')).toBe(5)
    expect(parseAmount('  7 ')).toBe(7)
  })

  it('reads scientific notation with either decimal mark', () => {
    // In a German Chromium this was `badInput`, and the empty value behind it committed a zero.
    expect(parseAmount('2,5e-3')).toBe(0.0025)
    expect(parseAmount('2.5e-3')).toBe(0.0025)
    expect(parseAmount('1e-5')).toBe(1e-5)
    expect(parseAmount('1E+6')).toBe(1e6)
    expect(parseAmount('-1,5E-12')).toBe(-1.5e-12)
  })
})

describe('parseAmount and grouped thousands', () => {
  it('reads a repeated separator as grouping', () => {
    expect(parseAmount('1.234.567')).toBe(1234567)
    expect(parseAmount('1,234,567')).toBe(1234567)
  })

  it('takes the last of two separator kinds as the decimal mark', () => {
    // Both spellings of the same number: German and English grouping of 1234.5.
    expect(parseAmount('1.234,5')).toBe(1234.5)
    expect(parseAmount('1,234.5')).toBe(1234.5)
    expect(parseAmount('1.234.567,89')).toBe(1234567.89)
    expect(parseAmount('1,234,567.89')).toBe(1234567.89)
  })

  it('treats every kind of space as grouping', () => {
    expect(parseAmount('1 234,5')).toBe(1234.5)
    expect(parseAmount(`1${NBSP}234,5`)).toBe(1234.5)
    // A number copied out of a French report carries U+202F between the groups.
    expect(parseAmount(`1${NNBSP}234${NNBSP}567`)).toBe(1234567)
  })

  it('refuses grouping that does not group in threes', () => {
    // The alternative is guessing, and a guess here is a factor of ten in the inventory.
    expect(parseAmount('12,345,67')).toBeNull()
    expect(parseAmount('1.23.456')).toBeNull()
    expect(parseAmount('1.2.3,4')).toBeNull()
  })
})

describe('parseAmount refuses rather than inventing a number', () => {
  it('returns null for everything that is not one', () => {
    // Each of these used to arrive as 0 through `Number('')`, overwriting the stored amount.
    for (const bad of [
      '',
      '   ',
      'abc',
      '-',
      '.',
      ',',
      'e5',
      '1-2',
      '0x10',
      '5%',
      '1,2,3',
      'NaN',
      'Infinity'
    ])
      expect(parseAmount(bad), bad).toBeNull()
    expect(parseAmount(null)).toBeNull()
    expect(parseAmount(undefined)).toBeNull()
  })

  it('never returns NaN or an infinity, whatever it is handed', () => {
    expect(parseAmount('1e999')).toBeNull() // overflows to Infinity, which is not an amount
    for (const s of ['0,5', 'abc', '1.234,5', '', '1e999']) {
      const n = parseAmount(s)
      expect(n === null || Number.isFinite(n), s).toBe(true)
    }
  })
})
