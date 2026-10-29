/**
 * The REPORT figure builders — every chart that lands in a PDF is drawn from here.
 *
 * Why this is its own module, and deliberately NOT shared with the on-screen charts in
 * `views/Results.tsx`: the two stacks draw the same four figure kinds, but they answer to different
 * masters, and that is a shipped decision rather than an accident of growth.
 *
 * - A report figure is lettered in the report theme's own faces and inks (`figureInk`,
 *   `ReportPalette`) and its numbers are set in the REPORT's language and number format — the one
 *   its tables use. It used to follow the on-screen charts instead, and what that produced was
 *   "48.5" on the page facing a table cell reading "41,3" in a German report (V187). There was
 *   also a `cssVar()` in here once, reading the app's theme tokens for the axis colours. It is
 *   gone, and its absence is the point: nothing the app looks like reaches a report figure any
 *   more — switching the app to dark mode must not change what a PDF looks like.
 * - An on-screen chart follows the app theme (`cssVar` tokens), is interactive (tooltips, resize,
 *   the PNG-export registry) and labels itself for a live panel, not for paper.
 *
 * So "unify the two stacks" reads the divergence backwards: the shared ground is the lifecycle
 * (`useEChart`) and the maths, not the options. What must never happen is a change here that was
 * meant for the screen — which is exactly why these builders now live away from any view.
 *
 * Every option builder takes the same arguments in the same order (data…, pal, [variant flags,]
 * theme, fonts, lang) — the call sites pass them positionally, and an argument that sits in a
 * different place in one of five signatures is a bug waiting for a call site.
 */
import * as echarts from 'echarts'
import { HEAT_RANGE } from '../heat'
import { localiseNumberText, reportAxisTick, reportSeriesFormat } from '../numberFormat'
import { PRISM_PALETTE, figureInk, seriesColors, type FigureInk, type ReportPalette } from '../reportColors'
import {
  ellipsize,
  fitLabels,
  legendLayout,
  legendOption,
  plotTop,
  textWidth,
  type FittedLabels
} from './figureText'

/**
 * One row of a breakdown. `key` binds — it is what a written chapter pins a group by, and it never
 * follows the report language. `label` is what a chart prints, and it does: a tag value is the
 * modeller's own wording, so it goes through the report's translation step (V240). Older snapshots
 * have no `label`, hence the fallback at every reading site.
 */
export type ContributionGroup = { key: string; label?: string; impact: number }

/** The phases across a set of variants, in first-seen order, each with the text to print for it. */
export function phasesOf(subjects: { groups: ContributionGroup[] }[]): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  for (const s of subjects)
    for (const g of s.groups)
      if (!out.some((p) => p.key === g.key)) out.push({ key: g.key, label: g.label || g.key })
  return out
}

/**
 * The faces a figure is lettered in — the theme's own, so a chart looks like the page it lands on rather than
 * like something pasted in from the app. They arrive with `/sources` from the theme's registry entry.
 *
 * The stack keeps a fallback: the browser measures the labels (that is how echarts sizes its axes and decides
 * where to break them) while *Typst* renders the finished SVG from its own bundled copy. Only Noto Sans is
 * loaded in the renderer, so measurement happens in it and drawing happens in the theme's face. Around the
 * axes the margins absorb the difference; the legend, where they did not, is laid out from widths that
 * hold for every bundled face instead (`figureText`).
 */
export type FigureFonts = { body: string; mono: string }

export const figureFont = (fonts: FigureFonts | undefined, which: 'body' | 'mono' = 'body'): string =>
  `${fonts?.[which] ?? 'Noto Sans'}, Noto Sans, sans-serif`

/** Legend type: 10 px over the dense contribution bars, 11 px over the radar's open wheel. */
const LEGEND_SIZE = 10
const RADAR_LEGEND_SIZE = 11

/**
 * Where a grouped or stacked contribution chart's plot starts: under its legend and, when the bars stand
 * up, under the line the unit is lettered on. The drawing's height (lib/report/figures) grows by the same,
 * so the plot keeps its size however many rows the legend takes.
 */
export function contributionPlotTop(labels: string[], horizontal = false): number {
  return plotTop(legendLayout(labels, LEGEND_SIZE), !horizontal)
}

