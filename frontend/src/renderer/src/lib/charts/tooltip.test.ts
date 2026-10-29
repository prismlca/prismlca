import { describe, expect, it } from 'vitest'
import { placeBeside, STACK_TIP_ROWS, stackTooltipHtml, tipValue } from './tooltip'

describe('placeBeside', () => {
  const view = [1600, 900]
  it('puts the tooltip right of and below the mouse when it fits', () => {
    expect(placeBeside([300, 200], [250, 120], view)).toEqual([314, 214])
  })
  it('goes left of the mouse only when the right side has no room', () => {
    expect(placeBeside([1500, 200], [250, 120], view)).toEqual([1236, 214])
  })
  it('never leaves the window — the case that slid under the side bar', () => {
    // Mouse near the left edge, tooltip wider than the room on either side.
    const [x] = placeBeside([180, 200], [1500, 120], view)
    expect(x).toBe(8)
    // Too close to the bottom: above the mouse instead.
    expect(placeBeside([300, 850], [250, 120], view)[1]).toBe(716)
  })
})

describe('stackTooltipHtml', () => {
  const fmt = (v: number): string => `${v} kg`
  const p = (seriesName: string, value: number) => ({
    seriesName,
    value,
    marker: '',
    axisValueLabel: 'Bottle'
  })

  it('lists the non-zero segments, biggest first, and the total', () => {
    const html = stackTooltipHtml([p('small', 1), p('zero', 0), p('big', -5), p('', 0)], fmt)
    expect(html).toContain('Bottle')
    expect(html).not.toContain('zero')
    expect(html.indexOf('big')).toBeLessThan(html.indexOf('small'))
    expect(html).toContain('Total')
    expect(html).toContain('-4 kg')
  })

  it('sums what is past the listed rows and cuts long names', () => {
    const many = Array.from({ length: STACK_TIP_ROWS + 5 }, (_, i) => p(`c${i} ${'x'.repeat(80)}`, i + 1))
    const html = stackTooltipHtml(many, fmt)
    expect(html).toContain('+5 more')
    expect(html).toContain('15 kg') // c0..c4 = 1+2+3+4+5
    expect(html).toContain('…')
    expect(html).not.toContain('x'.repeat(60))
  })

  it('escapes class names', () => {
    expect(stackTooltipHtml([p('<b>A</b>', 1)], fmt)).toContain('&lt;b&gt;A&lt;/b&gt;')
  })
})

describe('tipValue', () => {
  it('gives four significant figures, exponential only at extreme magnitudes', () => {
    expect(tipValue(51.93827462, 'kg CO2-Eq')).toBe('51.94 kg CO2-Eq')
    expect(tipValue(0.16604127, 'mol H+-Eq')).toBe('0.166 mol H+-Eq')
    expect(tipValue(0.000012345678, 'kg P-Eq')).toBe('1.235e-5 kg P-Eq')
    expect(tipValue(924.0001, '')).toBe('924')
  })
})
