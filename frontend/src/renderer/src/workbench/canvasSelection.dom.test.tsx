import { describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { makePrism, type Routes } from '../test/prism'
import { useCanvasModel, type CanvasModelDeps } from './useCanvasModel'
import type { Graph } from '../lib/api'

/**
 * The canvas selection against a real React Flow, wired the way the Workbench wires it: the selection
 * comes back through an INLINE `onSelectionChange`, and React Flow calls that from an effect keyed on the
 * callback — after every render of the component that owns it.
 */
const node = (id: string, name: string) => ({ id, name, location: 'DE', unit: 'unit', external: false })
const graph = (...nodes: ReturnType<typeof node>[]): Graph =>
  ({ database: 'm1', nodes, edges: [] }) as unknown as Graph

type Model = ReturnType<typeof useCanvasModel>

const deps = (routes: Routes = {}): CanvasModelDeps => {
  ;(window as unknown as { prism: unknown }).prism = makePrism(routes).prism
  return {
    run: async (fn) => {
      await fn()
    },
    activeDb: null,
    setConfirm: () => {},
    setError: () => {},
    reloadAudit: vi.fn(async () => {}),
    edgeDigits: 3
  }
}

function Harness({ deps, expose }: { deps: CanvasModelDeps; expose: (m: Model) => void }): JSX.Element {
  const m = useCanvasModel(deps)
  expose(m)
  return (
    <div style={{ width: 800, height: 600 }}>
      <ReactFlow
        nodes={m.nodes}
        edges={m.edges}
        onNodesChange={m.onNodesChange}
        onSelectionChange={({ nodes: sel }) => m.setSelected(sel.map((n) => n.id))}
      />
    </div>
  )
}

describe('canvas selection', () => {
  it('lets the canvas come to rest: an unchanged selection report does not render again', async () => {
    // Outside act(): with the old loop act() never settles, and the count is the clearer failure.
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    const before = g.IS_REACT_ACT_ENVIRONMENT
    g.IS_REACT_ACT_ENVIRONMENT = false
    let renders = 0
    const el = document.body.appendChild(document.createElement('div'))
    const root = createRoot(el)
    try {
      root.render(
        <ReactFlowProvider>
          <Harness deps={deps()} expose={() => renders++} />
        </ReactFlowProvider>
      )
      await new Promise((r) => setTimeout(r, 300))
      // A handful for mounting; the loop this guards against made two thousand in half a second.
      expect(renders).toBeLessThan(20)
    } finally {
      root.unmount()
      el.remove()
      g.IS_REACT_ACT_ENVIRONMENT = before
    }
  })

  it('keeps a process selected through React Flow’s own report when selected after its box exists', async () => {
    let model!: Model
    render(
      <ReactFlowProvider>
        <Harness deps={deps()} expose={(m) => (model = m)} />
      </ReactFlowProvider>
    )
    act(() => model.buildGraph(graph(node('m1/a', 'Assembly'))))
    act(() => model.selectOnly('m1/a'))
    await waitFor(() => expect(model.selected).toEqual(['m1/a']))

    // The reload after creating "Part", then the selection — the order the Workbench uses.
    act(() => model.buildGraph(graph(node('m1/a', 'Assembly'), node('m1/b', 'Part'))))
    act(() => model.selectOnly('m1/b'))
    await waitFor(() => expect(model.selected).toEqual(['m1/b']))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(model.selected).toEqual(['m1/b'])
    expect(model.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['m1/b'])
  })

  it('still hands React Flow’s selection back over an id the canvas does not show', async () => {
    // Why the Workbench selects a new process only after the reload: set before its box exists, the
    // next report puts the canvas's own selection back.
    let model!: Model
    render(
      <ReactFlowProvider>
        <Harness deps={deps()} expose={(m) => (model = m)} />
      </ReactFlowProvider>
    )
    act(() => model.buildGraph(graph(node('m1/a', 'Assembly'))))
    act(() => model.selectOnly('m1/a'))
    await waitFor(() => expect(model.selected).toEqual(['m1/a']))
    act(() => model.setSelected(['m1/not-yet']))
    await waitFor(() => expect(model.selected).toEqual(['m1/a']))
  })

  it('tells its caller whether its own request built the canvas', async () => {
    // The Workbench selects a process it just created only when its reload built the canvas: a reload
    // overtaken by a newer one is discarded, and the box may not be there.
    const pending: ((g: Graph) => void)[] = []
    const routes = {
      'GET /api/v1/model/graph/m1': () => new Promise<Graph>((resolve) => pending.push(resolve))
    }
    const { result } = renderHook(() => useCanvasModel(deps(routes)))
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    act(() => {
      first = result.current.reloadGraph('m1')
    })
    await waitFor(() => expect(pending).toHaveLength(1))
    act(() => {
      second = result.current.reloadGraph('m1')
    })
    await waitFor(() => expect(pending.length).toBeGreaterThan(0))
    await act(async () => {
      pending.forEach((resolve) => resolve(graph(node('m1/a', 'Assembly'))))
    })
    expect(await first).toBe(false)
    expect(await second).toBe(true)
  })
})
