import { describe, expect, it } from 'vitest'

import { figureInk } from '../reportColors'
import {
  barOption,
  groupedContributionOption,
  heatmapOption,
  normalised,
  phasesOf,
  radarOption,
  rowChartHeight,
  stackedContributionOption
} from './reportFigures'

/**
 * The report figure options, frozen.
 *
 * These builders draw what lands in a delivered PDF, so a change to any option object is a visible
 * change to somebody's report. The snapshots pin every serialisable field on representative data
 * (two variants, three phases, dark and light ink, English and German); the formatter functions —
 * which JSON cannot carry — are exercised separately below, because they ARE the report's number
 * face (V187: a German PDF whose table read "41,3" while its chart read "48.5").
 *
 * If one of these snapshots fails, that is not a broken test — it is a changed report. Update it
 * only when the change to the printed figure is the intent.
 */

const SUBJECTS = [
  {
    label: 'Baseline',
    groups: [
      { key: 'production', label: 'Production', impact: 3.2 },
      { key: 'transport', label: 'Transport', impact: 0.8 },
      { key: 'eol', label: 'End of life', impact: -0.4 }
    ],
    results: [
      { method_label: 'climate change', score: 3.6 },
      { method_label: 'water use', score: 0.02 }
    ]
  },
  {
    label: 'Long distribution (1200 km)',
    groups: [
      { key: 'production', label: 'Production', impact: 3.2 },
      { key: 'transport', label: 'Transport', impact: 1.9 },
      { key: 'eol', label: 'End of life', impact: -0.4 }
    ],
    results: [
      { method_label: 'climate change', score: 4.7 },
      { method_label: 'water use', score: 0.015 }
    ]
  }
]
const INDICATORS = ['climate change', 'water use']
const SHORT = ['Climate', 'Water']
const FONTS = { body: 'IBM Plex Sans', mono: 'IBM Plex Mono' }

/** Serialise an option with functions marked, so a dropped or added formatter still fails the pin. */
function pinnable(option: unknown): string {
  return JSON.stringify(option, (_k, v) => (typeof v === 'function' ? '[function]' : v), 2)
}

describe('the pinned report figure options', () => {
  it('bar, horizontal and vertical, light and dark', () => {
    expect(
      pinnable(
        barOption(
          ['Production', 'Transport'],
          [3.2, 0.8],
          'kg CO2-Eq',
          undefined,
          true,
          figureInk(false),
          FONTS,
          'de'
        )
      )
    ).toMatchSnapshot()
    expect(
      pinnable(
        barOption(
          ['Production', 'Transport'],
          [3.2, 0.8],
          'kg CO2-Eq',
          undefined,
          false,
          figureInk(true),
          FONTS,
          'en'
        )
      )
    ).toMatchSnapshot()
  })

  it('grouped and stacked contribution, with the credit segment below the axis', () => {
    expect(
      pinnable(groupedContributionOption(SUBJECTS, 'kg CO2-Eq', undefined, figureInk(false), FONTS, 'de'))
    ).toMatchSnapshot()
    expect(
      pinnable(
        stackedContributionOption(
          SUBJECTS,
          'kg CO2-Eq',
          undefined,
          true,
          false,
          figureInk(false),
          FONTS,
          'de'
        )
      )
    ).toMatchSnapshot()
    expect(
      pinnable(
        stackedContributionOption(SUBJECTS, 'kg CO2-Eq', undefined, false, true, figureInk(true), FONTS, 'en')
      )
    ).toMatchSnapshot()
  })

  it('radar and heatmap over subjects × indicators', () => {
    expect(
      pinnable(radarOption(SUBJECTS, INDICATORS, SHORT, undefined, figureInk(false), FONTS))
    ).toMatchSnapshot()
    expect(
      pinnable(heatmapOption(SUBJECTS, INDICATORS, SHORT, undefined, figureInk(false), FONTS, 'de'))
    ).toMatchSnapshot()
  })
})

describe('the formatters the snapshots cannot carry', () => {
  it('bar value labels and axis ticks are set in the REPORT language (V187)', () => {
    const de = barOption(['a'], [41.3], 'kg', undefined, true, figureInk(false), FONTS, 'de')
    const series = (de.series as Array<{ label: { formatter: (p: unknown) => string } }>)[0]
    expect(series.label.formatter({ value: 41.3 })).toBe('41,3')
    const value = de.xAxis as { axisLabel: { formatter: (v: number) => string } }
    expect(value.axisLabel.formatter(0.5)).toBe('0,5')
    const en = barOption(['a'], [41.3], 'kg', undefined, true, figureInk(false), FONTS, 'en')
    const enSeries = (en.series as Array<{ label: { formatter: (p: unknown) => string } }>)[0]
    expect(enSeries.label.formatter({ value: 41.3 })).toBe('41.3')
  })

  it('the grouped chart bolds exactly the total column, under its localised name', () => {
    const de = groupedContributionOption(SUBJECTS, 'kg', undefined, figureInk(false), FONTS, 'de')
    const axis = de.xAxis as { data: string[]; axisLabel: { formatter: (v: string) => string } }
    expect(axis.data[axis.data.length - 1]).toBe('Gesamt')
    expect(axis.axisLabel.formatter('Gesamt')).toBe('{t|Gesamt}')
    expect(axis.axisLabel.formatter('Production')).toBe('Production')
  })

  it('heatmap cells localise the share and keep the space before the percent sign', () => {
    const de = heatmapOption(SUBJECTS, INDICATORS, SHORT, undefined, figureInk(false), FONTS, 'de')
    const series = (de.series as Array<{ label: { formatter: (p: unknown) => string } }>)[0]
    expect(series.label.formatter({ value: [0, 0, 76.6] })).toBe('76,6 %')
  })

  it('a credit on the radar sits inside the zero ring, not on the opposite axis', () => {
    // Axes from 0 to 100 gave a negative value a negative radius, drawn through the centre onto the
    // axis across: +1 everywhere and −1 everywhere made the same square.
    const credit = [
      { label: 'A', results: INDICATORS.map((label) => ({ method_label: label, score: 1 })) },
      { label: 'B', results: INDICATORS.map((label) => ({ method_label: label, score: -1 })) }
    ]
    const opt = radarOption(credit, INDICATORS, SHORT, undefined, figureInk(false), FONTS)
    const axes = (opt.radar as { indicator: { min: number; max: number }[] }).indicator
    expect(axes.every((a) => a.min === -100 && a.max === 100)).toBe(true)
    const positive = radarOption(SUBJECTS, INDICATORS, SHORT, undefined, figureInk(false), FONTS)
    expect((positive.radar as { indicator: { min?: number }[] }).indicator[0].min).toBeUndefined()
  })

  it('the shared maths: percent-of-max rows and label-aware row heights', () => {
    const { labels, rows } = normalised(SUBJECTS, INDICATORS)
    expect(labels).toEqual(['Baseline', 'Long distribution (1200 km)'])
    expect(rows[1][0]).toBe(100) // the worse variant defines 100 % of climate change
    expect(rows[0][1]).toBe(100) // …and the baseline of water use
    expect(phasesOf(SUBJECTS).map((p) => p.key)).toEqual(['production', 'transport', 'eol'])
    // Enough rows that the per-row line height clears the 220px floor a single row sits on.
    const long = Array(6).fill('x'.repeat(60))
    const short = Array(6).fill('short')
    expect(rowChartHeight(long)).toBeGreaterThan(rowChartHeight(short))
  })
})
