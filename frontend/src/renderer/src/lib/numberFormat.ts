/**
 * Turning impact scores into numbers a person can read.
 *
 * These lived inside `views/Results.tsx` as module-private helpers, which meant the arithmetic that
 * decides what a chart actually SAYS could not be tested. They are the class of bug that never
 * throws: the figure renders, the label is wrong, and nobody finds out from the software.
 */

/** Internal marker returned by {@link autoDecimals} when the series only reads in scientific notation. */
export const SCIENTIFIC = -2

/** Sentinel for "let the data decide", stored in the same integer channel as a real decimal count. */
export const AUTO_DECIMALS = -1

/**
 * How many decimals a series of bar labels should carry.
 *
 * Fixed decimals were the problem: at the old default of six, a score of 1.69571 printed as
 * "1.695710" and 0.0619804 as "0.061980" — digits that say nothing about a result whose input data
 * justify three significant figures at best. The precision follows the *largest* value in the series,
 * so every bar carries the same number of decimals (a column of differing precisions reads as
 * carelessness), and impact scores below 0.1 mg-scale magnitudes switch to scientific notation, which
 * is how they are written in the literature anyway.
 */
export function autoDecimals(values: number[]): number {
  const mags = values.map((v) => Math.abs(v)).filter((x) => x > 0 && Number.isFinite(x))
  if (!mags.length) return 2
  const max = Math.max(...mags)
  if (max >= 1e6 || max < 1e-4) return SCIENTIFIC
  return Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(max))))
}

export function labelNum(v: number, decimals: number): string {
  if (decimals === SCIENTIFIC) return v === 0 ? '0' : v.toExponential(2)
  // An unresolved AUTO_DECIMALS is a caller that forgot to ask `autoDecimals` for a series — it
  // used to clamp to zero decimals, which turned 0.105 into "1e-1" in the Results matrix and read
  // as a formatting choice rather than the bug it was. Nothing here knows the series, so it falls
  // back to the three significant figures the scientific branch uses. Other negative counts stay
  // clamped: those are garbage input, not a sentinel.
  if (decimals === AUTO_DECIMALS) return v === 0 ? '0' : v.toExponential(2)
  const d = Math.max(0, Math.min(8, decimals))
  if (!v) return (0).toFixed(d)
  const a = Math.abs(v)
  // Very large, or too small for the chosen precision → scientific. THREE significant figures, not
  // `d`: with d = 0 the old form printed a single digit ("6e-4" for 0.00063), which says less than
  // the fixed notation it was standing in for.
  if (a >= 1e6 || a < Math.pow(10, -d)) return v.toExponential(Math.max(2, Math.min(d, 6)))
  return v.toFixed(d)
}

/** ECharts' nice-tick axis degenerates for magnitudes below ~1e-10 (no ticks, baseline drifting
 * below zero although every bar is positive — e.g. human-toxicity scores of 1e-12 CTUh). Rescale
 * such data by a power of ten and annotate the axis with the factor instead. */
export function axisScale(values: number[]): { exp: number; factor: number } {
  const absMax = Math.max(...values.map((v) => Math.abs(v)), 0)
  if (!absMax || (absMax >= 1e-3 && absMax < 1e6)) return { exp: 0, factor: 1 }
  const exp = Math.floor(Math.log10(absMax))
  return { exp, factor: 10 ** -exp }
}

/** Zero out float-noise values (±1e-17 bucket remainders from the aggregation): one tiny
 * NEGATIVE sliver otherwise forces the whole axis a full tick below zero. */
export function clampNoise(values: number[]): number[] {
  const eps = Math.max(...values.map((v) => Math.abs(v)), 0) * 1e-9
  return values.map((v) => (Math.abs(v) < eps ? 0 : v))
}

/**
 * Report numbers: the same format the document's tables use.
 *
 * Everything above formats for the SCREEN, where the app speaks English and a chart sits beside an
 * English table. A report is a different document: it has a language of its own, and its tables are
 * set by the backend (`report_i18n.fmt_number` / `fmt_column`). A figure drawn here lands on the page
 * beside one of those tables, so in a German report the chart printed `48.5` next to a table cell
 * reading `41,3` — same number, two notations, on facing pages (V187).
 *
 * The rules below therefore mirror the backend's deliberately: separators per language, two mantissa
 * digits with a two-digit exponent, three significant digits otherwise, and a column's decimals taken
 * from its largest magnitude. Two rules in one file on purpose — the difference between "what the
 * screen says" and "what the document says" is the thing worth seeing at a glance.
 */

/** Decimal and thousands separator per report language — the backend's `SEPARATORS`, verbatim.
 *  French groups with a narrow no-break space (U+202F), which is what the Imprimerie nationale
 *  prescribes and what Typst sets without breaking the line. */
