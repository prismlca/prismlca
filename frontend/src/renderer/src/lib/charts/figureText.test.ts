import { describe, expect, it } from 'vitest'

import { ellipsize, fitLabels, legendLayout, legendOption, plotTop, textWidth, wrapLabel } from './figureText'

const variants = (n: number): string[] => Array.from({ length: n }, (_, i) => `Variant number ${i}`)

/** The legend entries a layout hands echarts, as names with the row breaks marked. */
function rowsOf(labels: string[], fontSize = 10): string[][] {
  const rows: string[][] = [[]]
  for (const entry of legendLayout(labels, fontSize).data) {
    if (entry === '') rows.push([])
    else rows[rows.length - 1].push(entry.name)
  }
  return rows
}

describe('figure text widths', () => {
  it('measure a label in the widest bundled face, not in an average glyph', () => {
    // Capitals are wider than lower case in every face; the old six-pixel average undercounted them.
    expect(textWidth('SCENARIO B', 10)).toBeGreaterThan(textWidth('scenario b', 10))
    expect(textWidth('SCENARIO B: BIO-BASED PE', 10)).toBeGreaterThan(24 * 6)
    // Linear in the type size.
    expect(textWidth('Baseline', 20)).toBeCloseTo(2 * textWidth('Baseline', 10))
  })

  it('measure an accented letter as its base letter and anything unknown as a full em', () => {
    expect(textWidth('Ölpreis', 10)).toBe(textWidth('Olpreis', 10))
    expect(textWidth('é', 10)).toBe(textWidth('e', 10))
    expect(textWidth('中', 10)).toBe(10)
  })
})

describe('the figure legend', () => {
  it('breaks into rows where the slots run out of room, and says so to echarts', () => {
    const labels = Array.from({ length: 8 }, (_, i) => `Alternative supplier ${i + 1}, rail freight`)
    const rows = rowsOf(labels)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows.flat()).toEqual(labels)
    expect(legendLayout(labels, 10).rows).toBe(rows.length)
    // A short legend stays on one row.
    expect(rowsOf(['Baseline', 'Variant'])).toEqual([['Baseline', 'Variant']])
  })

  it('gives every label a slot as wide as its widest face needs', () => {
    const { data } = legendLayout(['SCENARIO C: RAIL FREIGHT', 'baseline'], 10)
    for (const entry of data) {
      if (entry === '') continue
      expect(entry.textStyle.width).toBeGreaterThanOrEqual(textWidth(entry.name, 10))
      // A background, invisible, is what makes echarts size the item by this width.
      expect(entry.textStyle.backgroundColor).toBe('rgba(0,0,0,0)')
    }
  })

  it('cuts only a label too long for a row of its own', () => {
    const long = 'x'.repeat(200)
    const [entry] = legendLayout([long], 10).data
    expect(entry !== '' && entry.textStyle.overflow).toBe('truncate')
    const [short] = legendLayout(['Baseline'], 10).data
    expect(short !== '' && short.textStyle.overflow).toBeUndefined()
  })

  it('drops what echarts would not draw as an item: repeats and empty names', () => {
    expect(rowsOf(['A', 'B', 'A', ''])).toEqual([['A', 'B']])
    expect(legendLayout([], 10)).toMatchObject({ rows: 0, bottom: 0, data: [] })
  })

  it('ends its last row where echarts puts it: 14-pixel rows, 10 apart, under 5 of padding', () => {
    expect(legendLayout(['A'], 10).bottom).toBe(19)
    const two = legendLayout(variants(12), 10)
    expect(two.bottom).toBe(5 + two.rows * 14 + (two.rows - 1) * 10)
  })

  it('starts the plot under the legend, and under the unit when the value axis stands upright', () => {
    for (const n of [1, 4, 12]) {
      const layout = legendLayout(variants(n), 10)
      expect(plotTop(layout, false)).toBeGreaterThan(layout.bottom)
      expect(plotTop(layout, true)).toBeGreaterThan(plotTop(layout, false))
    }
  })

  it('hands echarts the same width it broke the rows by', () => {
    const option = legendOption(legendLayout(['A', 'B'], 11), '#123456')
    expect(option).toMatchObject({ top: 0, left: 'center', textStyle: { color: '#123456', fontSize: 11 } })
    expect(option.width).toBeGreaterThan(0)
  })
})

