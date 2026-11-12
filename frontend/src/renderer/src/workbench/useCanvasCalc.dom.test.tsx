/**
 * The canvas calculation across a rebuild of the graph (V476). An edit or the end of an assistant's turn
 * rebuilds the boxes without shares: the bar kept its score while the Sankey was gone. Now the Sankey is
 * laid again when the model is still the one calculated, and the result is marked outdated when it is not.
 * What counts as "the one calculated" is the model as the backend held it while the answer was computed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { makePrism } from '../test/prism'
import { resetQueryCache } from '../lib/server/useQuery'
import type { Graph } from '../lib/api'
import { useCanvasModel } from './useCanvasModel'
import { useCanvasCalc } from './useCanvasCalc'

beforeEach(() => resetQueryCache())

const GRAPH: Graph = {
  database: 'm1',
  nodes: [
    { id: 'm1/a', name: 'Assembly', location: 'DE', unit: 'unit', external: false },
    { id: 'm1/b', name: 'Part', location: 'DE', unit: 'kg', external: false }
  ] as Graph['nodes'],
  edges: [{ uid: 'u-ab', amount: 0.5, type: 'technosphere', source: 'm1/b', target: 'm1/a' }]
} as Graph

/** The same model with another amount on its one arrow — the calculation no longer holds. */
const EDITED: Graph = { ...GRAPH, edges: [{ ...GRAPH.edges[0], amount: 0.8 }] }

const ANSWER = {
  meta: { total: 2, unit: 'kg CO2-Eq', method: ['IPCC', 'GWP100'], n_nodes: 2 },
  tree: { db: 'm1', c: 'a', shr: 1, ch: [{ db: 'm1', c: 'b', shr: 0.75 }] }
}

/** `backend.graph` is the model as the backend holds it; the canvas shows what it last built. */
function rig(answer: () => unknown = () => ANSWER) {
  const backend = { graph: GRAPH, graphReads: 0 }
  const fixture = makePrism({
    'POST /api/v1/calc/contribution': () => answer(),
    'GET /api/v1/model/graph/m1': () => (backend.graphReads++, backend.graph)
  })
  ;(window as unknown as { prism: unknown }).prism = fixture.prism
  const run = async (fn: () => Promise<void>): Promise<void> => {
    await fn()
  }
  const hook = renderHook(() => {
    const canvas = useCanvasModel({
      run,
      activeDb: null,
      setConfirm: () => {},
      reloadAudit: vi.fn(async () => {}),
      edgeDigits: 3
    })
    const [calcBusy, setCalcBusy] = useState<'calc' | 'mc' | null>(null)
    const calc = useCanvasCalc({
      run,
      activeDb: 'm1',
      methods: [{ method: ['IPCC', 'GWP100'], unit: 'kg CO2-Eq' }] as never,
      chosen: '0',
      selected: [],
      nodes: canvas.nodes,
      setNodes: canvas.setNodes,
      setEdges: canvas.setEdges,
      calcBusy,
      setCalcBusy,
      graphBuiltRef: canvas.graphBuiltRef
    })
    return { canvas, calc }
  })
  return { ...hook, backend }
}

type Result = ReturnType<typeof rig>['result']
const share = (r: Result, id: string): number | undefined =>
  (r.current.canvas.nodes.find((n) => n.id === id)?.data as { share?: number }).share
const width = (r: Result): unknown => r.current.canvas.edges[0].style?.strokeWidth

async function calculated(r: Result): Promise<void> {
  act(() => r.current.calc.calculate(['IPCC', 'GWP100'], 'a'))
  await waitFor(() => expect(r.current.calc.result?.total).toBe(2))
}