/** The radar wheel's own area under the legend, and its radius in it — fixed, so extra legend rows add height. */
const RADAR_AREA = 411
const RADAR_RADIUS = 145

/** The radar's drawing height: the wheel's area under however many rows the legend takes. */
export function radarHeight(labels: string[]): number {
  return plotTop(legendLayout(labels, RADAR_LEGEND_SIZE), false) + RADAR_AREA
}

/** The width every bar chart is drawn at, and every contribution chart (lib/report/figures draws them so). */
export const BAR_WIDTH = 620
export const CONTRIBUTION_WIDTH = 720

/**
 * What an upright chart's grid sides (28) and value-axis numbers take from the drawing's width: room for six
 * digits. Wider numbers narrow every column by their excess shared out over the columns, which the gap
 * between two labels absorbs.
 */
const VALUE_AXIS_ALLOWANCE = 76
/** Air between two neighbouring labels under upright bars, at their widest. */
const COLUMN_GAP = 8
/** The label column beside bars running across, and beside a stacked chart's variants or a heatmap's rows. */
const ROW_LABEL_WIDTH = 150
const STACK_ROW_LABEL_WIDTH = 130

/** How long a name standing on end may run, and how many lines of it may stand side by side in a column. */
const ON_END_LENGTH = 120
const ON_END_LINES = 2

/** Labels under upright bars: the fitted lines, and whether they stand on end. */
interface ColumnLabels {
  fit: FittedLabels
  rotate: 0 | 90
}

/**
 * The labels under upright bars, each fitted to its column — never wider than `cap`, the width they had
 * when there were few of them. Upright first: a name reads best level, and a column's worth of short lines
 * reads straight down. The type steps down to 10 px — about 6.5 pt on the page, the smallest a printed label
 * stays readable at — and a name may take five lines; that holds nine variants. Where even then a word
 * would have to be split, the columns are too narrow for words at all, and the names stand on end instead,
 * at 10 px and up to two lines side by side, ending in an ellipsis past `ON_END_LENGTH`: a word broken
 * between two letters is a misprint, a name read with the head tilted is not.
 */
function columnLabels(labels: string[], drawingWidth: number, cap: number): ColumnLabels {
  const column = Math.floor((drawingWidth - VALUE_AXIS_ALLOWANCE) / Math.max(1, labels.length)) - COLUMN_GAP
  const upright = fitLabels(labels, Math.max(24, Math.min(cap, column)), [12, 11, 10], 5)
  if (!upright.split) return { fit: upright, rotate: 0 }
  const lines = Math.max(1, Math.min(ON_END_LINES, Math.floor(column / Math.round(10 * 1.1))))
  return { fit: fitLabels(labels, ON_END_LENGTH, [10], lines), rotate: 90 }
}

/** The axis-label option for labels under upright bars, standing on end where they have to. */
function columnAxisLabel(labels: ColumnLabels, color: string) {
  return { ...fittedAxisLabel(labels.fit, color), rotate: labels.rotate }
}

/**
 * Room beyond the labels' far side for the face Typst prints them in. echarts keeps room for a label by its
 * own measurement, in Noto Sans, not by the fitted box — so where the far side of a label is its length (a
 * name on end, a name left of bars running across) the theme's face can print up to a tenth longer than the
 * room kept for it.
 */
const faceSlack = (fit: FittedLabels): number => Math.ceil(fit.width * 0.1)

/** How much deeper than one line of 12-pixel type the labels under upright bars reach. */
const columnLabelDepth = (labels: ColumnLabels): number =>
  labels.rotate ? Math.max(0, labels.fit.width - 13) + faceSlack(labels.fit) : extraLines(labels.fit)

/** The labels beside bars running across: a fixed column at 12 px, the rows growing with their lines. */
function rowLabels(labels: string[], width: number, maxLines = 4): FittedLabels {
  return fitLabels(labels, width, [12], maxLines)
}

/**
 * The axis-label option for fitted labels. Every label is given the fitted box — an invisible background
 * holds it at its set width — and prints its fitted lines, so where the lines break does not depend on the
 * face echarts measured in. The room echarts keeps for the labels beside the plot still follows its own
 * measurement; `faceSlack` covers that on the side where it matters.
 */
