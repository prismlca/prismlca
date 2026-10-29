import { useEffect, useMemo, useRef } from 'react'
import * as echarts from 'echarts'
import { subjectKey } from '../../lib/subjectKey'
import { FAMILY_PALETTE, STACK_PALETTE } from '../../lib/palette'
import { axisScale, clampNoise } from '../../lib/numberFormat'
import { cssVar } from '../../lib/cssVar'
import { followBox, useEChart, type ChartRegistry } from '../../lib/charts/useEChart'
import { stackTooltipHtml, tipValue, tooltipBeside } from '../../lib/charts/tooltip'
import { catAxisLabel, lighten, stackColor, trimCommonPrefix } from './chartUtils'
import type { CompareResponse, Matrix, Picked } from './types'

/** One small-multiple bar chart: subjects on x (each in its own colour), one indicator's scores.
 * `labels` are pre-rendered per-bar annotations (absolute value and/or % vs a reference). */
export function IndicatorChart({
  subjects,
  values,
  colors,
  labels,
  showLabel,
  unit,
  themeKey,
  regId,
  registry,
  scale = 1
}: {
  subjects: string[]
  values: number[]
  colors: string[]
  labels: string[]
  showLabel: boolean
  unit: string
  themeKey: string
  regId: string
  registry: ChartRegistry
  /** Type size multiplier: 1 in the panel, ZOOM_SCALE in the enlarge overlay. */
  scale?: number
}): JSX.Element {
  const ref = useEChart(
    regId,
    registry,
    (el) => {
      const axis = cssVar('--faint', '#8a94a0')
      const ink = cssVar('--ink', '#303030')
      const clean = clampNoise(values)
      const { exp, factor } = axisScale(clean)
      return {
        // Room for a wrapped two-line category label.
        // `containLabel: true` already reserves whatever the axis labels need, so a fixed `bottom` is added
        // *below* them — which is where the empty strip under every bar chart came from: a two-line
        // category label got its own ~30px plus 54px of nothing. 8px is breathing room under the labels; the
        // plot grows into the rest, so the chart fills the box it always had instead of the box shrinking.
        grid: { left: 8, right: 12, top: showLabel ? 24 : 10, bottom: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          ...tooltipBeside(el),
          // The plotted value is scaled by `factor`; the tooltip says the real one.
          valueFormatter: (v: number) => tipValue(v / factor, unit)
        },
        xAxis: {
          type: 'category',
          data: trimCommonPrefix(subjects),
          axisLabel: catAxisLabel(axis, subjects.length, el, subjects.length > 3, scale),
          axisLine: { lineStyle: { color: axis } }
        },
        yAxis: {
          type: 'value',
          name: exp ? `×1e${exp}` : undefined,
          nameTextStyle: { color: axis, fontSize: Math.round(10 * scale), align: 'left' },
          axisLabel: { color: axis, fontSize: Math.round(12 * scale) },
          splitLine: { lineStyle: { color: 'rgba(140,148,160,0.18)' } }
        },
        series: [
          {
            type: 'bar',
            data: clean.map((v, i) => ({
              value: v * factor,
              itemStyle: { color: colors[i], borderRadius: [3, 3, 0, 0] }
            })),
            barMaxWidth: Math.round(46 * scale),
            label: {
              show: showLabel,
              position: 'top',
              color: ink,
              fontSize: Math.round(10 * scale),
              lineHeight: Math.round(13 * scale),
              formatter: (p: { dataIndex: number }) => labels[p.dataIndex] ?? ''
            }
          }
        ]
      }
    },
    [subjects, values, colors, labels, showLabel, unit, themeKey, scale]
  )
  return <div className="ind-chart-canvas" ref={ref} />
}

/** More entries than this and the legend folds; a CPC split easily lists thirty classes. */
const LEGEND_FOLD_AT = 15
/** What a folded legend still shows: the heaviest keys, in stack order. */
const LEGEND_FOLDED_SHOWS = 10
/** How many of the folded-away entries the "+N more" tooltip names. A CPC split of one garden product
 *  came to 137 classes, and a 127-line tooltip runs off the screen. */
const LEGEND_TIP_NAMES = 25

