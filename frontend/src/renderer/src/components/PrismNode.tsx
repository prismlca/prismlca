import { useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NODE_COLORS } from '../lib/palette'
import { LockIcon, TagIcon } from './icons'

/** The one React Flow node type PrismLCA uses: a process card with colour bar, tag chips,
 * expand/collapse badge and Sankey share. All interactivity is injected via callbacks on
 * `data` (see Workbench's nodeData) so the component itself stays stateless apart from the
 * colour-swatch popover. */
export default function PrismNode({ data, selected }: NodeProps): JSX.Element {
  const d = data as {
    label: string
    geo: string | null
    unit: string | null
    external: boolean
    readOnly: boolean
    share?: number
    upstream?: number
    expanded?: boolean
    color?: string
    tags?: { dimension: string; value: string; color: string; inherited?: boolean }[]
    highlight?: boolean
    onColor?: (c: string) => void
    onExpand?: () => void
    onCollapse?: () => void
    onTag?: (x: number, y: number) => void
    /** A box of an outside dataset can carry tags (lib/occurrences.ts); other read-only cards cannot. */
    taggable?: boolean
  }
  const hasShare = typeof d.share === 'number'
  const up = d.upstream ?? 0
  const expandable = up !== 0 // >0 = known count; -1 = reference, count unknown until expanded
  const [palette, setPalette] = useState(false)
  return (
    <div
      className={`pnode${d.readOnly ? ' external' : ''}${selected ? ' sel' : ''}${hasShare ? ' hot' : ''}${d.highlight ? ' hl' : ''}`}
    >
      {d.color ? <div className="pnode-color-bar" style={{ background: d.color }} /> : null}
      <button
        className="pnode-color-dot"
        title="Colour-code this process"
        style={d.color ? { background: d.color, borderColor: d.color } : undefined}
        onClick={(e) => {
          e.stopPropagation()
          setPalette((v) => !v)
        }}
      />
      {!d.readOnly || d.taggable ? (
        <button
          className="pnode-tag-btn"
          title="Assign tags"
          onClick={(e) => {
            e.stopPropagation()
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            d.onTag?.(r.left, r.bottom + 4)
          }}
        >
          {/* The monochrome icon, not the 🏷 emoji: an emoji is drawn by the system in its own colours, which
              on the dark canvas came out as a dim brown smudge. This one follows `currentColor`, so it
              takes the same grey as the ring of the colour dot beside it — the two read as one pair of
              controls, in both themes. */}
          <TagIcon />
        </button>
      ) : null}
      {palette ? (
        <div className="pnode-palette" onClick={(e) => e.stopPropagation()}>
          {NODE_COLORS.map((c) => (
            <button
              key={c}
              className={`pnode-swatch${d.color === c ? ' on' : ''}`}
              style={{ background: c }}
              title={c}
              onClick={(e) => {
                e.stopPropagation()
                d.onColor?.(d.color === c ? '' : c) // click the active colour again to clear
                setPalette(false)
              }}
            />
          ))}
        </div>
      ) : null}
      <Handle type="target" position={Position.Left} />
      <div className="pnode-title" title={d.label}>
        {d.readOnly ? (
          <>
            <LockIcon />{' '}
          </>
        ) : null}
        {d.label}
        {hasShare ? <span className="share">{Math.round((d.share as number) * 100)}%</span> : null}
      </div>
      <div className="pnode-meta">
        {d.geo ?? '—'}
        {d.unit ? ` · ${d.unit}` : ''}
      </div>
      {d.tags && d.tags.length ? (
        <div className="pnode-tags">
          {d.tags.map((t) => (
            <span
              key={`${t.dimension}/${t.value}`}
              className={t.inherited ? 'pnode-tag inherited' : 'pnode-tag'}
              style={{ borderColor: t.color, color: t.color }}
              title={`${t.dimension}: ${t.value}${t.inherited ? ' (inherited, not set on this input)' : ''}`}
            >
              {t.value}
            </span>
          ))}
        </div>
      ) : null}
      {d.expanded ? (
        <button
          className="pnode-expand"
          title="Collapse the upstream inputs revealed here"
          onClick={(e) => {
            e.stopPropagation()
            d.onCollapse?.()
          }}
        >
          −
        </button>
      ) : expandable ? (
        <button
          className="pnode-expand"
          // The count used to be printed on the button, so some nodes wore a number and some did
          // not and the row of them read unevenly. It is worth knowing but not worth a
          // permanent digit on the canvas, so it moved into the tooltip.
          title={up > 0 ? `Expand ${up} upstream input${up === 1 ? '' : 's'}` : 'Expand upstream inputs'}
          onClick={(e) => {
            e.stopPropagation()
            d.onExpand?.()
          }}
        >
          {/* A bare + and −, not ⊕/⊖: the button is already a circle, so the ring in the glyph drew
              a second one inside it. */}
          +
        </button>
      ) : null}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