function fittedAxisLabel(fit: FittedLabels, color: string) {
  return {
    color,
    fontSize: fit.fontSize,
    lineHeight: fit.lineHeight,
    width: fit.width,
    backgroundColor: 'rgba(0,0,0,0)',
    interval: 0,
    formatter: (_: string, i: number) => fit.text[i] ?? ''
  }
}

/** Room right of a value axis that runs across: its unit, 11 px, set 10 past the axis' end. */
const unitRoom = (unit: string): number => Math.ceil(textWidth(unit, 11)) + 14

/** How much taller than one line of 12-pixel type a block of fitted labels stands. */
const extraLines = (fit: FittedLabels): number => Math.max(0, fit.lines * fit.lineHeight - 13)

/**
 * A stacked contribution chart's drawing height. Upright: the plot, under its legend, over the variants'
 * names in as many lines as they took. Across: at least a row per variant as tall as its name.
 */
export function stackedContributionHeight(
  subjects: { label: string; groups: ContributionGroup[] }[],
  horizontal = false
): number {
  const phases = phasesOf(subjects).map((p) => p.label)
  const names = subjects.map((s) => s.label)
  const base = 122 + phases.length * 12 + names.length * 18 + contributionPlotTop(phases, horizontal)
  if (!horizontal) return base + columnLabelDepth(columnLabels(names, CONTRIBUTION_WIDTH, 110))
  const fit = rowLabels(names, STACK_ROW_LABEL_WIDTH)
  return Math.max(
    base,
    contributionPlotTop(phases, true) + 50 + names.length * (10 + fit.lines * fit.lineHeight)
  )
}

/** An upright bar chart's drawing height: 320, and the lines its labels take beyond the first. */
export function columnChartHeight(labels: string[]): number {
  return 320 + columnLabelDepth(columnLabels(labels, BAR_WIDTH, 92))
}

/**
 * Render an echarts option to an SVG string, off-screen.
 *
 * Charts are produced here, not in the backend: echarts and the colour tokens live in the renderer, so
 * a report figure is the same drawing as the one on screen. SVG rather than PNG because the PDF is a
 * deliverable — Typst embeds the vector and it stays sharp at any zoom.
 */
export function chartSvg(option: echarts.EChartsOption, width = 620, height = 300): string | null {
  const host = document.createElement('div')
  host.style.cssText = `position:absolute;left:-10000px;width:${width}px;height:${height}px`
  document.body.appendChild(host)
  let chart: echarts.ECharts | null = null
  try {
    chart = echarts.init(host, undefined, { renderer: 'svg', width, height })
    chart.setOption({ animation: false, ...option })
    return host.querySelector('svg')?.outerHTML ?? null
  } catch {
    return null // a missing figure must never stop the report from rendering
  } finally {
    // In `finally`, or a throwing setOption left the instance behind in echarts' registry forever.
    chart?.dispose()
    host.remove()
  }
}

/**
 * Horizontal bars, house green, generous right margin so value labels are not clipped.
 *
 * Horizontal on purpose: category names in an LCA are long ("End of life", "Long distribution
 * (1200 km)"), and a horizontal bar gives the label a whole line instead of a column's width. Labels
 * still wrap rather than truncate — the tail of a scenario name is usually the part that identifies it.
 */
