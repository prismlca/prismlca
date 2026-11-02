import { describe, expect, it } from 'vitest'
import { tornadoHeight, tornadoOption, type TornadoBlock } from './reportTornado'

const block: TornadoBlock = {
  method_label: 't / gwp',
  relative: true,
  parameters: [
    {
      name: 'return_rate',
      low_change: -13.3,
      high_change: 1.2,
      low_text: '-13,3 %',
      high_text: '+1,2 %',
      limited: true,
      breaks: false
    },
    {
      name: 'mass',
      low_change: -8,
      high_change: -2,
      low_text: '-8 %',
      high_text: '-2 %',
      limited: false,
      breaks: true
    }
  ],
  labels: { low: 'Parameter −10 %', high: 'Parameter +10 %', axis: 'Änderung des Ergebnisses' }
}

type Bar = { value: number; label: { show: boolean; formatter: () => string } }

describe('the report tornado', () => {
  const option = tornadoOption(block, undefined, undefined, undefined, 'de') as {
    yAxis: { data: string[] }
    xAxis: { name: string }
    series: { name?: string; data: Bar[] }[]
  }

  it('marks a step its rule stopped (*) and one that broke another rule (!) beside the name', () => {
    expect(option.yAxis.data).toEqual(['return_rate*', 'mass!'])
    expect(option.xAxis.name).toBe('Änderung des Ergebnisses')
  })

  it('prints every change, both on the longer bar when the two point the same way', () => {
    const [back, front] = option.series
    expect(back.data[0].label.formatter()).toBe('-13,3 %')
    expect(front.data[0].label.formatter()).toBe('+1,2 %')
    expect(back.data[1].label.formatter()).toBe('-8 % / -2 %')
    expect(front.data[1].label.show).toBe(false)
  })

  it('names the two sides in the legend, in the report language', () => {
    expect(option.series.slice(2).map((s) => s.name)).toEqual(['Parameter −10 %', 'Parameter +10 %'])
    expect(tornadoHeight(block)).toBeGreaterThan(2 * 28)
  })
})
