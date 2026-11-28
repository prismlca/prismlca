/**
 * The ECharts option of a chat chart, built from a `ChartSpec` (chartSpec.ts) and nothing else.
 *
 * Every field here is ours: colours from the house palette, type sizes of the Results charts, labels
 * and tooltips through functions of this module. The model's strings reach ECharts only as data —
 * category, series and slice names, the title — and ECharts draws those on the canvas as text. The one
 * place they meet markup is the tooltip, which ECharts renders as HTML; its formatters below encode
 * every name they print.
 */
import * as echarts from 'echarts'
import { cssVar } from '../lib/cssVar'
import { fmtSig } from '../lib/settings'
import { FAMILY_PALETTE, STACK_PALETTE } from '../lib/palette'
import { tooltipBeside } from '../lib/charts/tooltip'
import { catAxisLabel } from '../views/results/chartUtils'
import type { BarSpec, ChartSpec, PieSpec } from './chartSpec'

type SetOptionArg = Parameters<echarts.ECharts['setOption']>[0]

/** Significant figures on the chart (bar labels, axis ticks) and in its tooltip. */
const LABEL_DIGITS = 3
const TIP_DIGITS = 4
/** Bars with a value printed over them, as long as the chart stays readable with it. */
const LABELLED_BARS = 12
/** Characters of a pie slice's name at its label; the tooltip names it in full. */
const SLICE_LABEL_CHARS = 28

/**
 * The chart as the chat lays it out: a bar chart whose category names are long turns sideways.
 *
 * A model writes a bar chart upright by habit, and its categories are process names: six of them under
 * an upright chart in a chat bubble are cut to "Aluminium,…", "Tube extru…" — the one thing a reader
 * needs. Sideways, each name gets a line of its own. Short names (years, phases) stay upright.
 */
export function laidOut(spec: ChartSpec): ChartSpec {
  if (spec.kind !== 'bar' || spec.horizontal) return spec
  const longest = Math.max(...spec.categories.map((c) => c.length))
  const sideways = spec.categories.length >= 4 ? longest > 12 : longest > 24
  return sideways ? { ...spec, horizontal: true } : spec
}

/** The box the chart is drawn in, in pixels — a horizontal bar chart grows with its categories. */
export function chartHeight(spec: ChartSpec): number {
  const head = (spec.title ? 22 : 0) + (spec.subtitle ? 16 : 0)
  if (spec.kind === 'pie') return 260 + head
  const legend = spec.series.length > 1 ? 24 : 0
  if (!spec.horizontal) return 250 + head + legend
  // A group of side-by-side bars needs more room per category than one bar or one stack.
  const stacked = spec.series.every((s) => s.stack && s.stack === spec.series[0].stack)
  const perCategory = stacked ? 26 : Math.min(18 + 10 * spec.series.length, 60)
  return Math.min(Math.max(spec.categories.length * perCategory + 60, 180), 560) + head + legend
}

/** `animate` is false for a chart drawn again — scrolled back into view, or after a theme switch. */
export function chartOption(spec: ChartSpec, el: HTMLElement, animate = true): SetOptionArg {
  const option = spec.kind === 'pie' ? pieOption(spec, el) : barOption(spec, el)
  return { animation: animate, animationDuration: 400, ...option }
}

/** Room right of the title for the chart's "Save as PNG" button, which sits in that corner. */
const BUTTON_ROOM = 40

function titleOf(
  spec: ChartSpec,
  el: HTMLElement,
  ink: string,
  faint: string
): Record<string, unknown> | undefined {
  if (!spec.title && !spec.subtitle) return undefined
  const width = Math.max(120, (el.clientWidth || 400) - BUTTON_ROOM)
  return {
    text: spec.title,
    subtext: spec.subtitle,
    left: 0,
    top: 0,
    itemGap: 4,
    textStyle: { color: ink, fontSize: 13, fontWeight: 600, width, overflow: 'truncate' },
    subtextStyle: { color: faint, fontSize: 11, width, overflow: 'truncate' }
  }
}

interface TipParam {
  seriesName?: string
  name?: string
  value?: unknown
  marker?: unknown
  percent?: number
  axisValueLabel?: string
}

const enc = (s: string): string => echarts.format.encodeHTML(s)
/** ECharts' colour dot; it is made from the series colour, which is ours. */
const markerOf = (p: TipParam): string => (typeof p.marker === 'string' ? p.marker : '')

/** The tooltip of one category: its name, then each series with its value. Every name is encoded. */
export function barTooltip(params: TipParam | TipParam[]): string {
  const list = Array.isArray(params) ? params : [params]
  const head = list[0]?.axisValueLabel ?? list[0]?.name ?? ''
  const rows = list
    .filter((p) => typeof p.value === 'number')
    .map(
      (p) =>
        `<div>${markerOf(p)}${p.seriesName ? `${enc(p.seriesName)}: ` : ''}` +
        `<b>${enc(fmtSig(p.value as number, TIP_DIGITS))}</b></div>`
    )
  return `<div style="font-weight:600;margin-bottom:2px">${enc(head)}</div>${rows.join('')}`
}

