/**
 * Thumbnails of the two optional comparison figures, for the hover over their checkboxes.
 *
 * "Heatmap of every indicator" and "Radar across the indicators" are names for shapes: a reader who
 * has not seen either printed cannot tell from the words which one answers their question. The
 * thumbnail answers it in the shape alone — which is why the numbers in it are INVENTED and fixed.
 * At this size no value is legible anyway, and inventing them keeps the preview instant, identical
 * on every report, and honest: nobody can mistake it for their own data.
 *
 * Six indicators, four variants, because that is what makes the two shapes tell themselves apart —
 * a radar over three axes is a triangle, and a heatmap of two columns is a pair of chips.
 */

/** Fixed, made-up intensities: four variants (rows) × six indicators (columns), 0…1. */
const CELLS: number[][] = [
  [0.95, 0.42, 0.68, 0.2, 0.55, 0.8],
  [0.6, 0.88, 0.35, 0.72, 0.25, 0.5],
  [0.3, 0.55, 0.92, 0.45, 0.78, 0.15],
  [0.75, 0.2, 0.5, 0.95, 0.4, 0.65]
]

/** Four made-up profiles over the same six axes, 0…1 from the centre. */
const PROFILES: number[][] = [
  [0.9, 0.55, 0.7, 0.35, 0.8, 0.5],
  [0.45, 0.85, 0.4, 0.75, 0.35, 0.7],
  [0.65, 0.3, 0.95, 0.5, 0.6, 0.25]
]

const COL = 13
const ROW = 11

export function HeatmapPreview(): JSX.Element {
  const w = CELLS[0].length * COL
  const h = CELLS.length * ROW
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="presentation">
      {CELLS.map((row, r) =>
        row.map((v, c) => (
          <rect
            key={`${r}-${c}`}
            x={c * COL + 1}
            y={r * ROW + 1}
            width={COL - 2}
            height={ROW - 2}
            className="figpre-cell"
            opacity={0.15 + v * 0.85}
          />
        ))
      )}
    </svg>
  )
}

/** Points of a closed profile on six axes, laid out clockwise from the top. */
function polygon(values: number[], cx: number, cy: number, r: number): string {
  return values
    .map((v, i) => {
      const a = (Math.PI * 2 * i) / values.length - Math.PI / 2
      return `${(cx + Math.cos(a) * r * v).toFixed(1)},${(cy + Math.sin(a) * r * v).toFixed(1)}`
    })
    .join(' ')
}

export function RadarPreview(): JSX.Element {
  const size = 74
  const c = size / 2
  const r = c - 3
  const axes = PROFILES[0].map((_, i) => {
    const a = (Math.PI * 2 * i) / PROFILES[0].length - Math.PI / 2
    return { x: c + Math.cos(a) * r, y: c + Math.sin(a) * r }
  })
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="presentation">
      {/* The web: the outer hexagon, one ring inside it, and a spoke per indicator. */}
      <polygon
        points={polygon(
          axes.map(() => 1),
          c,
          c,
          r
        )}
        className="figpre-web"
      />
      <polygon
        points={polygon(
          axes.map(() => 0.55),
          c,
          c,
          r
        )}
        className="figpre-web"
      />
      {axes.map((p, i) => (
        <line key={i} x1={c} y1={c} x2={p.x} y2={p.y} className="figpre-web" />
      ))}
      {PROFILES.map((values, i) => (
        <polygon key={i} points={polygon(values, c, c, r)} className={`figpre-profile p${i}`} />
      ))}
    </svg>
  )
}
