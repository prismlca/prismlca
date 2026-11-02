import { cssVar } from '../../lib/cssVar'
import { useEChart, type ChartRegistry } from '../../lib/charts/useEChart'
import { escapeHtml, tooltipBeside } from '../../lib/charts/tooltip'
import { fmtValue } from './helpers'
import type { CurveResult } from './types'

/**
 * The parameter curve: the result (y) against the parameter (x), one line per variant, with the computed
 * points marked — the curve is only known there — and each variant's own value as a large dot on its line.
 * Lines are named at their right end; the card carries the legend in HTML.
 */
export function CurveChart({
  regId,
  registry,
  themeKey,
  result,
  paramUnit,
  colors
}: {
  regId: string
  registry: ChartRegistry
  themeKey: string
  result: CurveResult
  paramUnit: string
  colors: string[]
}): JSX.Element {
  const ref = useEChart(
    regId,
    registry,
    (el) => {
      const ink = cssVar('--ink', '#26313a')
      const faint = cssVar('--faint', '#8b968f')
      const border = cssVar('--border', '#e0e4dd')
      const surface = cssVar('--surface', '#ffffff')
      const xName = `${result.param}${paramUnit ? ` [${paramUnit}]` : ''}`
      const allPositive = result.curves.every((c) => c.scores.every((s) => s >= 0) && c.origin.score >= 0)
      const short = (name: string): string => (name.length > 24 ? `${name.slice(0, 23)}…` : name)
      return {
        animation: false,
        grid: { left: 8, right: 150, top: 14, bottom: 36, containLabel: true },
        tooltip: {
          trigger: 'axis',
          ...tooltipBeside(el),
          formatter: (params: { seriesType: string; seriesIndex: number; value: number[] }[]) => {
            const lines = params.filter((p) => p.seriesType === 'line')
            if (!lines.length) return ''
            const x = lines[0].value[0]
            return (
              `<b>${escapeHtml(result.param)} = ${fmtValue(x)}${paramUnit ? ` ${escapeHtml(paramUnit)}` : ''}</b><table>` +
              lines
                .map((p) => {
                  const c = result.curves[p.seriesIndex / 2]
                  return `<tr><td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:${colors[p.seriesIndex / 2]}"></span>${escapeHtml(c.name)}</td><td style="padding-left:12px">${fmtValue(p.value[1])} ${escapeHtml(result.unit)}</td></tr>`
                })
                .join('') +
              '</table>'
            )
          }
        },
        xAxis: {
          type: 'value',
          name: xName,
          nameLocation: 'middle',
          nameGap: 26,
          nameTextStyle: { color: faint, fontSize: 11 },
          min: 'dataMin',
          max: 'dataMax',
          axisLabel: { color: faint, formatter: (v: number) => fmtValue(v) },
          splitLine: { lineStyle: { type: 'dashed', color: border } }
        },
        yAxis: {
          type: 'value',
          scale: !allPositive,
          axisLabel: { color: faint, formatter: (v: number) => fmtValue(v) },
          splitLine: { lineStyle: { type: 'dashed', color: border } }
        },
        // Two series per variant, in this order: the line (index 2i) and its own value (2i + 1).
        series: result.curves.flatMap((c, i) => [
          {
            type: 'line',
            name: c.name,
            data: result.values.map((x, k) => [x, c.scores[k]]),
            symbol: 'circle',
            symbolSize: 5,
            lineStyle: { width: 2, color: colors[i] },
            itemStyle: { color: colors[i] },
            endLabel: { show: true, formatter: () => short(c.name), color: ink, fontSize: 11 },
            labelLayout: { moveOverlap: 'shiftY' },
            z: 2
          },
          {
            type: 'scatter',
            name: `${c.name} — own value`,
            data: [[c.origin.value, c.origin.score]],
            symbolSize: 13,
            itemStyle: { color: colors[i], borderColor: surface, borderWidth: 2 },
            tooltip: { show: false },
            z: 3
          }
        ])
      }
    },
    [result, paramUnit, colors.join(','), themeKey]
  )
  return <div ref={ref} className="sens-curve-canvas" />
}
