/**
 * How much room a report figure's text takes in the faces Typst prints it in, and the legend and the
 * category labels laid out by it.
 *
 * A report figure is drawn by echarts in the renderer and printed by Typst, and the two letter it in
 * different faces: echarts measures in whatever the renderer has — Noto Sans, unless the theme's face
 * happens to be installed on the machine — while Typst draws in the theme's own bundled face. Left to
 * itself, echarts sizes each legend item by its own measurement and wraps the rows by it, and the plot had
 * to be placed under a guessed number of rows at a guessed pitch: a legend that wrapped put its second row
 * across the top of the bars.
 *
 * So the legend is laid out here instead, from one table of advance widths that holds for every face a
 * theme letters a figure in. Each label gets a slot as wide as its widest face needs, the rows break where
 * those slots run out of room, echarts is handed both, and the plot starts under exactly that many rows.
 * Category labels are broken into lines here for the same reason: a line echarts measured to fit its column
 * can print wider than the column in the theme's face.
 */

/**
 * Advance widths of the printable ASCII characters, space to tilde, in hundredths of an em: for each
 * character the widest of the sans faces the themes bundle (Noto Sans, IBM Plex Sans, Open Sans, Libre
 * Franklin, Source Sans 3, Instrument Sans), rounded up. Widest rather than average, because a slot that
 * is too wide costs a little air and one that is too narrow puts a label into its neighbour.
 */
const ADVANCE = [
  26, 29, 43, 72, 61, 93, 78, 25, 41, 41, 56, 60, 28, 51, 28, 45, 69, 60, 60, 65, 65, 66, 67, 60, 67, 66, 30,
  30, 60, 60, 60, 57, 90, 73, 70, 75, 76, 64, 61, 77, 75, 40, 51, 71, 61, 91, 76, 79, 69, 79, 70, 65, 65, 74,
  73, 109, 69, 68, 64, 41, 45, 41, 60, 57, 60, 57, 62, 55, 62, 59, 38, 62, 62, 26, 26, 57, 28, 94, 62, 61, 62,
  62, 42, 52, 39, 62, 55, 80, 56, 53, 50, 41, 56, 41, 60
]

/** A character outside the table: an accented letter is measured as its base letter, anything else as a full em. */
function advance(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  const base = code >= 32 && code <= 126 ? code : (ch.normalize('NFD').codePointAt(0) ?? 0)
  return base >= 32 && base <= 126 ? ADVANCE[base - 32] / 100 : 1
}

/** The width `text` takes at `fontSize` in the widest face a theme can letter a figure in. */
export function textWidth(text: string, fontSize: number): number {
  let em = 0
  for (const ch of text) em += advance(ch)
  return em * fontSize
}

// echarts' own legend geometry, spelled out so the arithmetic here and the option handed over agree.
const SWATCH = 25
const SWATCH_HEIGHT = 14
/** Between a swatch and its label — fixed in echarts, not an option. */
const LABEL_GAP = 5
/** Between two items in a row, and between two rows. */
const ITEM_GAP = 10
const PADDING = 5
/** The widest a legend row may run: inside the narrowest drawing that carries a legend (the radar, 700). */
const LEGEND_WIDTH = 660
/** Air between the legend's last row and whatever comes under it. */
const LEGEND_AIR = 10
/**
 * The line an upright value axis letters its unit on: echarts sets the name 10 above the axis' end in
 * 11-pixel type, so it needs its own line under the legend — beside it, a legend that fills its row runs
 * into the unit.
 */
const UNIT_LINE = 18

/** One legend entry: the series name, and the slot its label gets whatever face prints it. */
type LegendEntry = {
  name: string
  textStyle: { width: number; backgroundColor: string; overflow?: 'truncate' }
}

export interface LegendLayout {
  /** The entries in drawing order, with an empty name wherever a new row starts — echarts' line break. */
  data: (LegendEntry | '')[]
  fontSize: number
  rows: number
  /** Where the last row ends, measured from the top of the drawing. */
  bottom: number
}

/**
 * The legend for `labels`, broken into rows that fit whichever face prints them.
 *
 * Each slot is the label's width in the widest face. echarts sizes an item whose label has a background
 * (here an invisible one) by the label's set width rather than by its own measurement, which is what makes
 * the slot the one computed here. A label too long for a row of its own is cut to fit — the one case in
 * which a slot does not hold its whole text.
 */
export function legendLayout(labels: string[], fontSize: number): LegendLayout {
  const data: (LegendEntry | '')[] = []
  const room = LEGEND_WIDTH - SWATCH - LABEL_GAP
  let rows = 0
  let x = 0
  // echarts draws one item per name, and an empty name is its line break — neither may reach the layout.
  for (const name of new Set(labels.filter((label) => label !== ''))) {
    const width = Math.min(Math.ceil(textWidth(name, fontSize)), room)
    const slot = SWATCH + LABEL_GAP + width
    if (rows === 0) rows = 1
    else if (x + slot > LEGEND_WIDTH) {
      data.push('')
      rows += 1
      x = 0
    }
    const cut = width === room ? { overflow: 'truncate' as const } : {}
    data.push({ name, textStyle: { width, backgroundColor: 'rgba(0,0,0,0)', ...cut } })
    x += slot + ITEM_GAP
  }
  const bottom = rows ? PADDING + rows * SWATCH_HEIGHT + (rows - 1) * ITEM_GAP : 0
  return { data, fontSize, rows, bottom }
}

/**
 * The echarts legend option for a layout. Its width is the layout's, so echarts never wraps a row the
 * layout did not break; it centres the legend by its widest row.
 */
