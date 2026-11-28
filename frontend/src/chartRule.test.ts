/**
 * The chart rule of the chat prompt (main/ai/systemPrompt.ts) and the chat's reader of chart blocks
 * (renderer chat/chartSpec.ts) describe one contract from two processes: what the model is told to
 * write, and what the chat draws. A kind or a field the rule offers and the reader drops would make
 * models write charts that come out as a page of JSON.
 */
import { describe, expect, it } from 'vitest'
import { CHART_RULE } from './main/ai/systemPrompt'
import { CHART_LIMITS, readChart } from './renderer/src/chat/chartSpec'

describe('the chart rule and the chart reader', () => {
  it('offer the same chart kinds', () => {
    expect([...CHART_RULE.matchAll(/"type": "(\w+)"/g)].map((m) => m[1])).toEqual(['bar', 'pie'])
  })

  it('agree on the fields: a block written from the rule alone is drawn', () => {
    const block = {
      title: { text: 'Footprint', subtext: 'per frame' },
      xAxis: { type: 'category', data: ['Material', 'Credit'] },
      yAxis: { type: 'value', name: 'kg CO2-eq' },
      series: [{ type: 'bar', name: 'GWP100', data: [16.1, -5.7], stack: 'total' }]
    }
    expect(readChart(JSON.stringify(block))).toMatchObject({ ok: true, spec: { valueName: 'kg CO2-eq' } })
    const pie = { series: [{ type: 'pie', name: 'GWP100', data: [{ name: 'Material', value: 16.1 }] }] }
    expect(readChart(JSON.stringify(pie)).ok).toBe(true)
  })

  it('agree on the size of a pie', () => {
    const said = Number(/at most (\d+) slices/.exec(CHART_RULE)?.[1])
    expect(said).toBeGreaterThan(0)
    expect(said).toBeLessThanOrEqual(CHART_LIMITS.slices)
  })
})
