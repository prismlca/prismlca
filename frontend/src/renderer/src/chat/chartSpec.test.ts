import { describe, expect, it } from 'vitest'
import { CHART_LIMITS, chartText, readChart, type BarSpec, type PieSpec } from './chartSpec'
import { laidOut } from './chartOption'

const bar = (o: unknown): BarSpec => {
  const r = readChart(JSON.stringify(o))
  if (!r.ok || r.spec.kind !== 'bar') throw new Error(r.ok ? 'not a bar chart' : r.reason)
  return r.spec
}
const reason = (src: string): string => {
  const r = readChart(src)
  if (r.ok) throw new Error('was read')
  return r.reason
}

describe('readChart', () => {
  it('reads a bar chart as a model writes it at the end of a modelling task', () => {
    // The block gemini-3.7-flash wrote under the chart rule, axis types left out.
    const spec = bar({
      title: { text: 'Carbon footprint', subtext: '1 kg frame (IPCC 2021 GWP100)' },
      xAxis: { data: ['Ingot', 'Extrusion', 'Welding', 'EoL credit'] },
      yAxis: { name: 'kg CO2-eq' },
      series: [{ type: 'bar', name: 'Climate change', data: [16.1, 1.9, 0.9, -5.7] }]
    })
    expect(spec).toEqual({
      kind: 'bar',
      title: 'Carbon footprint',
      subtitle: '1 kg frame (IPCC 2021 GWP100)',
      horizontal: false,
      categories: ['Ingot', 'Extrusion', 'Welding', 'EoL credit'],
      valueName: 'kg CO2-eq',
      categoryName: '',
      series: [{ name: 'Climate change', values: [16.1, 1.9, 0.9, -5.7] }]
    })
  })

  it('turns bars sideways when the categories sit on the y axis', () => {
    const spec = bar({
      xAxis: { type: 'value', name: 'kg CO2-eq' },
      yAxis: { type: 'category', data: ['A', 'B'] },
      series: [{ type: 'bar', data: [1, 2] }]
    })
    expect(spec.horizontal).toBe(true)
    expect(spec.valueName).toBe('kg CO2-eq')
    expect(spec.categories).toEqual(['A', 'B'])
    // Only y naming categories says it too.
    expect(bar({ yAxis: { data: ['A'] }, series: [{ type: 'bar', data: [1] }] }).horizontal).toBe(true)
    // Making x the value axis says the same without a word about y.
    expect(
      bar({ xAxis: { type: 'value' }, yAxis: { data: ['A'] }, series: [{ type: 'bar', data: [1] }] })
        .horizontal
    ).toBe(true)
  })

  it('names categories after the data items when the axis has none, and keeps stacks', () => {
    const spec = bar({
      series: [
        {
          type: 'bar',
          name: 'Use',
          stack: 'total',
          data: [
            { name: 'Glass', value: 2 },
            { name: 'PET', value: '1.5' }
          ]
        },
        { type: 'bar', name: 'EoL', stack: 'total', data: [-0.4, '-'] }
      ]
    })
    expect(spec.categories).toEqual(['Glass', 'PET'])
    expect(spec.series).toEqual([
      { name: 'Use', stack: 'total', values: [2, 1.5] },
      { name: 'EoL', stack: 'total', values: [-0.4, null] }
    ])
  })

  it('gives unnamed series of a multi-series chart a name, and pads short ones with gaps', () => {
    const spec = bar({
      xAxis: { data: ['a', 'b', 'c'] },
      series: [
        { type: 'bar', data: [1] },
        { type: 'bar', data: [1, 2, 3] }
      ]
    })
    expect(spec.series.map((s) => s.name)).toEqual(['Series 1', 'Series 2'])
    expect(spec.series[0].values).toEqual([1, null, null])
  })

  it('reads a pie chart', () => {
    const r = readChart(
      JSON.stringify({
        title: [{ text: 'Shares' }],
        series: [
          {
            type: 'pie',
            name: 'GWP',
            data: [
              { name: 'Steel', value: 3 },
              { name: 'Glass', value: 1 },
              { name: 'Gap', value: null }
            ]
          }
        ]
      })
    )
    expect(r).toEqual({
      ok: true,
      spec: {
        kind: 'pie',
        title: 'Shares',
        subtitle: '',
        name: 'GWP',
        slices: [
          { name: 'Steel', value: 3 },
          { name: 'Glass', value: 1 }
        ]
      } satisfies PieSpec
    })
  })

  it('draws a pie with a credit as bars, and says so', () => {
    const r = readChart(
      JSON.stringify({
        series: [
          {
            type: 'pie',
            data: [
              { name: 'Burden', value: 5 },
              { name: 'Credit', value: -2 }
            ]
          }
        ]
      })
    )
    expect(r.ok && r.note).toMatch(/negative values/)
    expect(r.ok && r.spec).toMatchObject({
      kind: 'bar',
      horizontal: true,
      categories: ['Burden', 'Credit'],
      series: [{ values: [5, -2] }]
    })
  })

  it('reads only what a chart needs — links, images, markup, formatters and actions never reach the spec', () => {
    const hostile = {
      title: { text: 'T', link: 'https://evil.example/?d=secret', target: 'blank' },
      backgroundColor: { image: 'https://evil.example/pixel.png' },
      tooltip: { formatter: '<img src=x onerror="alert(1)">', renderMode: 'html' },
      toolbox: { feature: { dataView: {}, saveAsImage: {} } },
      graphic: [{ type: 'image', style: { image: 'https://evil.example/a.png' } }],
      aria: { enabled: true, label: { description: '<script>' } },
      xAxis: {
        data: ['a'],
        axisLabel: { formatter: '{value}<b>', rich: { x: { backgroundColor: { image: 'http://x' } } } }
      },
      series: [
        {
          type: 'bar',
          name: 'S',
          data: [
            {
              value: 1,
              symbol: 'image://https://evil.example/s.png',
              itemStyle: { color: { image: 'http://x' } }
            }
          ],
          label: { show: true, formatter: '<i>' },
          markPoint: { data: [{ type: 'max' }] }
        }
      ]
    }
    const r = readChart(JSON.stringify(hostile))
    expect(r.ok).toBe(true)
    const text = JSON.stringify(r)
    expect(text).not.toMatch(/evil|http|image|formatter|<|script|link|toolbox|graphic|markPoint/)
  })

  it('refuses what it cannot draw, with a reason in plain words', () => {
    expect(reason('{"series": [')).toMatch(/not valid JSON/)
    expect(reason('[1, 2]')).toMatch(/not a chart option/)
    expect(reason('{"title": {"text": "x"}}')).toMatch(/no series/)
    expect(reason('{"series": [{"type": "line", "data": [1]}]}')).toMatch(/only bar and pie.*"line"/)
    expect(reason('{"series": [{"data": [1]}]}')).toMatch(/needs "type"/)
    expect(
      reason(
        '{"xAxis": {"data": ["a"]}, "series": [{"type": "bar", "data": [1]}, {"type": "pie", "data": []}]}'
      )
    ).toMatch(/mixes bar and pie/)
    expect(reason('{"series": [{"type": "bar", "data": [1, 2]}]}')).toMatch(/category names in xAxis\.data/)
    expect(
      reason('{"xAxis": {"data": ["a"]}, "series": [{"type": "bar", "name": "S", "data": [1, 2]}]}')
    ).toMatch(/"S" has 2 values for 1 categories/)
    expect(reason('{"xAxis": {"data": ["a"]}, "series": [{"type": "bar", "data": ["1e400"]}]}')).toMatch(
      /not a number/
    )
    expect(reason('{"xAxis": {"data": ["a"]}, "series": [{"type": "bar", "data": ["12 kg"]}]}')).toMatch(
      /not a number/
    )
    expect(reason('{"xAxis": {"data": ["a"]}, "series": [{"type": "bar", "data": [null]}]}')).toMatch(
      /no numbers/
    )
    expect(reason('{"series": [{"type": "pie", "data": [1]}, {"type": "pie", "data": [1]}]}')).toMatch(
      /one series/
    )
    expect(reason('{"series": [{"type": "pie", "data": [{"value": 1}]}]}')).toMatch(
      /"name" and a numeric "value"/
    )
  })

  it('keeps to its limits', () => {
    const n = CHART_LIMITS.categories + 1
    const many = {
      xAxis: { data: Array.from({ length: n }, (_, i) => `c${i}`) },
      series: [{ type: 'bar', data: [] }]
    }
    expect(reason(JSON.stringify(many))).toMatch(/too many to draw/)
    const series = Array.from({ length: CHART_LIMITS.series + 1 }, () => ({ type: 'bar', data: [1] }))
    expect(reason(JSON.stringify({ xAxis: { data: ['a'] }, series }))).toMatch(/series are too many/)
    const slices = Array.from({ length: CHART_LIMITS.slices + 1 }, (_, i) => ({ name: `s${i}`, value: 1 }))
    expect(reason(JSON.stringify({ series: [{ type: 'pie', data: slices }] }))).toMatch(/slices are too many/)
    expect(reason(' '.repeat(CHART_LIMITS.sourceChars + 1))).toMatch(/too long/)
  })
})

