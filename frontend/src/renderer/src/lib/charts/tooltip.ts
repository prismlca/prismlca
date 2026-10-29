/**
 * Tooltips of the on-screen charts (Results page).
 *
 * Placement: ECharts places a tooltip against the CHART's box, not the window. A Results chart is a
 * third of the page wide, so a tooltip wider than the room right of the mouse flipped to the left of it
 * by its whole width — out past the chart's left edge and, on the first column, under the side bar.
 * `tooltipBeside` hangs the tooltip on <body> and places it against the window:
 * right of the mouse when it fits, left when it does not, and always inside the window.
 *
 * Content: a stacked bar split by CPC carries a hundred and more classes, and the default axis tooltip
 * listed every one of them, zeros included, with names of eighty characters. `stackTooltipHtml` lists
 * the biggest few and sums the rest.
 *
 * Numbers: a tooltip used to print the raw float — "51.93827462 kg", and in the heatmap worse. `tipValue`
 * gives four significant figures, exponential only at extreme magnitudes (`fmtSig`, as the canvas does).
 */
import * as echarts from 'echarts'
import { fmtSig } from '../settings'

/** Significant figures of a value in a chart tooltip. */
export const TIP_DIGITS = 4

/** A value as a tooltip prints it, with its unit. */
export function tipValue(v: number, unit: string): string {
  return `${fmtSig(v, TIP_DIGITS)} ${unit}`.trim()
}

/** Room kept between the tooltip and the mouse, and between the tooltip and the window's edge. */
const GAP = 14
const MARGIN = 8

/** The `tooltip` fields that place a chart's tooltip beside the mouse, inside the window. */
export function tooltipBeside(el: HTMLElement): {
  appendTo: string
  position: (point: number[], ...rest: unknown[]) => [number, number]
} {
  return {
    appendTo: 'body',
    // ECharts hands the mouse in chart coordinates and expects the answer in them too; the window is
    // what the tooltip has to fit, so the sums are done there and translated back.
    position: (point, ...rest) => {
      const size = rest[3] as { contentSize: number[] }
      const box = el.getBoundingClientRect()
      return placeBeside(
        [box.left + point[0], box.top + point[1]],
        [size.contentSize[0], size.contentSize[1]],
        [window.innerWidth, window.innerHeight]
      ).map((v, i) => v - (i ? box.top : box.left)) as [number, number]
    }
  }
}

/** Where a box of `size` goes beside the `mouse`, in window coordinates: right of and below the mouse
 *  when it fits, otherwise on the other side, and clamped into the window either way. */
export function placeBeside(mouse: number[], size: number[], view: number[]): [number, number] {
  const side = (m: number, s: number, v: number): number => {
    const p = m + GAP + s <= v - MARGIN ? m + GAP : m - GAP - s
    return Math.max(MARGIN, Math.min(p, v - MARGIN - s))
  }
  return [side(mouse[0], size[0], view[0]), side(mouse[1], size[1], view[1])]
}

/** How many segments a stacked bar's tooltip lists before it sums the rest. */
export const STACK_TIP_ROWS = 12
/** Characters of a class name the tooltip shows; a CPC name runs to eighty. */
const NAME_CHARS = 48

interface AxisParam {
  seriesName?: string
  value?: unknown
  marker?: unknown
  axisValueLabel?: string
}

/**
 * The tooltip of one stacked bar: the subject, its biggest segments by absolute size with their values,
 * "+N more" with what they add up to, and the total. Segments that are zero for this bar are left out.
 * `fmt` turns a plotted value back into the text the reader sees (the chart may plot scaled values).
 */
export function stackTooltipHtml(params: AxisParam | AxisParam[], fmt: (v: number) => string): string {
  const list = (Array.isArray(params) ? params : [params]).filter(
    (p) => p.seriesName && typeof p.value === 'number' && p.value !== 0
  )
  const enc = echarts.format.encodeHTML
  const head = (Array.isArray(params) ? params[0] : params)?.axisValueLabel ?? ''
  const rows = [...list].sort((a, b) => Math.abs(b.value as number) - Math.abs(a.value as number))
  const shown = rows.slice(0, STACK_TIP_ROWS)
  const rest = rows.slice(STACK_TIP_ROWS)
  const total = rows.reduce((s, p) => s + (p.value as number), 0)
  const line = (left: string, right: string, strong = false): string =>
    `<div style="display:flex;justify-content:space-between;gap:16px${strong ? ';font-weight:600' : ''}">` +
    `<span>${left}</span><span>${right}</span></div>`
  const name = (n: string): string => enc(n.length > NAME_CHARS ? `${n.slice(0, NAME_CHARS - 1)}…` : n)
  return [
    `<div style="font-weight:600;margin-bottom:4px">${enc(head)}</div>`,
    ...shown.map((p) =>
      line(`${typeof p.marker === 'string' ? p.marker : ''}${name(p.seriesName!)}`, fmt(p.value as number))
    ),
    ...(rest.length
      ? [line(`+${rest.length} more`, fmt(rest.reduce((s, p) => s + (p.value as number), 0)))]
      : []),
    `<div style="border-top:1px solid rgba(140,148,160,0.35);margin-top:4px;padding-top:4px">${line('Total', fmt(total), true)}</div>`
  ].join('')
}
