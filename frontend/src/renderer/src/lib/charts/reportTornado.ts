import type * as echarts from 'echarts'
import { reportAxisTick } from '../numberFormat'
import { PRISM_PALETTE, figureInk, type FigureInk, type ReportPalette } from '../reportColors'
import { legendLayout, legendOption, plotTop } from './figureText'
import { figureFont, type FigureFonts } from './reportFigures'

/** One indicator's tornado as the snapshot carries it — `checks.tornado[i]` (engine/report_tornado.py). */
export interface TornadoBlock {
  method_label: string
  relative: boolean
  parameters: {
    name: string
    low_change: number
    high_change: number
    low_text: string
    high_text: string
    limited: boolean
    breaks: boolean
  }[]
  /** The figure's words in the report's language: the two legend entries and the axis. */
  labels: { low: string; high: string; axis: string }
}

const LEGEND_SIZE = 10
/** One row of the chart: the bar and the parameter's name beside it. */
const ROW = 28

/** Height for a tornado of `rows` parameters, legend and axis included. */
export function tornadoHeight(block: TornadoBlock): number {
  const legend = legendLayout([block.labels.low, block.labels.high], LEGEND_SIZE)
  return plotTop(legend, false) + block.parameters.length * ROW + 44
}

/**
 * The report's tornado: one row per parameter, largest effect on top, its two bars running from the result
 * (0) to where the result moves when the parameter goes down (deep tone) and up (accent).
 *
 * The same picture as the Sensitivity analysis tab's, drawn for paper: every bar is labelled with its change
 * (a printed page has no tooltip), the marks * and ! follow the parameter's name exactly as the notes under
 * the figure explain them, and every number is in the report's language. As in the tab, the two bars of a row
 * share one slot, and when both move the result the same way the longer is drawn behind the shorter — which
 * is why each bar carries its own colour and the legend is made of two empty series that only name them.
 */
export function tornadoOption(
  block: TornadoBlock,
  pal: ReportPalette = PRISM_PALETTE,
  theme: FigureInk = figureInk(false),
  fonts?: FigureFonts,
  /** The REPORT's language, never the app's. */
  lang = 'en'
): echarts.EChartsOption {
  const colour = { low: pal.deep, high: pal.accent }
  const legend = legendLayout([block.labels.low, block.labels.high], LEGEND_SIZE)
  const bars = block.parameters.map((p) => {
    const low = { side: 'low' as const, v: p.low_change, text: p.low_text }
    const high = { side: 'high' as const, v: p.high_change, text: p.high_text }
    return Math.abs(low.v) >= Math.abs(high.v) ? [low, high] : [high, low]
  })
  const item = (b: (typeof bars)[number][number], front: boolean, row: number) => {
    // Both sides moving the result the same way: the shorter bar lies on the longer one, so the longer one's
    // end carries both changes, lowered first as in the legend, and the shorter one prints nothing.
    const same = Math.sign(bars[row][0].v) === Math.sign(bars[row][1].v) && b.v !== 0
    const p = block.parameters[row]
    return {
      value: b.v,
      itemStyle: { color: colour[b.side] },
      label: {
        show: b.v !== 0 && !(front && same),
        position: b.v < 0 ? ('left' as const) : ('right' as const),
        formatter: () => (same ? `${p.low_text} / ${p.high_text}` : b.text),
        color: theme.axis,
        fontSize: 9,
        textBorderWidth: 0
      }
    }
  }
  const pad = (v: { min: number; max: number }): number =>
    (Math.max(v.max, 0) - Math.min(v.min, 0)) * 0.3 || 1
  return {
    animation: false,
    textStyle: { fontFamily: figureFont(fonts), color: theme.ink, fontSize: 11 },
    legend: legendOption(legend, theme.ink),
    grid: { left: 8, right: 16, top: plotTop(legend, false), bottom: 30, containLabel: true },
    xAxis: {
      type: 'value',
      name: block.labels.axis,
      nameLocation: 'middle',
      nameGap: 22,
      nameTextStyle: { color: theme.axis },
      // Room beyond the longest bar on both sides, for the change printed at its end.
      min: (v: { min: number; max: number }) => Math.min(0, v.min) - pad(v),
      max: (v: { min: number; max: number }) => Math.max(0, v.max) + pad(v),
      axisLabel: {
        color: theme.axis,
        showMinLabel: false,
        showMaxLabel: false,
        formatter: (v: number) => `${v > 0 ? '+' : ''}${reportAxisTick(v, lang)}${block.relative ? ' %' : ''}`
      },
      axisLine: { lineStyle: { color: theme.edge } },
      splitLine: { show: true, lineStyle: { color: theme.grid } }
    },
    yAxis: {
      type: 'category',
      inverse: true,
      data: block.parameters.map((p) => `${p.name}${p.limited ? '*' : ''}${p.breaks ? '!' : ''}`),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: theme.ink, width: 170, overflow: 'truncate' }
    },
    series: [
      {
        type: 'bar',
        data: bars.map((b, i) => item(b[0], false, i)),
        barWidth: 11,
        barGap: '-100%',
        z: 2
      },
      {
        type: 'bar',
        data: bars.map((b, i) => item(b[1], true, i)),
        barWidth: 11,
        z: 3,
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: theme.ink, width: 1, type: 'solid', opacity: 0.7 },
          data: [{ xAxis: 0 }]
        }
      },
      // The legend's two entries: empty series named and coloured like the two sides.
      { type: 'bar', name: block.labels.low, data: [], itemStyle: { color: colour.low } },
      { type: 'bar', name: block.labels.high, data: [], itemStyle: { color: colour.high } }
    ]
  }
}