const NAMES = [
  'Baseline',
  'Long distribution (1200 km)',
  'Recycled content 50 %',
  'Alternative supplier, rail freight',
  'Bio-based polymer (50 % share)',
  'SCENARIO H: REUSABLE CRATE',
  'Combined best case with renewable electricity'
]

describe('category labels', () => {
  it('break into lines that fit their width in the widest face, at spaces and after hyphens', () => {
    for (const width of [40, 63, 110, 150]) {
      for (const name of NAMES) {
        const { lines } = wrapLabel(name, width, 11, 5)
        for (const line of lines) expect(textWidth(line, 11), `${name} @ ${width}`).toBeLessThanOrEqual(width)
      }
    }
    expect(wrapLabel('Bio-based polymer', 40, 10, 5).lines[0]).toBe('Bio-')
  })

  it('keep words whole while they fit a line, and say when one had to be split', () => {
    const whole = wrapLabel('Alternative supplier, rail freight', 63, 11, 5)
    expect(whole.split).toBe(false)
    expect(whole.lines.join(' ')).toBe('Alternative supplier, rail freight')
    const split = wrapLabel('Polyethylenterephthalat', 40, 12, 5)
    expect(split.split).toBe(true)
    expect(split.lines.join('')).toBe('Polyethylenterephthalat')
  })

  it('keep a sign with the number before it', () => {
    const { lines } = wrapLabel('Recycled content 50 %', 63, 11, 5)
    expect(lines.some((line) => line.trim() === '%')).toBe(false)
    expect(lines.join(' ')).toContain('50 %')
  })

  it('keep a unit with its number at every width that holds the pair, but not any word after a number', () => {
    const names: [string, string][] = [
      ['Long distribution (1200 km)', '(1200 km)'],
      ['Bottle 0.75 L, returnable', '0.75 L,'],
      ['Heat pump 50 kWh per year', '50 kWh']
    ]
    for (const [name, pair] of names) {
      // Narrower than the pair itself, any line breaks inside it; the fitted axis then steps down a size.
      for (let width = Math.ceil(textWidth(pair, 12)); width <= 200; width += 1) {
        const { lines } = wrapLabel(name, width, 12, 6)
        expect(
          lines.some((line) => line.includes(pair)),
          `${name} @ ${width}`
        ).toBe(true)
      }
    }
    // A year is a number too, but what follows it is not a unit: it may go to the next line.
    const width = Math.ceil(textWidth('Grid mix 2030', 12))
    expect(wrapLabel('Grid mix 2030 and beyond', width, 12, 5).lines).toEqual(['Grid mix 2030', 'and beyond'])
  })

  it('end in an ellipsis past the last line allowed, still within the width', () => {
    const w = wrapLabel('Combined best case with renewable electricity', 50, 10, 3)
    expect(w.cut).toBe(true)
    expect(w.lines).toHaveLength(3)
    expect(w.lines[2].endsWith('…')).toBe(true)
    expect(textWidth(w.lines[2], 10)).toBeLessThanOrEqual(50)
    expect(ellipsize('short', 100, 10)).toBe('short')
  })

  it('take the largest size at which no word is split, one size for all of them', () => {
    // At 12 px "Alternative" is wider than 63; at 11 it fits.
    const fit = fitLabels(NAMES, 63, [12, 11, 10], 5)
    expect(fit.fontSize).toBe(11)
    expect(fit.split || fit.cut).toBe(false)
    expect(fit.text).toHaveLength(NAMES.length)
    expect(fit.width).toBeLessThanOrEqual(63)
    expect(fit.lines).toBe(Math.max(...fit.text.map((t) => t.split('\n').length)))
    // Nothing fits a column a word wide: the smallest size, and the split said so.
    expect(fitLabels(['Polyethylenterephthalat'], 30, [12, 10], 5)).toMatchObject({
      fontSize: 10,
      split: true
    })
  })
})