/** The stacked bars' legend. Long class names are cut with an ellipsis (full name on hover); past
 *  `LEGEND_FOLD_AT` entries only the heaviest are listed and the rest sit behind "+N more", whose tooltip
 *  names the heaviest of them. Shown entries keep their place and colour in the stack order, so the dot
 *  still matches the segment. Unfolded, the legend scrolls past a few lines instead of pushing the charts
 *  off the page. */
export function StackLegend({
  keys,
  label,
  weights,
  open,
  onToggle
}: {
  keys: string[]
  label: (k: string) => string
  weights: Map<string, number>
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const fold = keys.length > LEGEND_FOLD_AT
  const shown = useMemo(() => {
    if (!fold || open) return new Set(keys)
    const heaviest = [...keys].sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0))
    return new Set(heaviest.slice(0, LEGEND_FOLDED_SHOWS))
  }, [keys, weights, fold, open])
  const hidden = keys
    .filter((k) => !shown.has(k))
    .sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0))
  const tip =
    hidden.length > LEGEND_TIP_NAMES
      ? [...hidden.slice(0, LEGEND_TIP_NAMES).map(label), `… and ${hidden.length - LEGEND_TIP_NAMES} more`]
      : hidden.map(label)
  const toggle = fold ? (
    <button
      type="button"
      className="stack-leg-more"
      aria-expanded={open}
      title={open ? undefined : tip.join('\n')}
      onClick={onToggle}
    >
      {open ? 'Show fewer' : `+${hidden.length} more`}
    </button>
  ) : null
  const items = keys.map((k, i) =>
    shown.has(k) ? (
      <span key={k} className="stack-leg-item" title={label(k)}>
        <span className="stack-leg-dot" style={{ background: stackColor(k, i) }} />
        <span className="stack-leg-text">{label(k)}</span>
      </span>
    ) : null
  )
  // Unfolded, the list scrolls and "Show fewer" stands under it — not at the end of a scroll box.
  return fold && open ? (
    <>
      <div className="stack-legend open">{items}</div>
      <div className="stack-leg-foot">{toggle}</div>
    </>
  ) : (
    <div className="stack-legend">
      {items}
      {toggle}
    </div>
  )
}

/** Per-indicator STACKED bar chart: one bar per subject, split into classification segments. */
export function StackedIndicatorChart({
  subjects,
  keys,
  keyLabels,
  valuesByKey,
  topLabels,
  unit,
  themeKey,
  regId,
  registry,
  scale = 1
}: {
  subjects: string[]
  keys: string[]
  keyLabels: Record<string, string>
  valuesByKey: Record<string, number[]>
  topLabels: string[] // per-bar annotation (total value and/or % vs reference), shown on top
  unit: string
  themeKey: string
  regId: string
  registry: ChartRegistry
  scale?: number
}): JSX.Element {
  const ref = useEChart(
    regId,
    registry,
    (el) => {
      const axis = cssVar('--faint', '#8a94a0')
      const all = keys.flatMap((k) => valuesByKey[k] ?? [])
      const noise = Math.max(...all.map((v) => Math.abs(v)), 0) * 1e-9
      const { exp, factor } = axisScale(all)
      return {
        // Same as above: `containLabel` reserves the axis labels, not the total/% label above the tallest
        // stack — that one needs the extra top margin, or it is cut off at the chart's edge.
        grid: { left: 8, right: 12, top: topLabels.some(Boolean) ? 24 : 10, bottom: 8, containLabel: true },
        tooltip: {
          trigger: 'axis',
          ...tooltipBeside(el),
          // Only this bar's non-zero segments, the biggest first, the rest summed: a CPC split has a
          // hundred-odd classes, and the default tooltip listed every one, zeros included.
          formatter: (params: unknown) =>
            stackTooltipHtml(params as Parameters<typeof stackTooltipHtml>[0], (v) =>
              tipValue(v / factor, unit)
            )
        },
        xAxis: {
          type: 'category',
          data: trimCommonPrefix(subjects),
          axisLabel: catAxisLabel(axis, subjects.length, el, subjects.length > 3, scale),
          axisLine: { lineStyle: { color: axis } }
        },
        yAxis: {
          type: 'value',
          name: exp ? `×1e${exp}` : undefined,
          nameTextStyle: { color: axis, fontSize: Math.round(10 * scale), align: 'left' },
          axisLabel: { color: axis, fontSize: Math.round(12 * scale) },
          splitLine: { lineStyle: { color: 'rgba(140,148,160,0.18)' } }
        },
        series: [
          ...keys.map((k, i) => ({
            name: keyLabels[k] ?? k,
            type: 'bar',
            stack: 'total',
            data: (valuesByKey[k] ?? []).map((v) => (Math.abs(v) < noise ? 0 : v * factor)),
            barMaxWidth: Math.round(46 * scale),
            itemStyle: { color: stackColor(k, i) }
          })),
          // Transparent zero-height segment on top of each stack — carries the total/% annotation.
          ...(topLabels.some(Boolean)
            ? [
                {
                  name: '',
                  type: 'bar',
                  stack: 'total',
                  // ECharts' default ('samesign') stacks a zero onto the NEAREST non-zero segment, of either
                  // sign: a bar whose last segment was negative got its total drawn at the bottom of the
                  // negative stack, the next bar at the top. 'positive' always lands
                  // on top of the positive stack, and on the zero line for an all-negative bar.
                  stackStrategy: 'positive',
                  data: subjects.map(() => 0),
                  silent: true,
                  tooltip: { show: false },
                  itemStyle: { color: 'transparent' },
                  label: {
                    show: true,
                    position: 'top',
                    color: cssVar('--ink', '#303030'),
                    fontSize: Math.round(10 * scale),
                    fontWeight: 600,
                    formatter: (pt: { dataIndex: number }) => topLabels[pt.dataIndex] ?? ''
                  }
                }
              ]
            : [])
        ]
      }
    },
    [subjects, keys, keyLabels, valuesByKey, topLabels, unit, themeKey, scale]
  )
  return <div className="ind-chart-canvas" ref={ref} />
}