export function barOption(
  labels: string[],
  values: number[],
  axisName: string,
  pal: ReportPalette = PRISM_PALETTE,
  /** Bars across the page (the default) or up it — a chapter's own choice; see the figure editor. */
  horizontal = true,
  theme: FigureInk = figureInk(false),
  fonts?: FigureFonts,
  /** The REPORT's language, never the app's — every number in the drawing is set in it. */
  lang = 'en'
): echarts.EChartsOption {
  const ink = theme.ink
  // The report's own number format — the one its TABLES are set in: same decimals, same separators,
  // same exponent form. This used to follow the Results charts instead, on the argument that a figure
  // in the PDF should read like the chart on screen; what it produced was "48.5" on the page facing a
  // table cell reading "41,3" in a German report (V187). The document beside the figure wins.
  const fmt = reportSeriesFormat(values, lang)
  const value = {
    type: 'value' as const,
    name: axisName,
    nameLocation: 'end' as const,
    nameGap: 8,
    // Which ticks, and how many digits they carry, stays echarts' decision; only the notation is ours.
    axisLabel: { color: theme.axis, formatter: (v: number) => reportAxisTick(v, lang) },
    nameTextStyle: { color: theme.axis },
    axisLine: { lineStyle: { color: theme.edge } },
    splitLine: { show: true, lineStyle: { color: theme.grid } }
  }
  const rows = rowLabels(labels, ROW_LABEL_WIDTH)
  const columns = columnLabels(labels, BAR_WIDTH, 92)
  const category = {
    type: 'category' as const,
    data: labels,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: theme.edge } },
    // Vertical bars put the label under its bar, in a column as wide as the bar's share of the width;
    // bars running across give it a line and a half, and the rows grow with its lines (`rowChartHeight`).
    axisLabel: horizontal ? fittedAxisLabel(rows, theme.axis) : columnAxisLabel(columns, theme.axis)
  }
  return {
    textStyle: { fontFamily: figureFont(fonts), color: ink, fontSize: 11 },
    grid: horizontal
      ? // The right margin holds the value labels AND the axis unit name — the fixed 76px clipped
        // "m3 world Eq deprived" to "m3 world Eq d…" in a delivered PDF (V124). The unit's width in the
        // widest face at 11px type; the bars give up a little room so the unit stays whole.
        {
          left: 8 + faceSlack(rows),
          right: Math.max(76, unitRoom(axisName)),
          top: 10,
          bottom: 26,
          containLabel: true
        }
      : {
          left: 12,
          right: 16,
          top: 26,
          bottom: 10 + (columns.rotate ? faceSlack(columns.fit) : 0),
          containLabel: true
        },
    xAxis: horizontal ? value : category,
    yAxis: horizontal ? category : value,
    series: [
      {
        type: 'bar',
        data: values,
        barMaxWidth: 76,
        itemStyle: { color: pal.accent },
        label: {
          show: true,
          position: horizontal ? 'right' : 'top',
          // Colour and stroke spelled out: echarts letters a label outside its bar in near-black with a 2px
          // white halo, which is a sensible default on white paper and, on the dark theme, dark type inside a
          // white outline — an ugly white outline. The halo exists to keep a label legible
          // where it overlaps its bar; ours sit beyond the bar's end, so there is nothing to separate from.
          color: theme.ink,
          textBorderWidth: 0,
          formatter: (p: unknown) => fmt((p as { value: number }).value)
        }
      }
    ]
  }
}

/**
 * Height for a horizontal bar chart whose category labels wrap.
 *
 * The label column is 150px, so a dataset name like "transport, freight, light commercial vehicle, fleet
 * average" takes three lines — and ten of those in fixed 26px rows printed on top of each other in a
 * delivered PDF (V124). Each row gets the height its longest label needs, counted from the same lines the
 * axis prints (at most four), and `floor` keeps a chart of few rows at the height it always had.
 */
export function rowChartHeight(labels: string[], floor = 220): number {
  const fit = rowLabels(labels, ROW_LABEL_WIDTH)
  return Math.max(floor, 60 + labels.length * Math.max(26, 10 + fit.lineHeight * fit.lines))
}

/**
 * A subject's score for each indicator, normalised to the largest value of that indicator.
 *
 * Both figures below compare across indicators, and indicators do not share a unit — 1.7 MJ-Eq and
 * 0.12 kg CO2-eq have no common axis. Percent-of-largest is the only honest way to put them side by side,
 * and it is what the Results page does for the same reason.
 */
export function normalised(
  subjects: { label: string; results?: { method_label: string; score: number }[] }[],
  indicators: string[]
): { labels: string[]; rows: number[][] } {
  const maxes = indicators.map(
    (label) =>
      Math.max(
        ...subjects.map((s) => Math.abs((s.results ?? []).find((r) => r.method_label === label)?.score ?? 0)),
        0
      ) || 1
  )
  return {
    labels: subjects.map((s) => s.label),
    rows: subjects.map((s) =>
      indicators.map(
        (label, i) =>
          Math.round(
            (((s.results ?? []).find((r) => r.method_label === label)?.score ?? 0) / maxes[i]) * 1000
          ) / 10
      )
    )
  }
}