describe('chartText', () => {
  it('prints a name on one line, without control or bidi characters, cut to its length', () => {
    expect(chartText('a\nb\tc\u202Eevil\u0000', 80)).toBe('a b c evil')
    expect(chartText('abcdefghij', 5)).toBe('abcd…')
    expect(chartText(2030, 10)).toBe('2030')
    expect(chartText({ toString: () => 'x' }, 10)).toBe('')
    expect(chartText(Infinity, 10)).toBe('')
  })
})

describe('laidOut', () => {
  const upright = (categories: string[]): BarSpec => ({
    kind: 'bar',
    title: '',
    subtitle: '',
    horizontal: false,
    categories,
    valueName: '',
    categoryName: '',
    series: [{ name: '', values: categories.map(() => 1) }]
  })
  it('turns bars with long category names sideways and leaves short ones upright', () => {
    const names = ['Aluminium, primary', 'Tube extrusion', 'Welding', 'Transport']
    expect(laidOut(upright(names))).toMatchObject({ horizontal: true })
    expect(laidOut(upright(['2020', '2025', '2030', '2035', '2040']))).toMatchObject({ horizontal: false })
    expect(laidOut(upright(['Glass bottle', 'PET bottle']))).toMatchObject({ horizontal: false })
    expect(laidOut(upright(['Glass bottle, returnable, 20 trips', 'PET bottle']))).toMatchObject({
      horizontal: true
    })
  })
})
