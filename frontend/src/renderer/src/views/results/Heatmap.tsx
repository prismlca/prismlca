import { useEffect } from 'react'
import { subjectKey } from '../../lib/subjectKey'
import { HEAT_GRADIENT, HEAT_STOPS, heatColor } from '../../lib/heat'
import { type ChartRegistry } from '../../lib/charts/useEChart'
import { tipValue } from '../../lib/charts/tooltip'
import type { Matrix, Picked } from './types'

/** `text` as it fits into `max` px in the context's current font: whole, or cut at a character and
 *  ended with an ellipsis. */
function fitText(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let n = text.length
  while (n > 1 && ctx.measureText(text.slice(0, n).trimEnd() + '…').width > max) n -= 1
  return text.slice(0, n).trimEnd() + '…'
}

/** Render the heatmap to a PNG data-URL on an offscreen canvas (it's an HTML table, not echarts).
 *  Frozen LIGHT palette on purpose: this is an export for reports/slides, and the picture must not
 *  depend on whoever exported it having dark mode on. The on-screen heatmap is the HTML table,
 *  styled by index.css with theme tokens. */
function renderHeatmapPng(
  groups: { family: string; items: Picked[] }[],
  columns: Picked[],
  matrix: Matrix
): string {
  const PR = 2
  const cellW = 46
  const cellH = 26
  // The subject column fits the longest name, within bounds. At a fixed 200 px every name past ~30
  // characters was cut mid-word — and the cut-off end ("… — Glass bottle 500 ml", a scenario) is what
  // tells two subjects apart. Past the cap a name ends in an ellipsis instead of a hard cut.
  const SUBJ_FONT = 'bold 12px sans-serif'
  const measure = document.createElement('canvas').getContext('2d')
  if (measure) measure.font = SUBJ_FONT
  const widest = measure ? Math.max(0, ...matrix.subjects.map((s) => measure.measureText(s.label).width)) : 0
  const subjW = Math.min(480, Math.max(200, Math.ceil(widest) + 16))
  const famH = 22
  const hdrH = 162
  const pad = 8
  // The colour scale under the rows: a gap above, then the bar with its two words.
  const scaleH = 30
  const W = subjW + columns.length * cellW + pad * 2
  const H = famH + hdrH + matrix.subjects.length * cellH + scaleH + pad * 2
  const cv = document.createElement('canvas')
  cv.width = W * PR
  cv.height = H * PR
  const ctx = cv.getContext('2d')
  if (!ctx) return ''
  ctx.scale(PR, PR)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.textBaseline = 'middle'
  const maxes = columns.map(
    (c) => Math.max(...matrix.subjects.map((s) => Math.abs(s.scores[c.key] ?? 0)), 0) || 1
  )
  const gx = pad + subjW
  const gy = pad + famH + hdrH

  // Subject corner.
  ctx.fillStyle = '#2f4e66'
  ctx.fillRect(pad, pad, subjW, famH + hdrH)
  ctx.fillStyle = '#fff'
  ctx.textAlign = 'left'
  ctx.font = 'bold 12px sans-serif'
  ctx.fillText('Subject', pad + 8, pad + famH / 2)

  // Family header spans.
  let cx = gx
  let i = 0
  while (i < columns.length) {
    const fam = columns[i].family
    let span = 1
    while (i + span < columns.length && columns[i + span].family === fam) span += 1
    const w = span * cellW
    ctx.fillStyle = '#2f4e66'
    ctx.fillRect(cx, pad, w, famH)
    ctx.save()
    ctx.beginPath()
    ctx.rect(cx, pad, w, famH)
    ctx.clip()
    ctx.fillStyle = '#fff'
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(fam, cx + w / 2, pad + famH / 2)
    ctx.restore()
    cx += w
    i += span
  }

  // Vertical indicator headers.
  columns.forEach((p, ci) => {
    const x = gx + ci * cellW
    ctx.fillStyle = '#f2f2f2'
    ctx.fillRect(x, pad + famH, cellW, hdrH)
    ctx.strokeStyle = '#dddddd'
    ctx.strokeRect(x, pad + famH, cellW, hdrH)
    ctx.save()
    ctx.translate(x + cellW / 2 + 4, pad + famH + hdrH - 6)
    ctx.rotate(-Math.PI / 2)
    ctx.fillStyle = '#2f4e66'
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(p.label.length > 30 ? p.label.slice(0, 29) + '…' : p.label, 0, 0)
    ctx.restore()
  })

  // Rows.
  matrix.subjects.forEach((s, ri) => {
    const y = gy + ri * cellH
    ctx.fillStyle = ri % 2 ? '#f7f7f7' : '#ffffff'
    ctx.fillRect(pad, y, subjW, cellH)
    ctx.strokeStyle = '#eeeeee'
    ctx.strokeRect(pad, y, subjW, cellH)
    ctx.save()
    ctx.beginPath()
    ctx.rect(pad, y, subjW, cellH)
    ctx.clip()
    ctx.fillStyle = '#303030'
    ctx.font = SUBJ_FONT
    ctx.textAlign = 'left'
    ctx.fillText(fitText(ctx, s.label, subjW - 16), pad + 8, y + cellH / 2)
    ctx.restore()
    columns.forEach((p, ci) => {
      const x = gx + ci * cellW
      const v = s.scores[p.key] ?? 0
      const t = Math.abs(v) / maxes[ci]
      ctx.fillStyle = heatColor(t)
      ctx.fillRect(x, y, cellW, cellH)
      ctx.strokeStyle = '#dddddd'
      ctx.strokeRect(x, y, cellW, cellH)
      ctx.fillStyle = '#303030'
      ctx.font = '600 11px sans-serif'
      ctx.textAlign = 'center'
      // Colour by magnitude, label with the sign: a credit and a burden of equal size were identical
      // cells, on screen and in the PNG.
      ctx.fillText(`${v < 0 ? '−' : ''}${Math.round(t * 100)}%`, x + cellW / 2, y + cellH / 2)
    })
  })

  // Colour scale: "Lower impact" — ramp — "Higher impact". Same picture as the HeatScale in the panel's
  // sub-heading, so the export explains itself the way the panel does.
  const sy = gy + matrix.subjects.length * cellH + 16
  const endW = 78
  const barX = pad + endW
  const barW = W - pad * 2 - endW * 2
  const barH = 10
  const ramp = ctx.createLinearGradient(barX, 0, barX + barW, 0)
  HEAT_STOPS.forEach(([r, g, b], si) =>
    ramp.addColorStop(si / (HEAT_STOPS.length - 1), `rgb(${r}, ${g}, ${b})`)
  )
  ctx.fillStyle = ramp
  ctx.fillRect(barX, sy, barW, barH)
  ctx.strokeStyle = '#dddddd'
  ctx.strokeRect(barX, sy, barW, barH)
  ctx.fillStyle = '#5c6b78'
  ctx.font = '11px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText('Lower impact', pad, sy + barH / 2)
  ctx.textAlign = 'right'
  ctx.fillText('Higher impact', W - pad, sy + barH / 2)
  return cv.toDataURL('image/png')
}

