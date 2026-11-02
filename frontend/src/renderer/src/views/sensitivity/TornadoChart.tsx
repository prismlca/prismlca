import { useRef } from 'react'
import { cssVar } from '../../lib/cssVar'
import { useEChart, type ChartRegistry } from '../../lib/charts/useEChart'
import { escapeHtml, tooltipBeside } from '../../lib/charts/tooltip'
import { breakNote, fmtValue, pctLabel, pctOf, signedPct, stepPct } from './helpers'
import type { TornadoEntry } from './types'

/** Row height of one bar, label included. */
const ROW = 34

/**
 * The tornado: one row per parameter, its two bars running from the result (0 %) to where the result moves
 * when the parameter goes down (blue) and up (purple) by the range.
 *
 * The two bars of a row share one slot (`barGap: -100%`). Usually they point in opposite directions; when
 * both move the result the same way, the longer is drawn behind the shorter, so neither hides the other —
 * which is why the series are "longer" and "shorter" rather than "down" and "up", and each bar carries its
 * own colour. The legend is the card's, in HTML.
 */
export function TornadoChart({
  regId,
  registry,
  themeKey,
  entries,
  mi,
  baseline,
  unit,
  delta,
  units,
  onPick
}: {
  regId: string
  registry: ChartRegistry
  themeKey: string
  /** The rows to draw, largest swing first. */
  entries: TornadoEntry[]
  /** Which indicator of the run. */
  mi: number
  baseline: number
  unit: string
  delta: number
  /** Parameter → unit, for the second line of each label. */
  units: Record<string, string>
  onPick?: (param: string) => void
}): JSX.Element {
  // The chart is built when its data changes, not on every render; a click must reach the page's current
  // handler, which knows the parameters as they are now, not the one from when the chart was built.
  const pick = useRef(onPick)
  pick.current = onPick
  const ref = useEChart(
    regId,
    registry,
    (el) => {
      const ink = cssVar('--ink', '#26313a')
      const faint = cssVar('--faint', '#8b968f')
      const border = cssVar('--border', '#e0e4dd')
      const surface = cssVar('--surface', '#ffffff')
      const colour = { low: cssVar('--info', '#1779ba'), high: cssVar('--purple', '#9f5987') }
      // In percent of the result — unless the result is 0 (burdens and credits cancelling), where a percentage
      // does not exist and every bar would be drawn as zero: then the change itself, in the result's unit.
      const rel = baseline !== 0
      const change = (score: number): number => (rel ? pctOf(score, baseline) : score - baseline)
      const fmtChange = (c: number): string =>
        rel ? signedPct(c) : `${c > 0 ? '+' : c < 0 ? '−' : ''}${fmtValue(Math.abs(c))} ${unit}`
      const bars = entries.map((e) => {
        const low = { side: 'low' as const, p: change(e.low[mi]) }
        const high = { side: 'high' as const, p: change(e.high[mi]) }
        return Math.abs(low.p) >= Math.abs(high.p) ? [low, high] : [high, low]
      })
      const item = (b: { side: 'low' | 'high'; p: number }, row: number, front: boolean) => ({
        value: b.p,
        itemStyle: {
          color: colour[b.side],
          borderRadius: b.p < 0 ? [4, 0, 0, 4] : [0, 4, 4, 0],
          // A ring on the shorter bar only where it lies on the longer one.
          ...(front && Math.sign(b.p) === Math.sign(bars[row][0].p)
            ? { borderColor: surface, borderWidth: 2 }
            : {})
        },
        label: {
          show: row < 3 && b.p !== 0,
          position: b.p < 0 ? 'left' : 'right',
          formatter: () => fmtChange(b.p),
          color: faint,
          fontSize: 11
        }
      })
      const byName = new Map(entries.map((e) => [e.param, e]))
      const pad = (v: { min: number; max: number }): number =>
        (Math.max(v.max, 0) - Math.min(v.min, 0)) * 0.28 || 1
      const tip = (row: number): string => {
        const e = entries[row]
        const u = units[e.param] ? ` ${escapeHtml(units[e.param])}` : ''
        const side = (s: 'low' | 'high'): string => {
          const v = s === 'low' ? e.low_value : e.high_value
          const score = s === 'low' ? e.low[mi] : e.high[mi]
          const step = e.limited?.[s]
            ? `${signedPct(stepPct(e, s))}*`
            : `${s === 'low' ? '−' : '+'}${pctLabel(delta)} %`
          return `<tr><td>${step} → ${fmtValue(v)}${u}</td><td style="padding-left:12px">${fmtValue(score)} ${escapeHtml(unit)} (${escapeHtml(fmtChange(change(score)))})</td></tr>`
        }
        const rule =
          (e.limited
            ? `<div style="margin-top:4px">* ${escapeHtml(e.limited.low ?? e.limited.high ?? '')}</div>`
            : '') + (e.breaks ? `<div style="margin-top:4px">! ${escapeHtml(breakNote(e, delta))}</div>` : '')
        return (
          `<b>${escapeHtml(e.param)}</b>` +
          `<div>Base value ${fmtValue(e.base)}${u}</div><table>${side('low')}${side('high')}</table>${rule}` +
          (onPick ? '<div style="margin-top:4px;opacity:.75">Click to plot it as a curve</div>' : '')
        )
      }
      return {
        animation: false,
        grid: { left: 8, right: 56, top: 6, bottom: 34, containLabel: true },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          ...tooltipBeside(el),
          formatter: (params: { dataIndex: number } | { dataIndex: number }[]) =>
            tip((Array.isArray(params) ? params[0] : params).dataIndex)
        },
        xAxis: {
          type: 'value',
          name: rel ? 'Change of the result' : `Change of the result (${unit}; the result is 0)`,
          nameLocation: 'middle',
          nameGap: 24,
          nameTextStyle: { color: faint, fontSize: 11 },
          // Room beyond the longest bar on both sides, for the value printed at its end.
          min: (v: { min: number; max: number }) => Math.min(0, v.min) - pad(v),
          max: (v: { min: number; max: number }) => Math.max(0, v.max) + pad(v),
          axisLabel: {
            color: faint,
            showMinLabel: false,
            showMaxLabel: false,
            formatter: (v: number) =>
              v ? `${v > 0 ? '+' : '−'}${+Math.abs(v).toPrecision(3)}${rel ? ' %' : ''}` : '0'
          },
          splitLine: { lineStyle: { type: 'dashed', color: border } }
        },
        yAxis: {
          type: 'category',
          inverse: true,
          data: entries.map((e) => e.param),
          axisTick: { show: false },
          axisLine: { show: false },
          axisLabel: {
            width: 190,
            overflow: 'truncate',
            formatter: (name: string) => {
              const e = byName.get(name)
              const star = `${e?.limited ? '*' : ''}${e?.breaks ? '!' : ''}`
              const sub = e ? `${fmtValue(e.base)}${units[name] ? ` ${units[name]}` : ''}` : ''
              return `{n|${name}${star}}\n{s|${sub}}`
            },
            rich: {
              n: { fontSize: 12, color: ink },
              s: { fontSize: 10, color: faint, padding: [2, 0, 0, 0] }
            }
          }
        },
        series: [
          {
            type: 'bar',
            data: bars.map((b, i) => item(b[0], i, false)),
            barWidth: 12,
            barGap: '-100%',
            z: 2
          },
          {
            type: 'bar',
            data: bars.map((b, i) => item(b[1], i, true)),
            barWidth: 12,
            z: 3,
            markLine: {
              silent: true,
              symbol: 'none',
              label: { show: false },
              lineStyle: { color: ink, width: 1, type: 'solid', opacity: 0.6 },
              data: [{ xAxis: 0 }]
            }
          }
        ]
      }
    },
    [entries, mi, baseline, unit, delta, units, themeKey, !!onPick],
    (chart) => {
      chart.on('click', (p) => {
        const param = entries[p.dataIndex]?.param
        if (param) pick.current?.(param)
      })
    }
  )
  return <div ref={ref} className="sens-tornado-canvas" style={{ height: entries.length * ROW + 52 }} />
}