/** Spider chart: one closed line per subject over the indicator axes, each axis scaled to its own maximum. */
export function radarOption(
  subjects: { label: string; results?: { method_label: string; score: number }[] }[],
  indicators: string[],
  shortLabels: string[],
  pal: ReportPalette = PRISM_PALETTE,
  theme: FigureInk = figureInk(false),
  fonts?: FigureFonts
): echarts.EChartsOption {
  const ink = theme.ink
  const axis = theme.axis
  const { labels, rows } = normalised(subjects, indicators)
  // A credit is a negative share of the axis maximum. With the axes starting at 0 ECharts gave it a
  // negative radius — drawn through the centre onto the OPPOSITE axis, where it read as a burden
  // under another indicator. One common floor for every axis keeps the zero ring
  // a circle, and a credit sits inside it.
  const floor = Math.min(0, ...rows.flat())
  // As many colours as there are variants, derived from the report's set — the old three-colour list
  // repeated itself from the fourth variant on, so two lines on the radar were the same colour.
  const palette = seriesColors(Math.max(2, rows.length), pal)
  const legend = legendLayout(labels, RADAR_LEGEND_SIZE)
  return {
    textStyle: { fontFamily: figureFont(fonts), color: ink, fontSize: 11 },
    legend: legendOption(legend, ink),
    radar: {
      // The wheel is centred in its own area under the legend, so the top axis label never reaches a
      // legend row however many there are — the drawing grows by them instead (`radarHeight`).
      center: ['50%', plotTop(legend, false) + RADAR_AREA / 2],
      radius: RADAR_RADIUS,
      indicator: shortLabels.map((name) => ({ name, max: 100, ...(floor < 0 ? { min: floor } : {}) })),
      axisName: { color: axis, fontSize: 11 },
      splitLine: { lineStyle: { color: theme.grid } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: theme.grid } }
    },
    series: [
      {
        type: 'radar',
        data: rows.map((value, i) => ({
          name: labels[i],
          value,
          symbolSize: 3,
          itemStyle: { color: palette[i % palette.length] },
          lineStyle: { color: palette[i % palette.length], width: 2 },
          areaStyle: { color: palette[i % palette.length], opacity: 0.08 }
        }))
      }
    ]
  }
}

/** "Total", in the five report languages.
 *
 * The only word the renderer writes into a figure itself — every other label is a group key, a unit or a
 * variant name, and those are data. Five entries rather than a call into the backend's string table,
 * which lives on the other side of the IPC bridge and would be one request per chart. */
const TOTAL_LABEL: Record<string, string> = {
  en: 'Total',
  de: 'Gesamt',
  fr: 'Total',
  es: 'Total',
  pt: 'Total'
}

/**
 * Grouped bars: one group per contribution phase, one bar per assessed variant, and the totals at the end.
 *
 * The single breakdown chart was the baseline's. In a report comparing three variants that is one third
 * of the answer — where the difference between them arises is the question the report exists for, and
 * this is the chart that shows it.
 */