/** The reading key of the heatmap, right of its sub-heading: the ramp as one short bar, "Lower impact" to
 * "Higher impact", and nothing else — the two words are the reading, tick percentages under a bar this short
 * only cluttered it. A cell's colour is only meaningful next to the ramp it
 * was taken from; without this bar a first-time reader has to guess whether pale or deep means more. */
export function HeatScale(): JSX.Element {
  return (
    <div className="heat-scale" aria-label="Colour scale: share of the highest subject per indicator">
      <span className="heat-scale-end">Lower impact</span>
      <div className="heat-scale-ramp" style={{ background: HEAT_GRADIENT }} />
      <span className="heat-scale-end">Higher impact</span>
    </div>
  )
}

/** Heatmap table: subjects × indicators, each cell coloured by its value relative to that
 * indicator's maximum across the compared subjects (per-column normalization). */
export function Heatmap({
  groups,
  columns,
  matrix,
  registry
}: {
  groups: { family: string; items: Picked[] }[]
  columns: Picked[]
  matrix: Matrix
  registry: ChartRegistry
}): JSX.Element {
  const maxes = columns.map(
    (c) => Math.max(...matrix.subjects.map((s) => Math.abs(s.scores[c.key] ?? 0)), 0) || 1
  )
  useEffect(() => {
    const reg = registry.current // bound per effect run; the cleanup must delete from the same map
    reg.set('heatmap', () => renderHeatmapPng(groups, columns, matrix))
    return () => {
      reg.delete('heatmap')
    }
  }, [groups, columns, matrix, registry])
  return (
    <div className="heatmap-wrap">
      <table className="results-table heatmap">
        <thead>
          <tr>
            <th rowSpan={2}>Subject</th>
            {groups.map((g) => (
              <th key={g.family} className="th-family" colSpan={g.items.length} title={g.family}>
                {g.family}
              </th>
            ))}
          </tr>
          <tr>
            {columns.map((p, i) => (
              <th
                key={p.key}
                title={`${p.family} · ${p.detail || p.label} [${p.unit}]`}
                className={i > 0 && columns[i - 1].family !== p.family ? 'fam-start' : undefined}
              >
                <span className="th-ind">{p.label}</span>
                <span className="th-unit">{p.unit}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.subjects.map((s) => (
            <tr key={subjectKey(s, null)}>
              <td className="td-subj" title={s.label}>
                {s.label}
              </td>
              {columns.map((p, i) => {
                const v = s.scores[p.key] ?? 0
                const t = Math.abs(v) / maxes[i]
                return (
                  <td
                    key={p.key}
                    className={`heat-cell${i > 0 && columns[i - 1].family !== p.family ? ' fam-start' : ''}`}
                    style={{ background: heatColor(t) }}
                    title={tipValue(v, p.unit)}
                  >
                    {Math.round(t * 100)}%
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
