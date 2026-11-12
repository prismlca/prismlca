/**
 * The canvas calculation: one process under one method, its score in the bar above the canvas and its
 * shares drawn as a Sankey on the boxes and arrows — and keeping the two in step.
 *
 * Every rebuild of the graph (an edit, the end of an assistant's turn) draws the boxes afresh, without
 * shares. Left at that, the bar kept its score over a canvas that had lost the Sankey (V476). So the
 * overlay is laid again when the rebuilt graph is still the one that was calculated, and the result is
 * marked outdated when it is not. It is never recalculated on its own: that is the user's call, or the
 * assistant's.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type { Edge, Node } from '@xyflow/react'
import { api, isSuperseded, type Graph } from '../lib/api'
import { collectShares, splitId, type ShareTreeNode } from '../lib/canvas'
import type { MethodEntry } from '../lib/methods'
import { graphRoute } from '../lib/server/routes'
import type { CalcMeta } from '../lib/occurrences'
import {
  edgesWithShares,
  edgesWithoutShares,
  graphFingerprint,
  nodesWithShares,
  nodesWithoutShares,
  type SankeyOverlay
} from './sankeyOverlay'

export interface CanvasResult {
  total: number
  unit: string
  method: string
  fu: string
  seconds: number
  nodes: number
}

type Busy = 'calc' | 'mc' | null

export interface CanvasCalcDeps {
  run: (fn: () => Promise<void>) => Promise<void>
  activeDb: string | null
  methods: MethodEntry[]
  /** The method picked in the toolbar, as an index into `methods`. */
  chosen: string
  selected: string[]
  nodes: Node[]
  setNodes: (update: (nodes: Node[]) => Node[]) => void
  setEdges: (update: (edges: Edge[]) => Edge[]) => void
  /** Shared with the Monte Carlo run: one calculation at a time. */
  calcBusy: Busy
  setCalcBusy: (busy: Busy) => void
  /** Called by the canvas with every graph it has just built (useCanvasModel). */
  graphBuiltRef: MutableRefObject<(g: Graph) => void>
}

/** The fingerprint of the model graph as the backend holds it now. */
const backendGraph = async (db: string): Promise<string> =>
  graphFingerprint(await api<Graph>('GET', graphRoute(db)))

export function useCanvasCalc(deps: CanvasCalcDeps) {
  const { run, activeDb, methods, chosen, selected, nodes, setNodes, setEdges, calcBusy, setCalcBusy } = deps
  const [result, setResult] = useState<CanvasResult | null>(null)
  /** The model changed after the result was calculated: the bar says so, the canvas has no Sankey. */
  const [stale, setStale] = useState(false)
  /** The overlay of the result in the bar, with the fingerprint of the graph it was calculated on — null
   *  when that is not known, and then no graph ever matches it. */
  const held = useRef<{ overlay: SankeyOverlay; graph: string | null } | null>(null)
  /** The fingerprint of the graph on the canvas now. */
  const drawn = useRef<string | null>(null)
  const activeDbRef = useRef(activeDb)
  activeDbRef.current = activeDb

  const lay = (o: SankeyOverlay): void => {
    setNodes((ns) => nodesWithShares(ns, o))
    setEdges((es) => edgesWithShares(es, o))
  }
  const lift = (): void => {
    setNodes(nodesWithoutShares)
    setEdges(edgesWithoutShares)
  }

  // After the rebuild's own state updates, so these apply to the boxes it has just drawn — same render.
  deps.graphBuiltRef.current = (g: Graph): void => {
    const fingerprint = graphFingerprint(g)
    drawn.current = fingerprint
    const h = held.current
    if (!h) return
    // Not sticky: an edit that is undone brings the calculated model back, and its overlay with it.
    const same = h.graph !== null && h.graph === fingerprint
    setStale(!same)
    if (same) lay(h.overlay)
    else lift() // boxes kept across the rebuild (placed references) still carry the old shares
  }

  // The bar is one model's result. Switching models left it standing over the next canvas as if it were
  // that one's; the Sankey shares live on the nodes, which the switch rebuilds anyway.
  const resultDb = useRef<string | null>(null)
  useEffect(() => {
    if (resultDb.current === activeDb) return
    resultDb.current = activeDb
    held.current = null
    setResult(null)
    setStale(false)
  }, [activeDb])

  const calculate = (methodOverride?: string[], codeOverride?: string): void => {
    // Normally computes the single selected process with the chosen method; the assistant can pass
    // an explicit method + process code to trigger the same canvas calculation + Sankey overlay.
    if (calcBusy || !activeDb || !methods.length) return
    if (!codeOverride && selected.length !== 1) return
    setCalcBusy('calc')
    void run(async () => {
      try {
        const [db, code] = codeOverride ? [activeDb, codeOverride] : splitId(selected[0])
        const method = methodOverride ?? methods[Number(chosen) || 0].method
        // What the answer was computed on is the model as the backend holds it, which the canvas may not
        // show yet (an edit's reload is still on its way). So the graph is read right before and right
        // after: the same both times, the answer belongs to it; different, an edit landed in between and
        // the answer's basis is unknown — outdated for good, never to be matched by a later graph.
        const before = await backendGraph(db)
        const t0 = Date.now()
        const c = await api<{ meta: CalcMeta; tree: unknown }>('POST', '/api/v1/calc/contribution', {
          database: db,
          code,
          method,
          amount: 1
        })
        const seconds = (Date.now() - t0) / 1000
        const after = await backendGraph(db)
        // Another model is on the canvas by now; its bar must not show this one's score.
        if (activeDbRef.current !== activeDb) return
        // Shares keyed by the full `db/code` canvas id — codes alone can collide between the
        // foreground model and a background database.
        const overlay = { shares: collectShares(c.tree as ShareTreeNode, db), meta: c.meta }
        // The bar names the functional unit by its process name; the code was what it printed, an id nobody reads.
        const fuNode = nodes.find((n) => n.id === `${db}/${code}`)
        const fuLabel = (fuNode?.data as { label?: string } | undefined)?.label
        const basis = before === after ? after : null
        held.current = { overlay, graph: basis }
        setResult({
          total: c.meta.total,
          unit: c.meta.unit,
          method: c.meta.method.join(' · '),
          fu: fuLabel || code,
          seconds,
          nodes: c.meta.n_nodes
        })
        // The canvas catches up with an edit on its next rebuild, and the overlay is laid then.
        const current = basis !== null && basis === drawn.current
        setStale(!current)
        // A box's share is its own inputs' exact impact, not its dataset's flow through the whole tree.
        if (current) lay(overlay)
        else lift()
      } catch (e) {
        if (!isSuperseded(e)) throw e // let `run` surface real errors; ignore superseded ones
      } finally {
        setCalcBusy(null)
      }
    })
  }

  const clearResult = (): void => {
    held.current = null
    setResult(null)
    setStale(false)
    // Drop the Sankey overlay: every edge back to uniform thickness, no node shares.
    lift()
  }

  return { result, stale, calculate, clearResult }
}
