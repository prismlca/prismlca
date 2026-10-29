import { memo, useLayoutEffect, useRef, useState } from 'react'
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useSettings } from '../lib/settings'

/** A product name longer than this is cut to this length, ellipsis included; the whole name is in the
 *  label's tooltip. Short, because the label sits on the arrow and a long one covers its neighbours. */
export const PRODUCT_MAX = 20

/**
 * A canvas arrow: the same curve as React Flow's default edge, with a label of up to two lines — the amount
 * with its unit, and under it the product the arrow carries. Each line has its switch under Settings →
 * Modelling; with both off the arrow has no label.
 *
 * The default edge letters its label as a single SVG text, which cannot break a line, so the label is drawn
 * here — with the default's own class names, so the chip's paper and its highlighted (`hot`) look in
 * `canvas.css` apply unchanged; the lettering of both lines is `prism-edge-label`'s, small and grey.
 */
function PrismEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  data,
  style,
  markerEnd,
  interactionWidth
}: EdgeProps): JSX.Element {
  const { modelling } = useSettings()
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })
  const amount = modelling.edgeAmounts && typeof label === 'string' ? label : ''
  const product = modelling.edgeProducts ? String((data as { product?: string | null })?.product ?? '') : ''
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      {amount || product ? <EdgeLabel x={labelX} y={labelY} amount={amount} product={product} /> : null}
    </>
  )
}

/** The label chip: centred on the arrow's midpoint, its paper sized from what the text measures. */
function EdgeLabel({
  x,
  y,
  amount,
  product
}: {
  x: number
  y: number
  amount: string
  product: string
}): JSX.Element {
  const ref = useRef<SVGTextElement>(null)
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const short = product.length > PRODUCT_MAX ? `${product.slice(0, PRODUCT_MAX - 1).trimEnd()}…` : product
  useLayoutEffect(() => {
    const el = ref.current
    // jsdom has no layout: no box there, and the label simply goes without its paper.
    if (el && typeof el.getBBox === 'function') {
      const b = el.getBBox()
      setBox({ x: b.x, y: b.y, width: b.width, height: b.height })
    }
  }, [amount, short])
  const two = Boolean(amount && short)
  return (
    <g transform={`translate(${x} ${y})`} className="react-flow__edge-textwrapper">
      {product ? <title>{product}</title> : null}
      {box ? (
        <rect
          className="react-flow__edge-textbg"
          x={box.x - 4}
          y={box.y - 2}
          width={box.width + 8}
          height={box.height + 4}
          rx={2}
          ry={2}
        />
      ) : null}
      {/* Baselines placed so one line sits on the arrow and two lines straddle it. */}
      <text ref={ref} className="react-flow__edge-text prism-edge-label" textAnchor="middle">
        {amount ? (
          <tspan x={0} dy={two ? '-0.25em' : '0.35em'}>
            {amount}
          </tspan>
        ) : null}
        {short ? (
          <tspan x={0} dy={two ? '1.15em' : '0.35em'}>
            {short}
          </tspan>
        ) : null}
      </text>
    </g>
  )
}

export default memo(PrismEdge)
