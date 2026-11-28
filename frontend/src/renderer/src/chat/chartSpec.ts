/**
 * A chart the assistant writes into its answer, read out of a model's JSON.
 *
 * The assistant may close a larger piece of work with a fenced `echarts` block holding an Apache ECharts
 * option (main/ai/systemPrompt.ts, `CHART_RULE`). That option is never handed to ECharts as it stands. A
 * model's text can carry instructions from a web page it read, a chat can arrive in someone else's
 * .prism bundle, and a full ECharts option is a wide surface: string tooltip formatters end up as
 * innerHTML, image fills and `image://` symbols fetch a URL when the chart draws (a request nobody asked
 * for, and a way to carry data out in its address), title links open windows, the toolbox brings a data
 * view with its own markup. A list of fields to delete would never be complete, and the next ECharts
 * release could add to it.
 *
 * So this module reads rather than filters. It takes the few things a bar or pie chart needs — a title,
 * category names, series names, numbers, a stack id, the axis names — checks each for type and size, and
 * returns them as a `ChartSpec` of plain strings and numbers. Nothing else in the block is looked at,
 * whatever it is. The option ECharts draws is built from the spec alone (chartOption.ts), in the app's
 * own colours.
 *
 * A block that cannot be read comes back with a reason in plain words; the chat then shows the block as
 * code, with the reason under it. Nothing here throws.
 */

export interface BarSeries {
  /** '' for the single series of a chart that does not name it. */
  name: string
  /** Series with the same stack id are drawn on top of each other. */
  stack?: string
  /** One per category; null where the block has no value. */
  values: (number | null)[]
}

export interface BarSpec {
  kind: 'bar'
  title: string
  subtitle: string
  /** Categories down the left and bars running right — the layout for long process names. */
  horizontal: boolean
  categories: string[]
  /** The value axis' name: usually the unit. */
  valueName: string
  categoryName: string
  series: BarSeries[]
}

export interface PieSpec {
  kind: 'pie'
  title: string
  subtitle: string
  /** The series name, shown in the tooltip. */
  name: string
  slices: { name: string; value: number }[]
}

export type ChartSpec = BarSpec | PieSpec

export type ChartRead =
  | {
      ok: true
      spec: ChartSpec
      /** Said under the chart: how it was drawn differently than asked. */ note?: string
    }
  | { ok: false; reason: string }

/** How much a chart may hold. A block over these is shown as code: past them a chart in a chat bubble
 *  stops being readable, and a block that large is more likely a mistake than a figure. */
export const CHART_LIMITS = {
  sourceChars: 20_000,
  categories: 40,
  series: 8,
  slices: 20,
  nameChars: 80,
  titleChars: 120,
  subtitleChars: 160
} as const

const KINDS = ['bar', 'pie'] as const

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** ECharts takes a component as an object or a list of them; a chat chart uses the first. */
const first = (v: unknown): Obj => (Array.isArray(v) ? (isObj(v[0]) ? v[0] : {}) : isObj(v) ? v : {})

/** Control characters, line and paragraph separators, and the bidi controls that let a name read
 *  differently on screen than it is stored. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g

/** A name as the chart prints it: one line, cut to `max` characters. Numbers are taken as their text
 *  (a year as a category); anything else is no name. */
export function chartText(v: unknown, max: number): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return ''
  const t = v.replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

const NUMERIC = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?\s*$/i

/** A plotted value: a finite number (or a number written as text), null for ECharts' "no value"
 *  (`null`, `"-"`, `""`), undefined for anything else. */
