import { MarkerType, type Edge } from '@xyflow/react'

/** Canvas node ids are `<database>/<code>`. Database names never contain `/` (guarded at
 * creation), but codes may — so split on the FIRST slash only. A box of an outside dataset may carry an
 * occurrence after the code (lib/occurrences.ts): `#<12 hex>` for its tags, `#new-<n>` for a copy, or
 * `#<parent id>` under an expanded box. Only those are cut off — a process code may contain `#` itself. */
export function splitId(id: string): [string, string] {
  const i = id.indexOf('/')
  const rest = id.slice(i + 1)
  const m = /^(.*?)#([0-9a-f]{12}|new-\d+|[^#]*\/.*)$/.exec(rest)
  return [id.slice(0, i), m ? m[1] : rest]
}

// React Flow renders arrowheads with markerUnits="strokeWidth", so they scale with the line — the
// Sankey overlay's thick flows would get huge arrowheads. Size the marker inversely so the tip
// stays a roughly constant ~26px regardless of flow thickness.
export function arrowSize(strokeWidth: number): number {
  return Math.max(4, Math.min(16, Math.round(26 / strokeWidth)))
}

export const ARROW_COLOR = '#8a94a0'

/** Mouse buttons that pan the canvas on drag (React Flow's `panOnDrag`) — the middle one, alone.
 *
 * Left (0) is absent because left-drag draws the selection box, and the right button was taken out
 * because it is the canvas context menu: empty canvas, group box and node each open a different one.
 * While the right button also panned, React Flow had to swallow the pane's `contextmenu` and re-fire
 * the menu from the end of a pan that had not moved — one button serving two gestures. Panning
 * without a wheel still works: holding Space turns any drag into a pan (`panActivationKeyCode`).
 *
 * A module-level constant rather than an inline literal so its identity is stable: React Flow
 * reconfigures its pan/zoom handler whenever this array changes, which a fresh `[1]` per render is. */
export const PAN_BUTTONS: number[] = [1]

/** The pan buttons while the hand tool is on: the left button joins the middle one, so a plain drag moves
 * the canvas — on the empty pane and on a process card alike (`nodesDraggable` is off in that mode). The
 * right button stays out for the same reason as above: it is the context menu. A constant for the same
 * identity reason as `PAN_BUTTONS`. */
export const HAND_PAN_BUTTONS: number[] = [0, 1]

export const arrowMarker = (strokeWidth: number, color: string = ARROW_COLOR): Edge['markerEnd'] => ({
  type: MarkerType.ArrowClosed,
  width: arrowSize(strokeWidth),
  height: arrowSize(strokeWidth),
  color
})

/** The green of the highlighted arrows. A CSS variable rather than a hex value so the arrowhead follows the
 * theme like the rest of the canvas: React Flow writes the marker colour into an inline `fill`, where a
 * `var()` resolves as it would anywhere else (the marker id it builds from the colour is quoted in the
 * `url('#…')` reference, so the brackets do no harm). */
export const HOT_COLOR = 'var(--green)'
/** How much thicker a highlighted arrow is drawn than its resting width. */
export const HOT_EXTRA_WIDTH = 1.2

/** Mark the arrows of the highlighted processes — the hovered node and every selected one — so they
 * read as belonging to it: green, a little thicker, above their neighbours, and with the `hot` class
 * the amount chip is styled by. Only the arrows touching a highlighted node directly, not the chain
 * behind them. Returns the same array when nothing is highlighted, so React Flow
 * sees no change. */
export function highlightEdges(edges: Edge[], hot: ReadonlySet<string>): Edge[] {
  if (!hot.size) return edges
  return edges.map((e) => {
    if (!hot.has(e.source) && !hot.has(e.target)) return e
    const base = Number(e.style?.strokeWidth ?? 1.6)
    const w = base + HOT_EXTRA_WIDTH
    return {
      ...e,
      className: e.className ? `${e.className} hot` : 'hot',
      zIndex: (e.zIndex ?? 20) + 1,
      style: { ...e.style, stroke: HOT_COLOR, strokeWidth: w },
      markerEnd: arrowMarker(base, HOT_COLOR) // sized from the resting width so the tip does not jump
    }
  })
}

/** Minimal shape of a compact contribution-tree node (`meta+lookups+tree` envelope) as far as
 * the Sankey overlay needs it. `db` is absent in results from backends predating its addition —
 * fall back to the calculated database then. */
export interface ShareTreeNode {
  db?: string
  c: string
  shr: number
  ch?: ShareTreeNode[]
}

/** Flatten a contribution tree into per-activity shares keyed by the full `db/code` canvas id.
 *
 * Keys carry the database because codes alone can collide between the foreground model and a
 * background database. A process reached through several branches (e.g. electricity feeding two
 * inputs) appears once per branch with disjoint contributions — sum them so the overlay shows
 * the activity's total flow-through, not whichever branch the walk visited last. */
export function collectShares(tree: ShareTreeNode, fallbackDb: string): Record<string, number> {
  const shares: Record<string, number> = {}
  const walk = (n: ShareTreeNode): void => {
    const id = `${n.db ?? fallbackDb}/${n.c}`
    shares[id] = (shares[id] ?? 0) + n.shr
    n.ch?.forEach(walk)
  }
  walk(tree)
  return shares
}
