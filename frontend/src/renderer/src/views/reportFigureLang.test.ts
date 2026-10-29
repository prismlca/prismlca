import { describe, expect, it } from 'vitest'

import { barOption } from '../lib/charts/reportFigures'

/**
 * A report figure is lettered in the REPORT's language — the app's is a different question.
 *
 * The screen speaks English and always will; a report has a language of its own, and its figures land
 * next to tables the backend set in that language. A German PDF whose table read "41,3" and whose bar
 * chart read "48.5" is what this pins (V187): the language is an argument to the drawing, so the same
 * builder can serve an English screen and a German document in one session.
 */

/** The formatter echarts would call for a bar's value label. */
const barLabel = (option: ReturnType<typeof barOption>): ((p: unknown) => string) => {
  const series = option.series as { label: { formatter: (p: unknown) => string } }[]
  return series[0].label.formatter
}

/** The formatter echarts would call for a tick on the value axis (horizontal bars → x). */
const axisTick = (option: ReturnType<typeof barOption>): ((v: number) => string) => {
  const axis = option.xAxis as { axisLabel: { formatter: (v: number) => string } }
  return axis.axisLabel.formatter
}

const water = [41.3, 37.7, 44.9, 48.5]
const labels = ['Baseline', 'Alu', 'Wood', 'PVC']

describe('a bar label follows the report language', () => {
  it('writes German numbers in a German report', () => {
    const label = barLabel(
      barOption(labels, water, 'm3 world Eq deprived', undefined, true, undefined, undefined, 'de')
    )
    expect(water.map((value) => label({ value }))).toEqual(['41,3', '37,7', '44,9', '48,5'])
  })

  it('writes French numbers in a French report', () => {
    const label = barLabel(barOption(labels, water, 'm3', undefined, true, undefined, undefined, 'fr'))
    expect(label({ value: 48.5 })).toBe('48,5')
  })

  it('keeps English for an English report — and English is what the default is', () => {
    const label = barLabel(barOption(labels, water, 'm3', undefined, true, undefined, undefined, 'en'))
    expect(label({ value: 48.5 })).toBe('48.5')
    // No language handed in: the screen's charts draw through the same helpers, and the app is English.
    // If this ever answered "48,5" it would mean the language had become module state somewhere.
    expect(barLabel(barOption(labels, water, 'm3'))({ value: 48.5 })).toBe('48.5')
  })

  it('writes a tiny score as the tables write it — two mantissa digits, two exponent digits', () => {
    const tiny = [2.27e-6, 1.94e-6, 2.61e-6]
    const label = barLabel(
      barOption(['a', 'b', 'c'], tiny, 'points', undefined, true, undefined, undefined, 'de')
    )
    expect(tiny.map((value) => label({ value }))).toEqual(['2,27e-06', '1,94e-06', '2,61e-06'])
  })
})

describe('an axis tick follows the report language too', () => {
  it('groups a thousands tick in the language of the document', () => {
    expect(
      axisTick(barOption(labels, [1200, 2400], 'MJ', undefined, true, undefined, undefined, 'de'))(1200)
    ).toBe('1.200')
    expect(axisTick(barOption(labels, [1200, 2400], 'MJ'))(1200)).toBe('1,200')
  })

  it('pads the exponent of a tick echarts writes as "5e-7"', () => {
    expect(
      axisTick(barOption(labels, [5e-7], 'CTUh', undefined, true, undefined, undefined, 'de'))(5e-7)
    ).toBe('5e-07')
  })
})