export function groupedContributionOption(
  subjects: { label: string; groups: ContributionGroup[] }[],
  unit: string,
  pal: ReportPalette = PRISM_PALETTE,
  theme: FigureInk = figureInk(false),
  fonts?: FigureFonts,
  /** The REPORT's language: it names the total column AND sets every number in the drawing. Last in
   *  the list like every other builder here — the call sites pass these positionally, and an argument
   *  that sits in a different place in one of five signatures is a bug waiting for a call site. */
  lang = 'en'
): echarts.EChartsOption {
  const ink = theme.ink
  const palette = seriesColors(Math.max(2, subjects.length), pal)
  const phases = phasesOf(subjects)
  // Grouped bars answer "which variant is worse in this phase" and hide the one number the reader came
  // for: what each variant adds up to. A total group at the end gives that back without a second chart —
  // summed rather than taken from the results, so it is the sum of exactly the bars beside it, credits
  // and all.
  const total = TOTAL_LABEL[lang] ?? TOTAL_LABEL.en
  const totals = subjects.map((s) => s.groups.reduce((sum, g) => sum + g.impact, 0))
  const categories = [...phases.map((p) => p.label), total]
  const values = subjects.flatMap((s) => s.groups.map((g) => Math.abs(g.impact))).filter((v) => v > 0)
  const max = values.length ? Math.max(...values) : 0
  const decimals =
    !max || max >= 1e6 || max < 1e-4 ? 0 : Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(max))))
  const legend = legendLayout(
    subjects.map((s) => s.label),
    LEGEND_SIZE
  )
  return {
    textStyle: { fontFamily: figureFont(fonts), color: ink, fontSize: 11 },
    legend: legendOption(legend, ink),
    grid: { left: 12, right: 16, top: plotTop(legend, true), bottom: 12, containLabel: true },
    xAxis: {
      type: 'category',
      data: categories,
      axisLine: { lineStyle: { color: theme.edge } },
      axisLabel: {
        color: theme.axis,
        width: 90,
        overflow: 'break',
        interval: 0,
        lineHeight: 12,
        // A split by location has sixteen groups on one axis (fifteen plus "Other"); upright, their
        // labels ran into each other. Slanted from nine groups on, and only then — the four life-cycle
        // phases read better upright.
        rotate: categories.length > 8 ? 30 : 0,
        // The total is a different kind of quantity from the phases beside it; bold says so without a
        // divider, which a category axis has no room for. Rich text, because `fontWeight` on the axis
        // applies to every label at once.
        formatter: (v: string) => (v === total ? `{t|${v}}` : v),
        rich: { t: { fontWeight: 'bold', color: ink, lineHeight: 12 } }
      }
    },
    yAxis: {
      type: 'value',
      name: unit,
      nameLocation: 'end',
      nameGap: 10,
      nameTextStyle: { color: theme.axis },
      axisLine: { lineStyle: { color: theme.edge } },
      // The figure-ink grid, like every other builder: echarts' default light grey glares on a dark
      // theme's near-black paper — the exact defect `figureInk` exists to prevent.
      splitLine: { show: true, lineStyle: { color: theme.grid } },
      // Common decimals across the ticks (a scale reading 0.001 / 0.0015 / 0.002 looks like three
      // precisions), then the report's notation: separators and exponent as the tables use them.
      axisLabel: {
        color: theme.axis,
        formatter: (v: number) => reportAxisTick(v, lang, decimals)
      }
    },
    series: subjects.map((s, i) => ({
      type: 'bar',
      name: s.label,
      data: [...phases.map((p) => s.groups.find((g) => g.key === p.key)?.impact ?? 0), totals[i]],
      itemStyle: { color: palette[i % palette.length] }
    }))
  }
}

/**
 * Stacked bars: one bar per assessed variant, one segment per contribution group.
 *
 * The same numbers as the grouped chart, read the other way round. Grouped answers "which variant is
 * worst in this phase"; stacked answers "what is this variant made of, and how much is it in total" —
 * the composition question a breakdown by life-cycle phase or by tag is chosen for in the first place.
 * With one variant it is a single bar, which is still the clearest picture of a composition.
 *
 * Segments are as many colours as there are phases, derived from the report's own set: the colours here
 * separate phases, not variants, and there are usually more than three of them — the old fixed list of three
 * repeated itself, which in a stack means two segments that look like one.
 */