/** The tooltip of one pie slice: its name, value and share. Every name is encoded. */
export function pieTooltip(p: TipParam): string {
  const value = typeof p.value === 'number' ? fmtSig(p.value, TIP_DIGITS) : ''
  const share = typeof p.percent === 'number' ? ` (${fmtSig(p.percent, 3)}%)` : ''
  return (
    (p.seriesName ? `<div style="font-weight:600;margin-bottom:2px">${enc(p.seriesName)}</div>` : '') +
    `<div>${markerOf(p)}${enc(p.name ?? '')}: <b>${enc(value + share)}</b></div>`
  )
}

function barOption(spec: BarSpec, el: HTMLElement): SetOptionArg {
  const ink = cssVar('--ink', '#303030')
  const faint = cssVar('--faint', '#8a94a0')
  const grid = cssVar('--border', '#e0e4dd')
  const h = spec.horizontal
  const many = spec.series.length > 1
  const palette = many ? STACK_PALETTE : FAMILY_PALETTE
  const stacked = spec.series.some((s) => s.stack)
  const labelled = !many && spec.categories.length <= LABELLED_BARS
  const titleRoom = (spec.title ? 22 : 0) + (spec.subtitle ? 16 : 0)
  const legendRoom = many ? 24 : 0
  // A vertical chart writes the value axis' name over the axis, in a strip `containLabel` does not keep.
  const nameRoom = !h && spec.valueName ? 20 : 0
  const labelRoom = labelled && !h ? 14 : 0
  const valueAxis = {
    type: 'value',
    name: spec.valueName || undefined,
    nameLocation: h ? 'middle' : 'end',
    nameGap: h ? 26 : 12,
    nameTextStyle: { color: faint, fontSize: 11, align: h ? 'center' : 'left' },
    axisLabel: { color: faint, fontSize: 11, formatter: (v: number) => fmtSig(v, LABEL_DIGITS) },
    splitLine: { lineStyle: { color: grid } }
  }
  const categoryAxis = {
    type: 'category',
    data: spec.categories,
    // Top to bottom in the block's order, as a reader lists them.
    inverse: h,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: faint } },
    axisLabel: h
      ? {
          color: faint,
          fontSize: 11,
          interval: 0,
          width: Math.max(80, Math.min(180, Math.floor((el.clientWidth || 400) * 0.38))),
          overflow: 'truncate'
        }
      : catAxisLabel(faint, spec.categories.length, el, spec.categories.length > 5)
  }
  return {
    title: titleOf(spec, el, ink, faint),
    legend: many
      ? {
          type: 'scroll',
          top: titleRoom,
          left: 0,
          right: BUTTON_ROOM,
          icon: 'roundRect',
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { color: faint, fontSize: 11 }
        }
      : undefined,
    grid: {
      left: 4,
      right: h && labelled ? 44 : 16,
      // The button's corner stays clear of the plot even without a title or a legend above it.
      top: Math.max(titleRoom + legendRoom, BUTTON_ROOM - 10) + nameRoom + labelRoom + 8,
      bottom: h && spec.valueName ? 26 : 4,
      containLabel: true
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      ...tooltipBeside(el),
      formatter: barTooltip
    },
    xAxis: h ? valueAxis : categoryAxis,
    yAxis: h ? categoryAxis : valueAxis,
    series: spec.series.map((s, i) => ({
      type: 'bar',
      name: s.name,
      stack: s.stack,
      barMaxWidth: 36,
      itemStyle: { color: palette[i % palette.length], borderRadius: stacked ? 0 : 2 },
      // Each value carries its own label side: a credit's label sits past the end of its bar too,
      // below or left of the axis, instead of on top of the axis line.
      data: s.values.map((v) =>
        v === null
          ? null
          : {
              value: v,
              label: { position: v < 0 ? (h ? 'left' : 'bottom') : h ? 'right' : 'top' }
            }
      ),
      label: {
        show: labelled,
        color: ink,
        fontSize: 10,
        formatter: (p: { value?: unknown }) =>
          typeof p.value === 'number' ? fmtSig(p.value, LABEL_DIGITS) : ''
      }
    }))
  }
}

function pieOption(spec: PieSpec, el: HTMLElement): SetOptionArg {
  const ink = cssVar('--ink', '#303030')
  const faint = cssVar('--faint', '#8a94a0')
  const surface = cssVar('--surface', '#ffffff')
  const titleRoom = (spec.title ? 22 : 0) + (spec.subtitle ? 16 : 0)
  return {
    title: titleOf(spec, el, ink, faint),
    tooltip: { trigger: 'item', ...tooltipBeside(el), formatter: pieTooltip },
    series: [
      {
        type: 'pie',
        name: spec.name,
        radius: ['36%', '64%'],
        center: ['50%', `${50 + Math.round(titleRoom / 5)}%`],
        avoidLabelOverlap: true,
        // The slices are parted by a line of the chart box's own colour.
        itemStyle: { borderColor: surface, borderWidth: 2 },
        label: {
          color: ink,
          fontSize: 11,
          formatter: (p: { name?: string; percent?: number }) => {
            const n = p.name ?? ''
            const cut = n.length > SLICE_LABEL_CHARS ? `${n.slice(0, SLICE_LABEL_CHARS - 1)}…` : n
            return `${cut}\n${fmtSig(p.percent ?? 0, 2)}%`
          }
        },
        labelLine: { lineStyle: { color: faint } },
        data: spec.slices.map((s, i) => ({
          name: s.name,
          value: s.value,
          itemStyle: { color: STACK_PALETTE[i % STACK_PALETTE.length] }
        }))
      }
    ]
  }
}
