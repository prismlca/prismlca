import { describe, expect, it } from 'vitest'
import {
  localiseNumberText,
  reportAxisTick,
  reportColumnDigits,
  reportNumber,
  reportSeriesFormat
} from './numberFormat'

/**
 * The report's number format, tested against the backend's.
 *
 * The incident: a German PDF whose water-use table read "41,3 · 37,7 · 44,9 · 48,5" while the bar
 * chart on the facing page read "48.5 · 44.9 · 37.7 · 41.3" — three divergences at once (decimal
 * mark, exponent form, rounding). Every expectation below is the string `report_i18n.fmt_number`
 * produces for the same input, so the two sides cannot drift apart without a test going red.
 */

/** Spelled out rather than pasted: U+202F is invisible in a diff, and a plain space would pass. */
const NNBSP = '\u202f'

describe('reportNumber follows the report language', () => {
  it('sets the decimal mark of the language, not of the machine', () => {
    expect(reportNumber(41.3, 'en')).toBe('41.3')
    expect(reportNumber(41.3, 'de')).toBe('41,3')
    expect(reportNumber(41.3, 'fr')).toBe('41,3')
    expect(reportNumber(48.5, 'es')).toBe('48,5')
    expect(reportNumber(48.5, 'pt')).toBe('48,5')
  })

  it('groups thousands the way the language does', () => {
    // Pinned digits, i.e. what a table column hands in — the place a grouped number actually shows up.
    expect(reportNumber(1234567.8, 'en', 2)).toBe('1,234,567.80')
    expect(reportNumber(1234567.8, 'de', 2)).toBe('1.234.567,80')
    // French groups with a narrow no-break space (U+202F), which is what Typst sets without breaking.
    expect(reportNumber(1234567.8, 'fr', 2)).toBe(`1${NNBSP}234${NNBSP}567,80`)
  })

  it('writes a very small value in scientific notation with a two-digit exponent', () => {
    // The table says "2,27e-06"; the chart used to say "2.27e-6". Both halves of that were wrong.
    expect(reportNumber(2.27e-6, 'de')).toBe('2,27e-06')
    expect(reportNumber(2.27e-6, 'en')).toBe('2.27e-06')
    expect(reportNumber(2.27e-6, 'fr')).toBe('2,27e-06')
    // Large values leave the fixed range upwards at 1e4, and the sign of the exponent is written out.
    expect(reportNumber(1234567, 'de')).toBe('1,23e+06')
  })

  it('prints zero as a single digit, and keeps it in a pinned column', () => {
    expect(reportNumber(0, 'de')).toBe('0')
    expect(reportNumber(0, 'en')).toBe('0')
    // With digits pinned the zero carries the column's decimals — a bar of zero beside a table cell
    // reading "0,0000" must not read "0".
    expect(reportNumber(0, 'de', 4)).toBe('0,0000')
  })

  it('keeps three significant digits and drops trailing zeros', () => {
    // A count of seven processes is "7", not "7.00" — this formats counts as well as scores.
    expect(reportNumber(7, 'de')).toBe('7')
    expect(reportNumber(1.69571, 'de')).toBe('1,7')
    expect(reportNumber(0.0619804, 'de')).toBe('0,062')
  })

  it('falls back to English for a language without a table, and accepts "de-DE"', () => {
    expect(reportNumber(41.3, 'de-DE')).toBe('41,3')
    expect(reportNumber(41.3, 'it')).toBe('41.3')
    expect(reportNumber(41.3, undefined)).toBe('41.3')
  })

  it('leaves what is not a number alone', () => {
    expect(localiseNumberText('NaN', 'de')).toBe('NaN')
    expect(localiseNumberText('Infinity', 'de')).toBe('Infinity')
    expect(reportNumber(Number.NaN, 'de')).toBe('NaN')
  })
})

describe('a series of bars carries one precision, the table’s', () => {
  it('takes the decimals from the largest value in the series', () => {
    const fmt = reportSeriesFormat([41.3, 37.7, 44.9, 48.5], 'de')
    expect([41.3, 37.7, 44.9, 48.5].map(fmt)).toEqual(['41,3', '37,7', '44,9', '48,5'])
  })

  it('caps at four decimals, which is where the chart used to print a fifth digit', () => {
    // 0.00119 printed as "0.00119" in the figure and "0,0012" in the table: the chart's cap was six.
    expect(reportColumnDigits([0.00119, 0.00106])).toBe(4)
    const fmt = reportSeriesFormat([0.00119, 0.00106], 'de')
    expect([0.00119, 0.00106].map(fmt)).toEqual(['0,0012', '0,0011'])
  })

  it('gives up on common decimals where the series spans orders of magnitude', () => {
    // Forcing one precision there prints either a wall of zeros or nothing at all, so each value is
    // formatted on its own — exactly as the table does it.
    expect(reportColumnDigits([1200, 0.004])).toBeNull()
    expect(reportColumnDigits([2.61e-6, 1.94e-6])).toBeNull()
    const fmt = reportSeriesFormat([2.61e-6, 1.94e-6], 'de')
    expect([2.61e-6, 1.94e-6].map(fmt)).toEqual(['2,61e-06', '1,94e-06'])
  })

  it('sets an axis tick in the language, and swallows the float noise around it', () => {
    // The tick is the charting library's choice; only the notation is the report's.
    expect(reportAxisTick(1200, 'de')).toBe('1.200')
    expect(reportAxisTick(1200, 'en')).toBe('1,200')
    expect(reportAxisTick(5e-7, 'de')).toBe('5e-07')
    expect(reportAxisTick(0, 'de')).toBe('0')
    // 0.1 + 0.2 is the classic: without the guard the axis prints "0.30000000000000004".
    expect(reportAxisTick(0.1 + 0.2, 'de')).toBe('0,3')
    // Pinned decimals, so a scale does not mix 0,001 with 0,0015.
    expect(reportAxisTick(0.001, 'de', 4)).toBe('0,0010')
  })

  it('has no precision to take from an empty or all-zero series', () => {
    expect(reportColumnDigits([])).toBeNull()
    expect(reportColumnDigits([0, 0])).toBeNull()
    // NaN must not pick the format either: it slips past every range check and then poisons log10.
    expect(reportColumnDigits([Number.NaN])).toBeNull()
  })
})
