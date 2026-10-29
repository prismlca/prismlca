import Dagre from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'

export type LayoutDirection = 'LR' | 'TB'

/**
 * Position a graph with dagre so large / nested process networks are readable without
 * hand-placing nodes (the Activity Browser weakness). Pure and deterministic.
 *
 * Left-to-right: inputs on the left feed the product on the right (matches the node handles:
 * source = right edge, target = left edge, so edges never curl back). Tuned for the lazy
 * upstream tree — generous rank spacing for depth, enough node separation for bushy tiers, the
 * tight-tree ranker for clean tree-like graphs, and a node box tall enough to clear the ⊕
 * expand badge that hangs below each node.
 */
export function layoutWithDagre(
  nodes: Node[],
  edges: Edge[],
  clusters: string[][] = [],
  direction: LayoutDirection = 'LR',
  nodeWidth = 210,
  nodeHeight = 88,
  /** Tier and sibling gaps. The canvas keeps the defaults; a printed figure (the report's system model)
   *  packs tighter, because its whole width is scaled to a text block and every unit of gap is lost
   *  legibility. Optional so the canvas' layout stays byte-identical (layout.test.ts). */
  spacing: { nodesep?: number; ranksep?: number } = {}
): Node[] {
  // `compound: true` unconditionally, and with no parent set it is a no-op: the positions come out
  // byte-identical to a plain graph's (asserted in layout.test.ts), which is what keeps a model with
  // no groups in it from paying for this at all.
  const g = new Dagre.graphlib.Graph({ compound: true })
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: direction,
    ranker: 'tight-tree',
    nodesep: spacing.nodesep ?? 34, // gap between sibling nodes in the same tier
    ranksep: spacing.ranksep ?? 150, // gap between tiers (upstream depth)
    edgesep: 24,
    marginx: 40,
    marginy: 40
  })

  // Give dagre each node's REAL box: use React Flow's measured size once rendered, else the
  // fixed fallback (nodes are width-capped in CSS, so the fallback is accurate). Feeding a wrong
  // (too-small) width was the bug — dagre then packed tiers edge-to-edge too tightly for nodes
  // with long names. With real sizes, both the left and right edges are spaced correctly.
  const dims = (n: Node): { width: number; height: number } => {
    const m = (n as { measured?: { width?: number; height?: number } }).measured
    return {
      width: m?.width ?? (n as { width?: number }).width ?? nodeWidth,
      height: m?.height ?? (n as { height?: number }).height ?? nodeHeight
    }
  }

  nodes.forEach((n) => {
    const d = dims(n)
    g.setNode(n.id, { width: d.width, height: d.height })
  })

  /* Group boxes: laid out as dagre clusters, which is the only cheap answer that works.
     Dagre knows nothing about a group by itself, so an arranged model regularly came out with two
     boxes crossing each other — on random test graphs, 116 of 120 layouts had overlapping boxes.
     A cluster is dagre's own name for "keep these together": the members are constrained to
     neighbouring positions, and the bounding rectangle a group derives from them then falls clear of
     the next group's. On the same 120 graphs, none overlapped afterwards. It costs area — the arranged
     model's bounding box grows by about half again (median 1.5×, worst 2.7× on those graphs) — which
     the canvas absorbs with fitView, and which is only charged to models that have groups.
     A cluster needs each node to have at most one parent, so this is only sound because a process
     belongs to at most one group (see lib/groups.ts); overlapping membership would have made it a
     nesting problem instead. Groups down to one drawn member are skipped: a cluster of one constrains
     nothing and only adds a node dagre has to place. */
  clusters.forEach((members, i) => {
    const present = members.filter((m) => g.hasNode(m))
    if (present.length < 2) return
    const cluster = `__group:${i}`
    g.setNode(cluster, {})
    for (const m of present) g.setParent(m, cluster)
  })

  edges.forEach((e) => {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target)
  })

  Dagre.layout(g)

  return nodes.map((n) => {
    const p = g.node(n.id)
    const d = dims(n)
    // dagre gives node centres; React Flow positions by top-left corner.
    return { ...n, position: { x: p.x - d.width / 2, y: p.y - d.height / 2 } }
  })
}
