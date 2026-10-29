import { describe, expect, it, vi } from 'vitest'

// The drawing is not the subject here — the keys are, and which drawing each key carries. Every chart
// "draws" as its own series data, so a key that carried another indicator's drawing shows up as other
// numbers, and the test runs in plain node without echarts or a DOM.
vi.mock('../charts/reportFigures', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../charts/reportFigures')>()),
  chartSvg: (option: { series?: unknown }) => `<svg>${JSON.stringify(option.series)}</svg>`
}))
vi.mock('../../views/PalettePicker', () => ({
  paletteColors: async () => ({ accent: '#000000', deep: '#000000', paper: '#ffffff' })
}))

import {
  chartKey,
  figuresFromSnapshot,
  indicatorIdentity,
  keyPart,
  sectionChartKey,
  type SourcesSnapshot
} from './figures'

/**
 * A chart is keyed by what it shows. Named by position, `contribution-1`
 * was whichever indicator stood second in the method list, and a data refresh after the list changed put
 * another indicator's chart under the old caption. These pin the renderer's half of the contract — the
 * backend rebuilds the same strings in report_model (backend/tests/test_report_bundle.py pins its half).
 */

const GWP = 't / gwp / a'
const ACID = 't / acid / b'
/** Each indicator's own numbers, so its drawing can be recognised wherever it lands. */
const SCORE: Record<string, [number, number]> = { [GWP]: [1.11, 2.22], [ACID]: [55.5, 66.6] }

function snapshot(order: string[]): SourcesSnapshot {
  const result = (label: string) => ({
    method: label.split(' / '),
    method_label: label,
    unit: 'kg',
    score: SCORE[label][0]
  })
  const group = (label: string, variant: number) => [
    { key: 'DE', label: 'DE', impact: SCORE[label][variant], share: 1 }
  ]
  const view = (label: string, index: number) => ({
    index,
    method_label: label,
    unit: 'kg',
    groups: group(label, 0),
    subjects: [
      { label: 'A', groups: group(label, 0) },
      { label: 'B', groups: group(label, 1) }
    ]
  })
  return {
    data: {
      results: order.map(result),
      subjects: [
        { label: 'A', results: order.map((l) => ({ method_label: l, score: SCORE[l][0] })) },
        { label: 'B', results: order.map((l) => ({ method_label: l, score: SCORE[l][1] })) }
      ],
      contributions: order.map(view),
      ...({
        hotspots: [{ name: 'steel', direct: 1 }],
        breakdown_dimensions: ['geo', 'tag:phase'],
        contributions_by_dimension: { geo: order.map(view), 'tag:phase': order.map(view) }
      } as object)
    } as SourcesSnapshot['data'],
    sections: [
      { id: 'l', kind: 'lcia' },
      { id: 'c', kind: 'contribution' },
      { id: 's', kind: 'summary' },
      {
        id: 'p',
        kind: 'prose',
        figures: [{ kind: 'bar', source: 'hotspots', value: 'direct', label: 'name' }]
      }
    ]
  }
}

/** The per-indicator keys and, for each, the method whose numbers its drawing carries. */
function owners(figures: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, svg] of Object.entries(figures)) {
    if (!/^(lcia|contribution[a-z-]*):/.test(key)) continue
    const hits = Object.keys(SCORE).filter((m) => SCORE[m].some((v) => svg.includes(String(v))))
    expect(hits, key).toHaveLength(1)
    out[key] = hits[0]
  }
  return out
}

