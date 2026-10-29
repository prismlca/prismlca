import { describe, expect, it } from 'vitest'
import { fmtTokens, fmtUsd, money, monthLabel } from './money'

/**
 * The only numbers in PrismLCA that are real money. A wrong one here does not throw and does not look
 * wrong — it looks like a price.
 */

describe('fmtUsd — what a run actually cost', () => {
  it('does not round a real charge down to nothing', () => {
    // The reason this is not just toFixed(2): a $0.0004 call is not "$0.00". The cost table is the
    // one place a user checks against their OpenRouter bill.
    expect(fmtUsd(0.0004)).toBe('$0.0004')
    expect(fmtUsd(0.00004)).toBe('$0.0000') // honest limit: below a hundredth of a cent it is 0
  })

  it('drops digits as the amount grows, at the two documented boundaries', () => {
    expect(fmtUsd(0.009_9)).toBe('$0.0099')
    expect(fmtUsd(0.01)).toBe('$0.010') // boundary: four decimals below, three at
    expect(fmtUsd(0.999)).toBe('$0.999')
    expect(fmtUsd(1)).toBe('$1.00') // boundary: three decimals below, two at
    expect(fmtUsd(2.348_3)).toBe('$2.35')
  })

  it('handles zero and a whole session total', () => {
    expect(fmtUsd(0)).toBe('$0.0000')
    expect(fmtUsd(20.24)).toBe('$20.24')
  })
})

describe('money — a limit the user typed', () => {
  it('always shows two decimals, and a missing value as a dash', () => {
    expect(money(2)).toBe('$2.00')
    expect(money(undefined)).toBe('–')
    expect(money(0)).toBe('$0.00')
  })

  it('is deliberately NOT fmtUsd: the two live on the same page and mean different things', () => {
    // A price per million tokens is a stated figure; spend is measured. Rounding the first is fine,
    // rounding the second hides a charge. If these ever converge, that is a decision, not a tidy-up.
    expect(money(0.0004)).toBe('$0.00')
    expect(fmtUsd(0.0004)).toBe('$0.0004')
  })
})

describe('fmtTokens', () => {
  it('keeps small counts exact and compacts the large ones', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1_000)).toBe('1.0k')
    expect(fmtTokens(15_490)).toBe('15k') // one decimal is dropped from 10k up
    expect(fmtTokens(112_790)).toBe('113k')
  })

  it('switches to millions at a million, and drops the decimal at ten', () => {
    expect(fmtTokens(1_000_000)).toBe('1.0M')
    expect(fmtTokens(1_840_768)).toBe('1.8M')
    expect(fmtTokens(11_927_237)).toBe('12M')
  })
})

describe('monthLabel', () => {
  it('turns a ledger key into a readable month', () => {
    expect(monthLabel('2026-07')).toBe('Jul 2026')
    expect(monthLabel('2026-01')).toBe('Jan 2026')
    expect(monthLabel('2026-12')).toBe('Dec 2026')
  })

  it('does not slide into the previous month in a negative timezone', () => {
    // `new Date(y, m-1, 1)` is LOCAL midnight, which is the whole reason this is not built from a
    // UTC string: an ISO date would render as the month before, west of Greenwich.
    expect(monthLabel('2026-03')).toBe('Mar 2026')
  })

  it('falls back to January rather than an Invalid Date on a malformed key', () => {
    expect(monthLabel('2026')).toBe('Jan 2026')
  })
})