describe('the Sankey across a rebuild of the graph', () => {
  it('is laid again when the graph is unchanged', async () => {
    const { result } = rig()
    act(() => result.current.canvas.buildGraph(GRAPH))
    await calculated(result)
    expect(share(result, 'm1/b')).toBe(0.75)
    expect(width(result)).toBe(10)
    // The end of an assistant's turn: the same graph, rebuilt.
    act(() => result.current.canvas.buildGraph(GRAPH))
    expect(share(result, 'm1/b')).toBe(0.75)
    expect(width(result)).toBe(10)
    expect(result.current.calc.stale).toBe(false)
  })

  it('marks the result outdated after a change, without a stale Sankey, and recalculates nothing', async () => {
    let asked = 0
    const { result, backend } = rig(() => (asked++, ANSWER))
    act(() => result.current.canvas.buildGraph(GRAPH))
    await calculated(result)
    backend.graph = EDITED
    act(() => result.current.canvas.buildGraph(EDITED))
    expect(result.current.calc.stale).toBe(true)
    expect(result.current.calc.result?.total).toBe(2) // still shown, marked
    expect(share(result, 'm1/b')).toBeUndefined()
    expect(width(result)).toBe(1.6)
    await new Promise((r) => setTimeout(r, 30))
    expect(asked).toBe(1)
    // Undone: the calculated model is back, and so is its Sankey.
    act(() => result.current.canvas.buildGraph(GRAPH))
    expect(result.current.calc.stale).toBe(false)
    expect(share(result, 'm1/b')).toBe(0.75)
  })

  it('counts a change the canvas does not draw — an emission, a production amount', async () => {
    const { result, backend } = rig()
    // Same arrows, same amounts: only the backend's revision tells the two apart.
    const R1: Graph = { ...GRAPH, revision: 'r1' }
    const R2: Graph = { ...GRAPH, revision: 'r2' }
    backend.graph = R1
    act(() => result.current.canvas.buildGraph(R1))
    await calculated(result)
    expect(result.current.calc.stale).toBe(false)
    backend.graph = R2
    act(() => result.current.canvas.buildGraph(R2))
    expect(result.current.calc.stale).toBe(true)
    expect(share(result, 'm1/b')).toBeUndefined()
  })

  it('reads a box split by tagging as the same model', async () => {
    const { result } = rig()
    act(() => result.current.canvas.buildGraph(GRAPH))
    await calculated(result)
    const boxed: Graph = {
      ...GRAPH,
      nodes: [GRAPH.nodes[0], { ...GRAPH.nodes[1], id: 'm1/b#t1', dataset_id: 'm1/b' }],
      edges: [{ ...GRAPH.edges[0], source: 'm1/b#t1' }]
    }
    act(() => result.current.canvas.buildGraph(boxed))
    expect(result.current.calc.stale).toBe(false)
  })

  it('lays an answer computed on an edit the canvas has not drawn yet once it catches up — and only then', async () => {
    const { result, backend } = rig()
    act(() => result.current.canvas.buildGraph(GRAPH))
    // The edit has reached the backend; the canvas reload for it is still on its way.
    backend.graph = EDITED
    await calculated(result)
    expect(result.current.calc.stale).toBe(true)
    expect(share(result, 'm1/b')).toBeUndefined()
    act(() => result.current.canvas.buildGraph(EDITED))
    expect(result.current.calc.stale).toBe(false)
    expect(share(result, 'm1/b')).toBe(0.75)
    // Undone: the canvas is back on the graph before the edit, which this answer never described.
    act(() => result.current.canvas.buildGraph(GRAPH))
    expect(result.current.calc.stale).toBe(true)
    expect(share(result, 'm1/b')).toBeUndefined()
  })

  it('keeps an answer outdated for good when an edit landed while it was computed', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { result, backend } = rig(async () => {
      await gate
      return ANSWER
    })
    act(() => result.current.canvas.buildGraph(GRAPH))
    act(() => result.current.calc.calculate(['IPCC', 'GWP100'], 'a'))
    await waitFor(() => expect(backend.graphReads).toBe(1))
    backend.graph = EDITED
    release()
    await waitFor(() => expect(result.current.calc.result).not.toBeNull())
    expect(result.current.calc.stale).toBe(true)
    // Neither graph is known to be the one computed on: no rebuild makes it current again.
    for (const g of [EDITED, GRAPH]) {
      act(() => result.current.canvas.buildGraph(g))
      expect(result.current.calc.stale).toBe(true)
      expect(share(result, 'm1/b')).toBeUndefined()
    }
  })

  it('clear takes the result, the mark and the Sankey off together', async () => {
    const { result } = rig()
    act(() => result.current.canvas.buildGraph(GRAPH))
    await calculated(result)
    act(() => result.current.calc.clearResult())
    expect(result.current.calc.result).toBeNull()
    expect(share(result, 'm1/b')).toBeUndefined()
    // Nothing held any more: a rebuild lays nothing.
    act(() => result.current.canvas.buildGraph(GRAPH))
    expect(share(result, 'm1/b')).toBeUndefined()
    expect(result.current.calc.stale).toBe(false)
  })
})