export const REPORT_SEPARATORS: Record<string, readonly [string, string]> = {
  en: ['.', ','],
  de: [',', '.'],
  // Written as an escape: an invisible U+202F in the source is a character nobody can review.
  fr: [',', '\u202f'],
  es: [',', '.'],
  pt: [',', '.']
}

/** Accept "de", "de-DE", "DE_at" — anything without a separator table reads as English, like
 *  `report_i18n.normalise` on the other side. */
export function reportLang(lang: string | null | undefined): string {
  const base = String(lang ?? '')
    .replace('_', '-')
    .split('-')[0]
    .toLowerCase()
  return base in REPORT_SEPARATORS ? base : 'en'
}

/**
 * Re-set an ASCII number ("1234.5", "5e-7") in the report language.
 *
 * Takes the digits as they are and only changes the notation, which is what an axis tick needs: the
 * charting library picked the tick and the number of digits it carries, and second-guessing that
 * produces a scale nobody chose. The exponent is padded to two digits (`e-07`, not `e-7`) because
 * that is what Python's `%.2e` writes into the tables.
 */
export function localiseNumberText(text: string, lang = 'en'): string {
  const [dec, thou] = REPORT_SEPARATORS[reportLang(lang)]
  const m = /^([+-]?)(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim())
  if (!m) return text // NaN, Infinity, a label that is not a number: leave it alone
  const [, sign, int, frac, exp] = m
  const mantissa = `${int || '0'}${frac ? dec + frac : ''}`
  if (exp !== undefined) {
    // Scientific notation carries no grouping — there is never more than one digit before the mark.
    const e = Number(exp)
    return `${sign}${mantissa}e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`
  }
  const grouped = (int || '0').replace(/\B(?=(\d{3})+(?!\d))/g, thou)
  return `${sign}${grouped}${frac ? dec + frac : ''}`
}

/**
 * One number, formatted as the report's tables format it (`report_i18n.fmt_number`).
 *
 * `digits` pins the decimals — how a column keeps one precision. Without it: three significant
 * digits, scientific outside 1e-3…1e4, and trailing zeros dropped, because a count of seven
 * processes is "7" and not "7.00".
 */
export function reportNumber(value: number, lang = 'en', digits?: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (digits != null)
    return localiseNumberText(toFixedHalfEven(value, Math.max(0, Math.min(8, digits))), lang)
  if (value === 0) return '0'
  const ax = Math.abs(value)
  if (ax >= 1e4 || ax < 1e-3) return localiseNumberText(value.toExponential(2), lang)
  let raw = toFixedHalfEven(value, Math.max(0, 2 - Math.floor(Math.log10(ax))))
  if (raw.includes('.')) raw = raw.replace(/0+$/, '').replace(/\.$/, '')
  return localiseNumberText(raw, lang)
}

/**
 * `toFixed`, except that an EXACT half rounds to the even neighbour — which is what Python's format
 * does for the tables. The two disagree on nothing else: both round the binary value, and 12.5 is
 * the kind of value that is exact in binary, so "13" stood in a figure over "12" in its table.
 * A half that is not exact (1.005) is below or above it in binary for both.
 */
function toFixedHalfEven(value: number, digits: number): string {
  const scale = 10 ** digits
  const scaled = value * scale
  const low = Math.floor(scaled)
  if (scaled - low === 0.5 && Number.isFinite(scaled)) {
    const even = low % 2 === 0 ? low : low + 1
    return (even / scale).toFixed(digits)
  }
  return value.toFixed(digits)
}

/**
 * Decimals shared by a whole series, or null for "format each value on its own".
 *
 * `report_i18n.fmt_column`, mirrored: the precision follows the LARGEST magnitude, so the leading
 * value reads cleanly and the small ones fall away into zeros; a series spanning orders of magnitude
 * gives up on common decimals, because forcing them there prints either a wall of zeros or nothing.
 * The four-decimal cap is the table's, and it is the reason a figure ever disagreed about rounding.
 */
export function reportColumnDigits(values: number[]): number | null {
  const finite = values.filter((v) => v !== 0 && Number.isFinite(v)).map((v) => Math.abs(v))
  if (!finite.length) return null
  const low = Math.min(...finite)
  const high = Math.max(...finite)
  if (high / low >= 1e4 || high >= 1e5 || high < 1e-3 || low < 1e-6) return null
  return Math.max(0, Math.min(4, 2 - Math.floor(Math.log10(high))))
}