describe('report chart keys', () => {
  it('name the method path, never the position', async () => {
    const { figures } = await figuresFromSnapshot(snapshot([GWP, ACID]), new Map())
    const keys = Object.keys(figures)
    expect(keys).toContain(chartKey('lcia', ACID))
    expect(keys).toContain(chartKey('contribution-grouped', indicatorIdentity('geo', ACID)))
    expect(keys).toContain(chartKey('contribution-grouped', indicatorIdentity('tag:phase', ACID)))
    expect(keys).toContain(chartKey('summary', GWP))
    expect(keys).toContain(
      sectionChartKey('p', 0, { kind: 'bar', source: 'hotspots', value: 'direct', label: 'name' }, GWP, 'geo')
    )
    // Nothing positional survives: every key names its content, except the three report-wide charts.
    expect(keys.filter((k) => !k.includes(':') && !['heatmap', 'radar', 'system-model'].includes(k))).toEqual(
      []
    )
  })

  it('carry each indicator’s own drawing, whatever order the method list has', async () => {
    const one = (await figuresFromSnapshot(snapshot([GWP, ACID]), new Map())).figures
    const two = (await figuresFromSnapshot(snapshot([ACID, GWP]), new Map())).figures
    // Every per-indicator key carries the numbers of the indicator it names …
    const own = owners(one)
    for (const [key, method] of Object.entries(own)) expect(key.endsWith(keyPart(method)), key).toBe(true)
    // … and after the reorder the same keys carry the same drawings.
    expect(owners(two)).toEqual(own)
    for (const key of Object.keys(own)) expect(two[key], key).toBe(one[key])
    // Only what follows the LEAD indicator moves with it — by name, not by number.
    expect(Object.keys(two)).toContain(chartKey('summary', ACID))
    expect(Object.keys(two)).not.toContain(chartKey('summary', GWP))
  })

  it('are the strings the backend rebuilds', () => {
    // report_model.indicator_identity / chart_key / section_chart_key, verbatim
    // (backend/tests/test_report_bundle.py::test_the_chart_keys_are_the_strings_the_renderer_builds).
    expect(chartKey('contribution', indicatorIdentity('geo', GWP))).toBe('contribution:geo|t / gwp / a')
    expect(sectionChartKey('p', 2, { kind: 'bar', source: 'subjects', value: '' }, GWP)).toBe(
      'section:p/2|bar|subjects|||15|h|||t / gwp / a'
    )
    expect(
      sectionChartKey(
        'p',
        null,
        { kind: 'bar', source: 'contribution.groups', value: 'impact', label: 'key', stacked: true },
        GWP,
        'tag:phase'
      )
    ).toBe('section:p/single|bar|contribution.groups|key|impact|15|h|stacked|tag:phase|t / gwp / a')
    expect(sectionChartKey('p', null, { kind: 'heatmap' }, GWP)).toBe('section:p/single|heatmap')
  })

  it('tell apart what draws differently', () => {
    const spec = { kind: 'bar', source: 'contribution.groups', value: 'impact', label: 'key' }
    const base = sectionChartKey('p', 0, spec, GWP, 'geo')
    // The dimension the groups are split by, and every setting that changes the drawing.
    expect(sectionChartKey('p', 0, spec, GWP, 'tag:phase')).not.toBe(base)
    expect(sectionChartKey('p', 0, { ...spec, stacked: true }, GWP, 'geo')).not.toBe(base)
    expect(sectionChartKey('p', 0, { ...spec, horizontal: false }, GWP, 'geo')).not.toBe(base)
    expect(sectionChartKey('p', 0, { ...spec, rows: 30 }, GWP, 'geo')).not.toBe(base)
    expect(sectionChartKey('p', 0, { ...spec, value: 'share_percent' }, GWP, 'geo')).not.toBe(base)
    // …but an absent setting and its default are one figure.
    expect(sectionChartKey('p', 0, { ...spec, rows: 15, horizontal: true }, GWP, 'geo')).toBe(base)
    // The dimension counts only where the groups are drawn.
    const hot = { kind: 'bar', source: 'hotspots', value: 'direct', label: 'name' }
    expect(sectionChartKey('p', 0, hot, GWP, 'geo')).toBe(sectionChartKey('p', 0, hot, GWP, 'tag:phase'))
  })

  it('cannot be aliased through their delimiters', () => {
    expect(indicatorIdentity('tag:a|b', 'c')).not.toBe(indicatorIdentity('tag:a', 'b|c'))
    // Chapter `p`, figure 0 against chapter `p/0`'s single figure.
    expect(sectionChartKey('p', 0, { kind: 'heatmap' }, '')).not.toBe(
      sectionChartKey('p/0', null, { kind: 'heatmap' }, '')
    )
    expect(keyPart('50%|a/b', true)).toBe('50%25%7Ca%2Fb')
  })
})