export function stackedContributionOption(
  subjects: { label: string; groups: ContributionGroup[] }[],
  unit: string,
  pal: ReportPalette = PRISM_PALETTE,
  /** Stacked (the default) or one bar per group side by side — the same numbers, two readings. */
  stacked = true,
  horizontal = false,
  theme: FigureInk = figureInk(false),
  fonts?: FigureFonts,
  /** The REPORT's language, never the app's. */
  lang = 'en'
): echarts.EChartsOption {
  const ink = theme.ink
  const phases = phasesOf(subjects)
  // The scale is read off the bar totals, not off single segments: a stack is as tall as its sum.
  const totals = subjects.map((s) => s.groups.reduce((sum, g) => sum + Math.abs(g.impact), 0))
  const max = totals.length ? Math.max(...totals) : 0
  const decimals =
    !max || max >= 1e6 || max < 1e-4 ? 0 : Math.max(0, Math.min(6, 2 - Math.floor(Math.log10(max))))
  const names = subjects.map((s) => s.label)
  const rows = rowLabels(names, STACK_ROW_LABEL_WIDTH)
  const columns = columnLabels(names, CONTRIBUTION_WIDTH, 110)
  const category = {
    type: 'category' as const,
    data: names,
    axisLine: { lineStyle: { color: theme.edge } },
    // Each name fitted to its column under upright bars — a fixed 110 ran nine names into each other —
    // or to a fixed column beside bars running across; `stackedContributionHeight` makes room for the lines.
    axisLabel: horizontal ? fittedAxisLabel(rows, theme.axis) : columnAxisLabel(columns, theme.axis)
  }
  const value = {
    type: 'value' as const,
    name: unit,
    nameLocation: 'end' as const,
    nameGap: 10,
    nameTextStyle: { color: theme.axis },
    axisLine: { lineStyle: { color: theme.edge } },
    splitLine: { show: true, lineStyle: { color: theme.grid } },
    axisLabel: {
      color: theme.axis,
      formatter: (v: number) => reportAxisTick(v, lang, decimals)
    }
  }
  const legend = legendLayout(
    phases.map((p) => p.label),
    LEGEND_SIZE
  )
  return {
    textStyle: { fontFamily: figureFont(fonts), color: ink, fontSize: 11 },
    legend: legendOption(legend, ink),
    // Bars across the page put the unit at the foot, beside the value axis' end, where it needs room on the
    // right (16 cut "kg CO2-Eq" to "k"); only upright bars need a line for it under the legend.
    grid: {
      left: 12 + (horizontal ? faceSlack(rows) : 0),
      right: horizontal ? Math.max(16, unitRoom(unit)) : 16,
      top: plotTop(legend, !horizontal),
      bottom: 12 + (!horizontal && columns.rotate ? faceSlack(columns.fit) : 0),
      containLabel: true
    },
    xAxis: horizontal ? value : category,
    yAxis: horizontal ? category : value,
    series: phases.map((phase, i) => ({
      type: 'bar',
      // Without a cap a single-variant stack is one bar as wide as the chart, which reads as a block of
      // colour rather than as a bar. ECharts sizes bars from the category band, and with one category
      // that band is the whole plot.
      barMaxWidth: 76,
      // One stack name for all series is what makes them a stack rather than an overlay. Credits stay
      // negative and ECharts puts them below the axis, which is the honest picture of an avoided burden.
      //
      // Without it the same series sit side by side: one bar per phase per variant. Two readings of one set
      // of numbers — a stack says what a variant is made of, side by side says which variant is worse in
      // this phase — and which one a chapter wants is the chapter's call.
      ...(stacked ? { stack: 'contribution' } : {}),
      name: phase.label,
      data: subjects.map((s) => s.groups.find((g) => g.key === phase.key)?.impact ?? 0),
      itemStyle: { color: seriesColors(phases.length, pal)[i] }
    }))
  }
}

/** From five indicators on, a heatmap's indicator names stand on end, cut to this many pixels. */
const HEAT_ON_END = 150
/** Up to four, they stand upright in boxes this wide, wrapped to this many lines. */
const HEAT_UPRIGHT_WIDTH = 100
const HEAT_UPRIGHT_LINES = 3
const HEAT_AXIS_SIZE = 10

/** A heatmap's indicator names as `heatmapOption` prints them, and how deep they reach under the plot. */
function heatAxis(shortLabels: string[]): { text: string[]; width: number; depth: number; onEnd: boolean } {
  if (shortLabels.length > 4) {
    const text = shortLabels.map((label) => ellipsize(label, HEAT_ON_END, HEAT_AXIS_SIZE))
    const width = Math.ceil(Math.max(0, ...text.map((t) => textWidth(t, HEAT_AXIS_SIZE))))
    return { text, width, depth: width, onEnd: true }
  }
  const fit = fitLabels(shortLabels, HEAT_UPRIGHT_WIDTH, [HEAT_AXIS_SIZE], HEAT_UPRIGHT_LINES)
  return { text: fit.text, width: fit.width, depth: fit.lines * fit.lineHeight, onEnd: false }
}

/** A heatmap's variant names, three lines at most, and the row each needs: 46, or as tall as its lines. */
function heatRows(labels: string[]): { fit: FittedLabels; row: number } {
  const fit = rowLabels(labels, STACK_ROW_LABEL_WIDTH, 3)
  return { fit, row: Math.max(46, fit.lines * fit.lineHeight + 12) }
}