/** Normalised comparison: each indicator scaled to its max subject (=100%), grouped by subject.
 * Series are ordered and coloured by method family (same family = same hue, shaded per indicator). */
export function NormalizedChart({
  subjects,
  groups,
  matrix,
  showValues,
  themeKey,
  registry,
  scale = 1
}: {
  subjects: string[]
  groups: { family: string; items: Picked[] }[]
  matrix: CompareResponse
  showValues: boolean
  themeKey: string
  registry: ChartRegistry
  scale?: number
}): JSX.Element {
  const ref = useEChart(
    'normalized',
    registry,
    (el) => {
      const axis = cssVar('--faint', '#8a94a0')
      // Colour by family only while there are families to tell apart: a family hue with its indicators as
      // lighter shades. With a single family that gave one green fading to pale green, and five shades of one
      // hue are not five colours — so then every indicator gets its own hue instead.
      const byFamily = groups.length > 1
      let ci = 0
      const series = groups.flatMap((g, gi) =>
        g.items.map((p, j) => {
          const raw = matrix.subjects.map((s) => s.scores[p.key] ?? 0)
          const max = Math.max(...raw.map(Math.abs), 0) || 1
          const base = FAMILY_PALETTE[gi % FAMILY_PALETTE.length]
          const color = byFamily
            ? g.items.length > 1
              ? lighten(base, (j / g.items.length) * 0.55)
              : base
            : STACK_PALETTE[ci++ % STACK_PALETTE.length]
          return {
            name: `${p.label} — ${g.family}`,
            type: 'bar',
            data: raw.map((v) => Math.round((v / max) * 1000) / 10),
            itemStyle: { color, borderRadius: [3, 3, 0, 0] },
            label: {
              show: showValues,
              position: 'top',
              fontSize: Math.round(9 * scale),
              color: cssVar('--ink', '#303030'),
              formatter: (pt: { value: number }) => `${pt.value}%`
            }
          }
        })
      )
      return {
        // The legend rides at the top, and `containLabel` does not account for it; the y-axis name "% of max"
        // stands ABOVE the axis, in the same band, and at top: 30 the legend covered it.
        // The 52 is the legend's line plus the name's own height plus its gap, at the panel's type size.
        grid: { left: 8, right: 12, top: Math.round(52 * scale), bottom: 8, containLabel: true },
        legend: { top: 0, textStyle: { color: axis, fontSize: Math.round(12 * scale) }, type: 'scroll' },
        tooltip: { trigger: 'axis', ...tooltipBeside(el), valueFormatter: (v: number) => `${v}% of max` },
        xAxis: {
          type: 'category',
          data: trimCommonPrefix(subjects),
          axisLabel: catAxisLabel(axis, subjects.length, el, subjects.length > 3, scale),
          axisLine: { lineStyle: { color: axis } }
        },
        yAxis: {
          type: 'value',
          name: '% of max',
          axisLabel: { color: axis, fontSize: Math.round(12 * scale) },
          nameTextStyle: { color: axis, fontSize: Math.round(12 * scale) },
          splitLine: { lineStyle: { color: 'rgba(140,148,160,0.18)' } }
        },
        series
      }
    },
    [subjects, groups, matrix, showValues, themeKey, scale]
  )
  return <div className="norm-chart-canvas" ref={ref} />
}

