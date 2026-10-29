/**
 * Integers as the English UI prints them: thousands separated by commas, whatever the machine's locale.
 *
 * `toLocaleString()` without a locale followed the operating system, so a German machine showed
 * "26.533 activities" and "9.958 Elementary flows" in an English interface — a reader of that interface
 * takes 9.958 for "nearly ten" (V336). Five call sites already said `'en-US'`; this makes it
 * every one of them.
 */
export function fmtInt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return ''
  return Number(n).toLocaleString('en-US')
}

/**
 * A day as the English UI prints it on the start page: "Sep 24, 2026". Fixed to en-US for the same
 * reason as `fmtInt` — the interface is English whatever the machine's locale. '' for anything that
 * is not a date.
 */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
