/**
 * The Sankey overlay of a canvas calculation as data: what one contribution answer gives each box and
 * arrow, laid on a set of nodes and edges or taken off them again, and the fingerprint of the model graph
 * the answer belongs to. Apart from the drawing so that a rebuilt graph can have the overlay laid again.
 */
import type { Edge, Node } from '@xyflow/react'
import type { Graph, GraphEdge } from '../lib/api'
import { ARROW_COLOR, arrowMarker } from '../lib/canvas'
import { edgeShareFor, shareFor, type CalcMeta } from '../lib/occurrences'

/** One contribution answer, as far as the overlay reads it. */
export interface SankeyOverlay {
  /** Shares by full `db/code` canvas id (lib/canvas.ts `collectShares`). */
  shares: Record<string, number>
  meta: CalcMeta
}

const REST_WIDTH = 1.6

const arrow = (width: number): Pick<Edge, 'style' | 'markerEnd'> => ({
  style: { stroke: ARROW_COLOR, strokeWidth: width },
  markerEnd: arrowMarker(width) // the arrowhead keeps its size however thick the flow
})

export function nodesWithShares(nodes: Node[], o: SankeyOverlay): Node[] {
  return nodes.map((n) => ({ ...n, data: { ...n.data, share: shareFor(n, o.shares, o.meta) } }))
}

export function edgesWithShares(edges: Edge[], o: SankeyOverlay): Edge[] {
  return edges.map((e) => {
    const s = edgeShareFor(e, o.shares, o.meta)
    return { ...e, ...arrow(s ? 1 + 12 * Math.min(1, s) : REST_WIDTH) }
  })
}

/** Nodes without a share stay the same objects, so a canvas without an overlay does not redraw. */
export function nodesWithoutShares(nodes: Node[]): Node[] {
  return nodes.map((n) =>
    (n.data as { share?: number }).share === undefined ? n : { ...n, data: { ...n.data, share: undefined } }
  )
}

export function edgesWithoutShares(edges: Edge[]): Edge[] {
  return edges.map((e) => ({ ...e, ...arrow(REST_WIDTH) }))
}

/**
 * What a calculation of this model depends on: which datasets take part, every exchange between them with
 * its amount, and the backend's `revision`, which also covers the exchanges the canvas does not draw
 * (emissions, production amounts). Box ids are read as their dataset, because tagging an input splits or
 * merges boxes without changing a number. Two graphs with the same fingerprint give the same contribution
 * answer, so its overlay fits both.
 */
export function graphFingerprint(g: Graph): string {
  const dataset = new Map<string, string>()
  for (const n of [...g.nodes, ...(g.bg_nodes ?? [])]) dataset.set(n.id, n.dataset_id ?? n.id)
  const ds = (id: string): string => dataset.get(id) ?? id
  const exchange = (e: GraphEdge): string => [e.uid, ds(e.source), ds(e.target), e.type, e.amount].join('|')
  const datasets = [...new Set(g.nodes.map((n) => ds(n.id)))].sort()
  const exchanges = [...g.edges, ...(g.bg_edges ?? [])].map(exchange).sort()
  return JSON.stringify([g.revision ?? null, datasets, exchanges])
}
