/**
 * How the canvas minimap paints, and when it is worth showing at all.
 *
 * These live apart from the component for two reasons. One is testability without mounting React
 * Flow. The other is a performance contract: React Flow memoises the minimap's node layer on the
 * IDENTITY of the `nodeColor`/`nodeClassName` functions, so an inline arrow in JSX would rebuild
 * every node rect on every pan frame. Module-level functions cannot do that.
 */
import type { Node } from '@xyflow/react'

/** The three facts the card on the canvas paints with — see `PrismNode` and `Workbench.nodeData`. */
type PaintedData = {
  /** A colour the user assigned to this process (one of NODE_COLORS), drawn as the card's top bar. */
  color?: string
  /** A locked background/reference process: the greyed, dashed card. */
  readOnly?: boolean
  /** Matches the tag currently being highlighted: the card is ringed in green. */
  highlight?: boolean
}

const painted = (node: Node): PaintedData => (node.data ?? {}) as PaintedData

/**
 * The user's own colour-coding, or `''` to leave the fill to CSS.
 *
 * React Flow puts this on the rect as an inline `fill`, so it outranks the class-based fills below —
 * which is the same order the canvas card uses: the colour bar sits on top of whatever the card's
 * background says.
 */
export function minimapNodeColor(node: Node): string {
  return painted(node).color ?? ''
}

/**
 * The class that decides the fill when the user has not colour-coded the process. One class, not a
 * set: a rect has one fill, so the states are ranked instead of combined. Highlight wins over
 * locked because highlighting is an answer to a question the user just asked.
 */
export function minimapNodeClass(node: Node): string {
  const d = painted(node)
  if (d.highlight) return 'mm-node hl'
  if (d.readOnly) return 'mm-node ext'
  return 'mm-node'
}

/**
 * An empty model gets no minimap.
 *
 * Not a division-by-zero guard — React Flow unions the node bounds with the viewport, so it survives
 * both no nodes and one node without collapsing to a point. It is an honesty guard: a map of nothing
 * is a grey box with a rectangle in it, sitting on top of the "add your first process" canvas.
 */
export function showMinimap(nodeCount: number): boolean {
  return nodeCount > 0
}

/* ---------------------------------------------------------------------------
   Geometry: how big the map is, how big it may grow, and what a point on it means.
--------------------------------------------------------------------------- */

export type Size = { width: number; height: number }
/** The four client edges of a box — what `getBoundingClientRect()` already gives us. */
export type Edges = { left: number; top: number; right: number; bottom: number }

/** Landscape, because the canvas is. A module constant, because React Flow reads width/height off
 *  the `style` object and a fresh one each render would churn the panel for no reason. */
export const MINIMAP_SIZE: Size = { width: 208, height: 132 }

/**
 * How long the pointer has to REST on the map before it grows.
 *
 * The number is the whole argument for hover over a modifier: crossing the corner on the way to the
 * chat input takes a fraction of this, so the map does not grow at people who are going somewhere
 * else — while stopping to look at it is a decision, and needs nothing learned.
 */
export const ENLARGE_INTENT_MS = 400

/** What the enlarged map keeps clear of, growing up and to the left out of its own corner: the
 *  stage's left edge, and the canvas toolbar top-right (a panel 15 px in, one 30 px control row). */
export const ENLARGE_CLEARANCE = { left: 16, top: 54 }

/** Enough to turn a 3 px mark into a 7 px one. More would hide the canvas it is a map of. */
const ENLARGE_SCALE = 2.5

/**
 * The size the map may take while enlarged, growing out of the corner it already occupies.
 *
 * It keeps its right and bottom edges (it is the bottom-anchored flex child of the chat dock, so
 * those are not ours to move) and takes room upwards and leftwards — which is why only the stage's
 * left and top edges appear here. Clamped rather than fixed: on a small window the fixed size would
 * run under the toolbar, and a map that covers the controls is worse than a small map.
 *
 * Returns the resting size when there is no room to grow — including when nothing is measured yet
 * (a zero rect makes the ratios NaN, and `NaN > 1` is false).
 */
export function enlargedMinimapSize(stage: Edges, anchor: Edges): Size {
  const scale = Math.min(
    ENLARGE_SCALE,
    (anchor.right - stage.left - ENLARGE_CLEARANCE.left) / MINIMAP_SIZE.width,
    (anchor.bottom - stage.top - ENLARGE_CLEARANCE.top) / MINIMAP_SIZE.height
  )
  if (!(scale > 1)) return MINIMAP_SIZE
  return {
    width: Math.round(MINIMAP_SIZE.width * scale),
    height: Math.round(MINIMAP_SIZE.height * scale)
  }
}

export type ViewBox = { x: number; y: number; width: number; height: number }

/**
 * The stretch of model the map is showing, read off the SVG React Flow drew.
 *
 * Read rather than recomputed: React Flow derives it from the node bounds, the map's own aspect ratio
 * and an `offsetScale` padding, and a second copy of that arithmetic here would be a second opinion
 * about where the map's pixels are — the attribute IS the projection.
 */
export function parseMinimapViewBox(attr: string | null | undefined): ViewBox | null {
  const n = (attr ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || n[2] <= 0 || n[3] <= 0) return null
  return { x: n[0], y: n[1], width: n[2], height: n[3] }
}

/**
 * The point in the MODEL that a point on the map names.
 *
 * This is the reading a drop on the map gets (see `CanvasMinimap`): the map is a picture of the whole
 * model, so releasing a dataset over it means "put the process there in the model" — not "put it on
 * the canvas pixel the map happens to be covering", which would bury the new process under the map
 * that took the drop. The scale is uniform because React Flow keeps the viewBox's aspect ratio equal
 * to the element's, so one factor per axis is exact rather than approximately right.
 *
 * `null` for an unmeasured map (width 0), which would otherwise divide its way to Infinity.
 */
export function minimapFlowPoint(
  pointer: { x: number; y: number },
  rect: { left: number; top: number; width: number; height: number },
  view: ViewBox
): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  return {
    x: view.x + ((pointer.x - rect.left) / rect.width) * view.width,
    y: view.y + ((pointer.y - rect.top) / rect.height) * view.height
  }
}