export function legendOption(layout: LegendLayout, color: string) {
  return {
    top: 0,
    left: 'center' as const,
    width: LEGEND_WIDTH,
    textStyle: { color, fontSize: layout.fontSize },
    data: layout.data
  }
}

/** Where a chart's plot starts: under the legend's rows and, when the value axis stands upright, under its unit. */
export function plotTop(layout: LegendLayout, unitLine: boolean): number {
  return layout.bottom + LEGEND_AIR + (unitLine ? UNIT_LINE : 0)
}

/** `text` cut at the end, with an ellipsis, to fit `width` in every face. */
export function ellipsize(text: string, width: number, fontSize: number): string {
  if (textWidth(text, fontSize) <= width) return text
  const chars = [...text]
  while (chars.length && textWidth(`${chars.join('').trimEnd()}…`, fontSize) > width) chars.pop()
  return `${chars.join('').trimEnd()}…`
}

/** A wrapped label, and whether wrapping it had to cut into a word or cut its end off. */
interface Wrapped {
  lines: string[]
  /** A word was wider than the line and was broken between two characters. */
  split: boolean
  /** It ran past the last line allowed and ends in an ellipsis. */
  cut: boolean
}

/**
 * A unit of measure as it follows a number in a variant's name — mass, length, area, volume, energy, power,
 * time and the transport units — with an optional SI prefix and the closing bracket or punctuation that may
 * trail it.
 */
const UNIT =
  /^(?:[kMGTmµcn]?(?:g|t|m|m²|m³|L|l|W|Wh|J|Pa)|km²|tkm|pkm|vkm|kWp|h|min|s|d|a|yr|ppm|°C|K)[)\].,;:]*$/u

/**
 * Break `text` into lines of at most `width` in every face, at spaces and after a hyphen or a slash, and
 * between two characters only where a single word is wider than the line. Past `maxLines` the last line
 * ends in an ellipsis.
 */
export function wrapLabel(text: string, width: number, fontSize: number, maxLines: number): Wrapped {
  const fits = (line: string): boolean => textWidth(line, fontSize) <= width
  // Pieces that may start a new line: a word after a space (`space`), or the rest of a word after its
  // hyphen or slash ("Bio-" | "based"), which joins its line without one.
  // A sign standing on its own ("50 %", "A & B") stays with the word before it: a line that starts with
  // a bare % reads as a fault. So does a unit after its number ("(1200 km)", "0.75 L"), as a non-breaking
  // space would keep them: a number at the end of one line and its unit at the start of the next read as
  // two things. Units by name only, so "2030 and" may still break.
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .reduce<string[]>((out, word) => {
      const before = out[out.length - 1]
      const sign = /^[^\p{L}\p{N}(]{1,2}$/u.test(word)
      const unit = before !== undefined && /\p{N}$/u.test(before) && UNIT.test(word)
      if (before !== undefined && (sign || unit)) out[out.length - 1] = `${before} ${word}`
      else out.push(word)
      return out
    }, [])
  const pieces = words.flatMap((word) => word.split(/(?<=[-/])/).map((part, i) => ({ part, space: i === 0 })))
  const lines: string[] = []
  let line = ''
  let split = false
  for (const { part, space } of pieces) {
    const joined = line ? `${line}${space ? ' ' : ''}${part}` : part
    if (fits(joined)) {
      line = joined
      continue
    }
    if (line) lines.push(line)
    line = ''
    let rest = part
    while (!fits(rest)) {
      // A piece wider than a whole line: as many characters as fit, at least one.
      const chars = [...rest]
      let n = chars.length - 1
      while (n > 1 && !fits(chars.slice(0, n).join(''))) n -= 1
      lines.push(chars.slice(0, n).join(''))
      rest = chars.slice(n).join('')
      split = true
    }
    line = rest
  }
  if (line || !lines.length) lines.push(line)
  if (lines.length <= maxLines) return { lines, split, cut: false }
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = ellipsize(`${kept[maxLines - 1]} ${lines[maxLines]}`, width, fontSize)
  return { lines: kept, split, cut: true }
}

/** Category labels fitted to their column: one type size for all of them, and each one's lines. */
export interface FittedLabels {
  fontSize: number
  lineHeight: number
  /** The widest line of all of them, in the widest face — the box every label is given. */
  width: number
  /** Each label's lines, joined by line breaks, in the order of the labels. */
  text: string[]
  /** The most lines any label takes. */
  lines: number
  /** Even at the smallest size some word had to be split, or some label cut short. */
  split: boolean
  cut: boolean
}

/**
 * Fit every label into `width`, at the largest of `sizes` at which no word has to be split and no label cut
 * short; where even the smallest cannot manage that, the smallest it is, split and cut. One size for all of
 * them: an axis whose names change size from one column to the next reads as a mistake.
 */
export function fitLabels(labels: string[], width: number, sizes: number[], maxLines: number): FittedLabels {
  let fitted: Wrapped[] = []
  let fontSize = sizes[sizes.length - 1]
  for (const size of sizes) {
    fitted = labels.map((label) => wrapLabel(label, width, size, maxLines))
    fontSize = size
    if (fitted.every((w) => !w.split && !w.cut)) break
  }
  const all = fitted.flatMap((w) => w.lines)
  return {
    fontSize,
    lineHeight: Math.round(fontSize * 1.1),
    width: Math.ceil(Math.max(0, ...all.map((line) => textWidth(line, fontSize)))),
    text: fitted.map((w) => w.lines.join('\n')),
    lines: Math.max(1, ...fitted.map((w) => w.lines.length)),
    split: fitted.some((w) => w.split),
    cut: fitted.some((w) => w.cut)
  }
}
