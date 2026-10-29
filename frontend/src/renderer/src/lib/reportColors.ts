/**
 * The colours a report's figures are drawn in, derived from the report's colour set.
 *
 * The figures are drawn here in the renderer, so until now they took the *app's* theme tokens: a document
 * typeset in Steel & ink came out with lime-green bars in it, which is two designs in one report. They now
 * start from the set the report names — accent, deep tone, paper — and everything else is derived from those
 * three, so a palette chosen under Appearance reaches the charts as well as the type.
 *
 * Why derive rather than ship a list per palette: a chart needs as many colours as the data has series, and
 * nobody knows that number in advance — eleven life-cycle phases is an ordinary contribution chart. A hand-
 * picked list would run out and start repeating, which in a stacked bar means two segments that look like one.
 *
 * How: in OKLCH, which is perceptual — a hue step of 20° looks like the same size of step wherever it starts,
 * and a lightness of 0.6 is the same apparent lightness at every hue. (In HSL neither holds: yellow at 50%
 * lightness is far brighter than blue at 50%.) The ramp walks *away* from the accent's hue in alternating
 * directions, widening as it goes, and alternates lightness so neighbours differ in two channels at once —
 * two greens of the same lightness are one green in a stacked bar, but a lighter green and a darker teal read
 * as two. The accent leads because it is the colour the reader already associates with the document.
 */

export type ReportPalette = {
  /** The accent: rules, marks, the leading series. */
  accent: string
  /** The deep tone: headings, dark bands, the second series. */
  deep: string
  /** The cover's paper — the pale end of a heat ramp. */
  paper: string
}

/** The values every theme carried before palettes existed, so a report that names none still gets these. */
export const PRISM_PALETTE: ReportPalette = { accent: '#93c120', deep: '#2f4e66', paper: '#f8f9fa' }

