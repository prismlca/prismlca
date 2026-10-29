/**
 * Formatting the figures in the cost table.
 *
 * Extracted from `views/Settings.tsx` so they can be tested: these are the only numbers in PrismLCA
 * that are actual money, and a wrong one is invisible — it renders, it looks like a price, and the
 * only way to notice is to add up the column by hand.
 */

/** Two decimals always. Used where the value is a price the user typed or a limit they set. */
export function money(v: number | undefined): string {
  return v == null ? '–' : `$${v.toFixed(2)}`
}

/**
 * Spend, with precision that follows the magnitude.
 *
 * Deliberately different from {@link money}: a run that cost $0.0004 is not "$0.00", and rounding it
 * to two places would report a real charge as nothing at all. Above a dollar the extra digits are
 * noise, so they go.
 */
export function fmtUsd(v: number): string {
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

/** Compact token counts: the numbers reach millions and exact digits carry no meaning here. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

/** `"2026-07"` → `"Jul 2026"`. */
export function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  const d = new Date(y, (m || 1) - 1, 1)
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' })
}