/** Radar chart: one axis per indicator, one polygon per subject, each value normalised to that
 * indicator's max subject (=100%) so differently-scaled indicators share the web. */
export function RadarChart({
  subjects,
  columns,
  matrix,
  themeKey,
  registry,
  scale = 1
}: {
  subjects: { label: string; id: string; color: string }[]
  columns: { key: string; label: string }[]
  matrix: Matrix
  themeKey: string
  registry: ChartRegistry
  scale?: number
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  /**
   * The chart is created ONCE and fed afterwards.
   *
   * It used to be created inside the data effect, so every re-run of that effect disposed the
   * instance and built a new one — and a rebuild is visible: the web is drawn from nothing with the
   * grow animation, which is the "it keeps reloading" this fixes. Which re-render triggered the
   * re-run turned out not to be the interesting question (the props kept their identities and the
   * element was never replaced, so it was neither a changed dependency nor a remount): `init` +
   * `dispose` is simply the wrong tool for new data. `setOption` is what ECharts offers for exactly
   * this, it diffs the option itself, and feeding it the same numbers twice is a no-op rather than
   * a flash.
   */
  const chartRef = useRef<echarts.ECharts | null>(null)
  useEffect(() => {
    if (!ref.current) return
    const chart = echarts.init(ref.current)
    chartRef.current = chart
    const unfollow = followBox(ref.current, chart)
    return () => {
      unfollow()
      chart.dispose()
      chartRef.current = null
    }
  }, [])

  // The PNG hook belongs to the registry it is written into, not to the data.
  useEffect(() => {
    const reg = registry.current // bound per effect run; the cleanup must delete from the same map
    reg.set('radar', () =>
      chartRef.current
        ? chartRef.current.getDataURL({
            type: 'png',
            pixelRatio: 2,
            backgroundColor: cssVar('--surface', '#ffffff')
          })
        : ''
    )
    return () => {
      reg.delete('radar')
    }
  }, [registry])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !ref.current) return
    const axis = cssVar('--faint', '#8a94a0')
    const maxes = columns.map(
      (c) => Math.max(...matrix.subjects.map((s) => Math.abs(s.scores[c.key] ?? 0)), 0) || 1
    )
    // notMerge: the axes and the series both change with the indicator selection, and a merge would
    // leave the polygons of a subject that is no longer picked lying on the web.
    chart.setOption(
      {
        tooltip: tooltipBeside(ref.current),
        legend: { top: 0, type: 'scroll', textStyle: { color: axis, fontSize: Math.round(12 * scale) } },
        radar: {
          indicator: columns.map((c) => ({ name: c.label, max: 100 })),
          axisName: { color: axis, fontSize: Math.round(10 * scale) },
          splitLine: { lineStyle: { color: 'rgba(140,148,160,0.25)' } },
          splitArea: { show: false },
          axisLine: { lineStyle: { color: 'rgba(140,148,160,0.25)' } }
        },
        series: [
          {
            type: 'radar',
            data: subjects.map((su) => {
              const row = matrix.subjects.find((x) => subjectKey(x, null) === su.id)
              return {
                name: su.label,
                value: columns.map((c, i) => Math.round(((row?.scores[c.key] ?? 0) / maxes[i]) * 1000) / 10),
                symbolSize: 4,
                itemStyle: { color: su.color },
                lineStyle: { color: su.color, width: 2 },
                areaStyle: { color: su.color, opacity: 0.08 }
              }
            })
          }
        ]
      },
      true
    )
  }, [subjects, columns, matrix, themeKey, scale])
  return <div className="radar-canvas" ref={ref} />
}