// ---------------------------------------------------------------------------
// sRGB ↔ OKLab. The short version of the standard conversion (Björn Ottosson):
// sRGB → linear → LMS → cube root → Lab. No dependency, and the whole thing is
// forty lines — a colour library would be a megabyte for this.
// ---------------------------------------------------------------------------

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const linearToSrgb = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim()
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h
  const n = parseInt(full.slice(0, 6) || '000000', 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

function toHex(r: number, g: number, b: number): string {
  const two = (x: number): string =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${two(r)}${two(g)}${two(b)}`
}

/** OKLCH: lightness 0–1, chroma (0 is grey, ~0.37 is as saturated as sRGB gets), hue in degrees. */
export function toOklch(hex: string): { l: number; c: number; h: number } {
  const [r0, g0, b0] = parseHex(hex).map(srgbToLinear) as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r0 + 0.5363325363 * g0 + 0.0514459929 * b0)
  const m = Math.cbrt(0.2119034982 * r0 + 0.6806995451 * g0 + 0.1073969566 * b0)
  const s = Math.cbrt(0.0883024619 * r0 + 0.2817188376 * g0 + 0.6299787005 * b0)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { l: L, c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180) / Math.PI }
}

export function fromOklch(l: number, c: number, h: number): string {
  const rad = (h * Math.PI) / 180
  const a = Math.cos(rad) * c
  const b = Math.sin(rad) * c
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return toHex(
    linearToSrgb(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    linearToSrgb(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    linearToSrgb(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)
  )
}

/** Blend two colours perceptually. `t = 0` is `a`, `t = 1` is `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = toOklch(a)
  const y = toOklch(b)
  // A near-grey has no hue worth interpolating — its own is whatever rounding left behind. Taking it
  // literally is what turned a ramp from an almost-white paper towards lime green into a pale *blue*: the
  // paper's nominal hue is 250°, so the first half of the ramp travelled through blue to get to green. When
  // one end is grey, the other end's hue holds and only chroma moves.
  const xh = x.c < 0.02 ? y.h : x.h
  const yh = y.c < 0.02 ? x.h : y.h
  // Around the short way: 350° to 10° is a 20° step, not a 340° one.
  let dh = yh - xh
  if (dh > 180) dh -= 360
  if (dh < -180) dh += 360
  return fromOklch(x.l + (y.l - x.l) * t, x.c + (y.c - x.c) * t, xh + dh * t)
}

/**
 * `n` colours for `n` series, starting from the palette's own two.
 *
 * The first two are the accent and the deep tone exactly as the document uses them — a two-series chart is
 * the common case (baseline against variant) and it should look like the report it sits in. From the third
 * on, hues step away from the accent alternately (+34°, −34°, +68°, …) while lightness alternates around the
 * accent's own, so no two neighbours differ in hue alone. Chroma is held near the accent's but never below
 * 0.05, or a "colour" late in a long series would be a grey among colours.
 */
export function seriesColors(n: number, palette: ReportPalette = PRISM_PALETTE): string[] {
  const acc = toOklch(palette.accent)
  const out = [palette.accent, palette.deep]
  if (n <= 2) return out.slice(0, Math.max(1, n))
  // Held below the accent's own saturation and never above 0.12: this is a document, not a dashboard. Left
  // at the accent's chroma the derived hues came out as neon — a 0.2-chroma cyan at lightness 0.8 is a
  // highlighter, and printed next to grey type it is the only thing on the page anybody sees.
  const c = Math.max(0.045, Math.min(0.12, acc.c * 0.8))
  for (let i = 2; i < n; i++) {
    const step = Math.ceil((i - 1) / 2) * 34
    const hue = acc.h + (i % 2 === 0 ? step : -step)
    // Alternating around the accent's lightness so neighbours differ in two channels at once, and inside a
    // band that stays readable: below 0.45 a colour is hard to tell from the axis, above 0.74 it is hard to
    // see on paper at all.
    const swing = 0.11 * (i % 4 < 2 ? 1 : -1)
    const l = Math.max(0.45, Math.min(0.74, acc.l + swing))
    out.push(fromOklch(l, c, hue))
  }
  return out.slice(0, n)
}

/**
 * A heat ramp for the heatmap: paper at the low end, the accent in the middle, the deep tone at the top.
 *
 * Three stops rather than two, because a two-stop ramp between a pale paper and a dark navy passes through
 * a muddy middle where most cells land. Going through the accent keeps the middle of the scale legible and
 * makes "high" unmistakably the darkest cell.
 */
export function heatColor(t: number, palette: ReportPalette = PRISM_PALETTE): string {
  const x = clamp01(t)
  return x <= 0.5
    ? mix(mix(palette.paper, palette.accent, 0.25), palette.accent, x * 2)
    : mix(palette.accent, palette.deep, (x - 0.5) * 2)
}

/** Ink for text drawn inside a filled shape: the paper on a dark fill, the deep tone on a light one. */
export function onColor(fill: string, palette: ReportPalette = PRISM_PALETTE): string {
  return toOklch(fill).l < 0.62 ? palette.paper : palette.deep
}

/**
 * The furniture of a report figure: the colours of everything that is not data.
 *
 * A figure is drawn in the renderer and lands in a Typst document, so it takes its ink from the
 * *document*, not from the app around it. Before this existed the axis text came from the app's
 * `--ink` — dark, which is right on white paper and invisible on the Network dark theme's near-black.
 * And the app's own light/dark switch leaked into the PDF: the same report exported twice,
 * once with the app in dark mode, produced charts with different axis colours.
 *
 * `dark` comes from the theme's registry entry through `/sources`, because the paper is the theme's
 * own decision — the dark theme sets it locally, so no colour set can tell you.
 *
 * The values mirror the Typst themes' tone blocks; this module is where such literals belong — inside
 * a view they were hand-duplicated hex, one theme edit away from drifting. The plot area stays
 * transparent either way: the SVG sits on the page, and the page already has a colour.
 */
export type FigureInk = { ink: string; axis: string; grid: string; edge: string }

export function figureInk(dark: boolean): FigureInk {
  return dark
    ? { ink: '#ecedee', axis: '#8b949c', grid: 'rgba(236,237,238,0.14)', edge: '#3a4149' }
    : { ink: '#14181c', axis: '#5c636b', grid: 'rgba(20,24,28,0.12)', edge: '#cdd1cc' }
}

/** What someone types into a colour field, as `#rrggbb` — `#abc`, `abc`, `#AABBCC` and `aabbcc` all count,
 *  because that is what colour pickers and style guides hand you. Anything else is `null`. */
export function hexInput(raw: string): string | null {
  const v = raw.trim().toLowerCase().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/.test(v)) return `#${[...v].map((c) => c + c).join('')}`
  if (/^[0-9a-f]{6}$/.test(v)) return `#${v}`
  return null
}

/** The WCAG contrast ratio of two colours: 1 for the same colour, 21 for black on white. 4.5 is what body
 *  text needs, 3 what large type and shapes need. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = parseHex(hex).map(srgbToLinear)
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