function num(v: unknown): number | null | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (v === null || v === '-' || v === '') return null
  if (typeof v === 'string' && NUMERIC.test(v)) {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** The value of a data item: ECharts takes it bare or as `{ value }`. */
const itemValue = (item: unknown): unknown => (isObj(item) ? item.value : item)

/** A model's word quoted inside one of our reasons — short, and on one line. */
const quoted = (v: unknown): string => `"${chartText(typeof v === 'string' ? v : String(v), 24)}"`

export function readChart(source: string): ChartRead {
  if (source.length > CHART_LIMITS.sourceChars) return { ok: false, reason: 'the block is too long to draw.' }
  let o: unknown
  try {
    o = JSON.parse(source)
  } catch {
    return { ok: false, reason: 'the block is not valid JSON.' }
  }
  if (!isObj(o)) return { ok: false, reason: 'the block is not a chart option (a JSON object).' }
  const series = (Array.isArray(o.series) ? o.series : [o.series]).filter(isObj)
  if (!series.length) return { ok: false, reason: 'the block has no series.' }
  const kinds = new Set<unknown>(series.map((s) => s.type))
  for (const k of kinds) {
    if (!KINDS.includes(k as (typeof KINDS)[number]))
      return {
        ok: false,
        reason:
          typeof k === 'string'
            ? `only bar and pie charts are drawn here, not ${quoted(k)}.`
            : 'every series needs "type": "bar" or "pie".'
      }
  }
  if (kinds.size > 1) return { ok: false, reason: 'the block mixes bar and pie series.' }
  const t = first(o.title)
  const title = chartText(t.text, CHART_LIMITS.titleChars)
  const subtitle = chartText(t.subtext, CHART_LIMITS.subtitleChars)
  return kinds.has('pie') ? readPie(series, title, subtitle) : readBar(o, series, title, subtitle)
}

function readBar(o: Obj, series: Obj[], title: string, subtitle: string): ChartRead {
  const x = first(o.xAxis)
  const y = first(o.yAxis)
  // ECharts' default is categories along x; they run down y when the block says so, when it makes x
  // the value axis and leaves y unsaid, or when only y carries the category names.
  const horizontal =
    y.type === 'category' ||
    (x.type === 'value' && y.type !== 'value') ||
    (Array.isArray(y.data) && !Array.isArray(x.data) && y.type !== 'value' && x.type !== 'category')
  const catAxis = horizontal ? y : x
  const valAxis = horizontal ? x : y
  let categories: string[]
  if (Array.isArray(catAxis.data)) {
    categories = catAxis.data.map((c) => chartText(itemValue(c), CHART_LIMITS.nameChars))
  } else {
    // Without axis data, ECharts names a category after the data item: `{ "name": …, "value": … }`.
    const items = Array.isArray(series[0].data) ? series[0].data : []
    if (!items.length || !items.every((d) => isObj(d) && chartText(d.name, 1)))
      return {
        ok: false,
        reason: `a bar chart needs its category names in ${horizontal ? 'yAxis' : 'xAxis'}.data.`
      }
    categories = items.map((d) => chartText((d as Obj).name, CHART_LIMITS.nameChars))
  }
  if (!categories.length) return { ok: false, reason: 'the chart has no categories.' }
  if (categories.length > CHART_LIMITS.categories)
    return {
      ok: false,
      reason: `${categories.length} categories are too many to draw (at most ${CHART_LIMITS.categories}).`
    }
  if (series.length > CHART_LIMITS.series)
    return {
      ok: false,
      reason: `${series.length} series are too many to draw (at most ${CHART_LIMITS.series}).`
    }
  const out: BarSeries[] = []
  for (const [i, s] of series.entries()) {
    const name = chartText(s.name, CHART_LIMITS.nameChars) || (series.length > 1 ? `Series ${i + 1}` : '')
    const label = name ? `series ${quoted(name)}` : 'the series'
    if (!Array.isArray(s.data)) return { ok: false, reason: `${label} has no data list.` }
    if (s.data.length > categories.length)
      return {
        ok: false,
        reason: `${label} has ${s.data.length} values for ${categories.length} categories.`
      }
    const values: (number | null)[] = []
    for (const item of s.data) {
      const v = num(itemValue(item))
      if (v === undefined) return { ok: false, reason: `${label} holds a value that is not a number.` }
      values.push(v)
    }
    // Fewer values than categories: the last categories have none, as ECharts draws it.
    while (values.length < categories.length) values.push(null)
    const stack = chartText(s.stack, 40)
    out.push(stack ? { name, stack, values } : { name, values })
  }
  if (out.every((s) => s.values.every((v) => v === null)))
    return { ok: false, reason: 'the chart has no numbers to draw.' }
  return {
    ok: true,
    spec: {
      kind: 'bar',
      title,
      subtitle,
      horizontal,
      categories,
      valueName: chartText(valAxis.name, 60),
      categoryName: chartText(catAxis.name, 60),
      series: out
    }
  }
}

function readPie(series: Obj[], title: string, subtitle: string): ChartRead {
  if (series.length > 1)
    return { ok: false, reason: `a pie chart takes one series; the block has ${series.length}.` }
  const s = series[0]
  if (!Array.isArray(s.data)) return { ok: false, reason: 'the pie has no data list.' }
  const slices: { name: string; value: number }[] = []
  for (const item of s.data) {
    const name = isObj(item) ? chartText(item.name, CHART_LIMITS.nameChars) : ''
    const value = num(itemValue(item))
    if (!name || value === undefined)
      return { ok: false, reason: 'each pie slice needs a "name" and a numeric "value".' }
    if (value !== null) slices.push({ name, value })
  }
  if (slices.length > CHART_LIMITS.slices)
    return {
      ok: false,
      reason: `${slices.length} slices are too many for a pie (at most ${CHART_LIMITS.slices}).`
    }
  if (!slices.some((sl) => sl.value !== 0)) return { ok: false, reason: 'the pie has no numbers to draw.' }
  const name = chartText(s.name, CHART_LIMITS.nameChars)
  // A share of a total cannot be negative, and a credit (recycling, energy recovered) is exactly what an
  // LCA answer may want to show. ECharts would draw the slice by its absolute size, as if it added to
  // the burden. The figures are the same as bars, so they are drawn as bars, and the chart says why.
  if (slices.some((sl) => sl.value < 0))
    return {
      ok: true,
      note: 'Drawn as bars: a pie chart cannot show negative values.',
      spec: {
        kind: 'bar',
        title,
        subtitle,
        horizontal: true,
        categories: slices.map((sl) => sl.name),
        valueName: '',
        categoryName: '',
        series: [{ name, values: slices.map((sl) => sl.value) }]
      }
    }
  return { ok: true, spec: { kind: 'pie', title, subtitle, name, slices } }
}