/**
 * A heatmap's drawing height, from what it prints: how deep its indicator names reach and one row per variant
 * as tall as its name. Both callers size the drawing with this, so the rows always have the room their names
 * take — a fixed allowance for names on end left two variants 17 px each under "photochemical oxidant
 * formation: human health", and their wrapped names ran into each other.
 */
export function heatmapHeight(variantLabels: string[], shortLabels: string[]): number {
  return 52 + heatAxis(shortLabels).depth + variantLabels.length * heatRows(variantLabels).row
}

/** Heatmap: subjects × indicators, each cell shaded by its share of that indicator's largest value. */
export function heatmapOption(
  subjects: { label: string; results?: { method_label: string; score: number }[] }[],
  indicators: string[],
  shortLabels: string[],
  // Kept in the signature although the ramp no longer uses it: every option builder here takes the
  // same arguments in the same order, and the call sites pass them positionally. Dropping it
  // from one of them buys a parameter and costs the symmetry that makes the call sites readable.
  _pal: ReportPalette = PRISM_PALETTE,
  theme: FigureInk = figureInk(false),
  fonts?: FigureFonts,
  /** The REPORT's language: the cells carry a percentage, and "84.2%" is "84,2 %" in four of the five. */
  lang = 'en'
): echarts.EChartsOption {
  const ink = theme.ink
  const { labels, rows } = normalised(subjects, indicators)
  // Three lines at most; `heatmapHeight` gives every row the room its lines need.
  const nameFit = heatRows(labels).fit
  const axis = heatAxis(shortLabels)
  const cells: [number, number, number][] = []
  rows.forEach((row, y) => row.forEach((value, x) => cells.push([x, y, value])))
  return {
    textStyle: { fontFamily: figureFont(fonts), color: ink, fontSize: 11 },
    // Generous margins and bounded label widths: at 8px the subject names were clipped at the SVG edge
    // ("ong distribution"), which reads as a broken chart rather than a long name.
    grid: { left: 14 + faceSlack(nameFit), right: 14, top: 10, bottom: 12, containLabel: true },
    xAxis: {
      type: 'category',
      data: shortLabels,
      splitArea: { show: true },
      // Upright and wrapped up to four indicators; from five on the names stand vertical, or eleven of
      // them wrap into three-line stacks that run into each other. Fitted here, in the widest face, so the
      // depth `heatmapHeight` reserved is the depth they take.
      axisLabel: {
        color: ink,
        fontSize: HEAT_AXIS_SIZE,
        lineHeight: Math.round(HEAT_AXIS_SIZE * 1.1),
        interval: 0,
        margin: 8,
        ...(axis.onEnd ? { rotate: 90 } : { width: HEAT_UPRIGHT_WIDTH, backgroundColor: 'rgba(0,0,0,0)' }),
        formatter: (_: string, i: number) => axis.text[i] ?? ''
      }
    },
    yAxis: {
      type: 'category',
      data: labels,
      splitArea: { show: true },
      axisLabel: { ...fittedAxisLabel(nameFit, ink), margin: 8 }
    },
    visualMap: {
      min: 0,
      max: 100,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      show: false,
      // The APP's ramp, not the report palette's: green (low) → amber → red (high), the same stops the
      // Results heatmap uses. A heat scale is the one part of a figure whose colours ARE the reading,
      // so it does not follow the document's set the way the axis ink and the series colours do —
      // otherwise the same cell would mean different things in two exports of one study.
      inRange: { color: HEAT_RANGE }
    },
    series: [
      {
        type: 'heatmap',
        data: cells,
        // The halo stays here, and only here: a heatmap label sits *on* a filled cell whose lightness runs
        // from pale paper to the deep tone, so no single text colour reads at both ends of the ramp. That is
        // exactly the case echarts' default outline is for — unlike a value beyond the end of a bar, which
        // overlaps nothing and needs no outline at all.
        label: {
          show: true,
          // "84,2 %" — the separator from the report's language and the space the backend puts before
          // every percent sign it writes (`report_data`), so the cells read like the shares in the tables.
          formatter: (p: unknown) =>
            `${localiseNumberText(String((p as { value: number[] }).value[2]), lang)} %`,
          fontSize: 10.5
        },
        // The cell border is the paper showing through the grid, so it is the page's colour, not the app's.
        itemStyle: { borderColor: theme.edge, borderWidth: 1 }
      }
    ]
  }
}