/**
 * One axis tick, in the report's notation.
 *
 * `decimals` pins them, which is what a scale wants — 0.001 / 0.0015 / 0.002 side by side reads as
 * three precisions. Without it the tick keeps the digits the charting library gave it and only the
 * notation changes; `toPrecision(12)` strips the float noise that turns a tick of 0.3 into
 * "0.30000000000000004", and nothing else, because 12 digits is well past what any tick carries.
 */
export function reportAxisTick(value: number, lang = 'en', decimals = 0): string {
  if (!Number.isFinite(value)) return String(value)
  return localiseNumberText(decimals ? value.toFixed(decimals) : String(Number(value.toPrecision(12))), lang)
}

/** The value-label formatter for a series of bars: the column rule above, bound to a language. */
export function reportSeriesFormat(values: number[], lang = 'en'): (v: number) => string {
  const digits = reportColumnDigits(values)
  return (v) => reportNumber(v, lang, digits ?? undefined)
}

/**
 * A hand-typed amount, read the way the person meant it.
 *
 * `<input type="number">` looks like it settles this and does the opposite: what a comma means is
 * decided by Chromium's locale, which is to say by the machine the app happens to run on. Measured
 * with this repo's Electron, real keystrokes through CDP: on a German system `0,5` arrives
 * as 0.5, on an English one the comma is silently DELETED and the same keystrokes arrive as 5 — no
 * `badInput`, no warning, a factor of ten into the inventory. Both locales read `1.234,5` as 1.2345.
 * And because `Number('')` is 0 rather than NaN, every rejected keystroke (`abc`, `2,5e-3` in German)
 * committed a zero over the value that was there.
 *
 * So the amount fields are plain text now and this is the only thing that reads them:
 *   - ONE separator is the decimal mark, whichever character it is — `1,234` and `1.234` are both
 *     1.234. An amount of 1.234 kg is an everyday inventory figure; a hand-typed thousands separator
 *     is not, and the other reading would turn 1.234 kg into 1234 kg on a guess.
 *   - a separator that REPEATS is grouping — `1.234.567` and `1,234,567` are both 1234567.
 *   - BOTH kinds present: the last one is the decimal mark and the other is grouping, so `1.234,5`
 *     and `1,234.5` are both 1234.5.
 *   - grouping has to group in threes, or the text is refused rather than reinterpreted.
 *   - spaces are grouping and drop out, including the no-break kinds a pasted table brings along.
 *
 * Everything else returns null, and a null is never turned into a number by a caller — that is the
 * whole point of the exercise.
 */
export function parseAmount(raw: string | null | undefined): number | null {
  const text = String(raw ?? '')
    // Grouping spaces: plain, NBSP, narrow NBSP (French grouping, see REPORT_SEPARATORS), thin space.
    .replace(/[\s\u00a0\u202f\u2009]/g, '')
    // U+2212 MINUS SIGN, which is what a value copied out of a typeset table carries.
    .replace(/\u2212/g, '-')
  if (!text) return null
  const m = /^([+-]?)([0-9.,]*)(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!m) return null
  const [, sign, mantissa, exp] = m
  if (!/\d/.test(mantissa)) return null // "-", ".", "e5": a sign or a separator is not a number

  const dots = (mantissa.match(/\./g) ?? []).length
  const commas = (mantissa.match(/,/g) ?? []).length
  let decimal: '.' | ',' | null = null
  if (dots && commas) decimal = mantissa.lastIndexOf('.') > mantissa.lastIndexOf(',') ? '.' : ','
  else if (dots === 1) decimal = '.'
  else if (commas === 1) decimal = ','
  // A decimal mark that appears twice is not a decimal mark: "1.2.3,4" is nothing anybody typed on purpose.
  if (decimal && (decimal === '.' ? dots : commas) !== 1) return null

  const cut = decimal ? mantissa.lastIndexOf(decimal) : -1
  const intPart = decimal ? mantissa.slice(0, cut) : mantissa
  const fracPart = decimal ? mantissa.slice(cut + 1) : ''
  if (!/^\d*$/.test(fracPart)) return null // a grouping mark after the decimal mark

  const group = decimal === '.' ? ',' : decimal === ',' ? '.' : dots ? '.' : commas ? ',' : null
  if (group && intPart.includes(group)) {
    // Groups of three, with 1–3 digits leading. "12,345,67" is refused, not read as 1234567.
    const g = group === '.' ? '\\.' : ','
    if (!new RegExp(`^\\d{1,3}(?:${g}\\d{3})+$`).test(intPart)) return null
  } else if (!/^\d*$/.test(intPart)) return null

  const digits = intPart.replace(/[.,]/g, '') || '0'
  const n = Number(`${sign}${digits}.${fracPart || '0'}${exp ? `e${exp}` : ''}`)
  return Number.isFinite(n) ? n : null
}
