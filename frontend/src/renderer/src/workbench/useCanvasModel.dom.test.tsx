/**
 * Unit tests for the canvas state machine — the first tests that reach buildGraph, expand/collapse
 * and the multi-delete sweep directly instead of through a mounted Workbench. Written with the
 * wave-4.1 extraction: the hook owns the ref mirrors, so a regression in "the mirror and the state
 * disagree" (the class behind the resurrected-ghost bug on the Kimi run) turns red here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { makePrism, type PrismFixture, type Routes } from '../test/prism'
import { resetQueryCache } from '../lib/server/useQuery'
import { useCanvasModel, type CanvasModelDeps } from './useCanvasModel'
import type { Graph } from '../lib/api'
import ConfirmDialog, { type ConfirmSpec } from '../views/ConfirmDialog'

beforeEach(() => resetQueryCache())

const GRAPH: Graph = {
  database: 'm1',
  nodes: [
    { id: 'm1/a', name: 'Assembly', location: 'DE', unit: 'unit', external: false },
    { id: 'm1/b', name: 'Part', location: 'DE', unit: 'kg', external: false }
  ] as Graph['nodes'],
  edges: [{ uid: 'u-ab', amount: 0.5, type: 'technosphere', source: 'm1/b', target: 'm1/a' }]
} as Graph

interface Rig {
  prism: PrismFixture
  confirms: ConfirmSpec[]
  deps: CanvasModelDeps
}

function rig(routes: Routes = {}, activeDb: string | null = null): Rig {
  const fixture = makePrism(routes)
  ;(window as unknown as { prism: unknown }).prism = fixture.prism
  const confirms: ConfirmSpec[] = []
  const deps: CanvasModelDeps = {
    run: async (fn) => {
      await fn()
    },
    activeDb,
    setConfirm: (spec) => {
      if (spec) confirms.push(spec)
    },
    reloadAudit: vi.fn(async () => {}),
    edgeDigits: 3
  }
  return { prism: fixture, confirms, deps }
}

describe('buildGraph', () => {
  it('builds nodes and labelled edges from the backend graph', () => {
    const { deps } = rig()
    const { result } = renderHook(() => useCanvasModel(deps))
    act(() => result.current.buildGraph(GRAPH))
    expect(result.current.nodes.map((n) => n.id).sort()).toEqual(['m1/a', 'm1/b'])
    expect(result.current.edges).toHaveLength(1)
    const edge = result.current.edges[0]
    expect(edge.source).toBe('m1/b')
    expect(edge.target).toBe('m1/a')
    // The arrow label carries the amount plus the INPUT's reference-product unit.
    expect(edge.label).toBe('0.5 kg')
    // The mirror follows the state — this is what buildGraph itself reads on the next reload.
    expect(result.current.nodesRef.current.map((n) => n.id).sort()).toEqual(['m1/a', 'm1/b'])
  })
})

/** Undo of a deleted process restores it under its old id, and it used to come back in the grid's next
 *  free cell instead of where it stood. */
describe('a box that leaves and comes back', () => {
  it('returns to its old spot, even after a model switch in between', () => {
    const { deps } = rig()
    const { result } = renderHook(() => useCanvasModel(deps))
    act(() => result.current.buildGraph(GRAPH))
    act(() =>
      result.current.setNodes((ns) =>
        ns.map((n) => (n.id === 'm1/b' ? { ...n, position: { x: 640, y: 410 } } : n))
      )
    )
    // Deleted: the reload no longer has it, and the delete path dropped its stored position.
    delete result.current.posRef.current['m1/b']
    act(() => result.current.buildGraph({ ...GRAPH, nodes: [GRAPH.nodes[0]], edges: [] }))
    expect(result.current.nodes.map((n) => n.id)).toEqual(['m1/a'])
    // Another model's canvas seeds its own positions — the remembered spot survives that. (An arranged
    // canvas: on one still laid out automatically, a returning box simply takes its place in the layout.)
    result.current.posRef.current = { 'm1/a': { x: 0, y: 0 } }
    // Undone: the same id is back and stands where it stood.
    act(() => result.current.buildGraph(GRAPH))
    expect(result.current.nodes.find((n) => n.id === 'm1/b')?.position).toEqual({ x: 640, y: 410 })
  })
})

describe('the layout while nobody has arranged the canvas', () => {
  const at = (r: { current: { nodes: { id: string; position: { x: number; y: number } }[] } }, id: string) =>
    r.current.nodes.find((n) => n.id === id)?.position

  it('stays automatic when a box comes back under its old id', () => {
    const box = (id: string, uid: string, tags: { dimension: string; value: string }[] = []) => ({
      id,
      dataset_id: 'ei/s',
      uids: [uid],
      tags,
      name: 'steel',
      location: 'GLO',
      unit: 'kg',
      external: true
    })
    const raw = [{ dimension: 'Phase', value: 'Raw materials' }]
    const first = {
      ...GRAPH,
      bg_nodes: [box('ei/s', 'u1')],
      bg_edges: [{ uid: 'u1', amount: 1, type: 'technosphere', source: 'ei/s', target: 'm1/b' }]
    } as Graph
    // The input is tagged (the box takes another id), then a second, untagged input brings the old id back.
    const tagged = {
      ...first,
      bg_nodes: [box('ei/s#ba9876543210', 'u1', raw)],
      bg_edges: [{ ...first.bg_edges![0], source: 'ei/s#ba9876543210' }]
    } as Graph
    const back = {
      ...tagged,
      bg_nodes: [...tagged.bg_nodes!, box('ei/s', 'u3')],
      bg_edges: [
        ...tagged.bg_edges!,
        { uid: 'u3', amount: 0, type: 'technosphere', source: 'ei/s', target: 'm1/a' }
      ]
    } as Graph
    const { deps } = rig()
    const { result } = renderHook(() => useCanvasModel(deps))
    act(() => result.current.buildGraph(first))
    act(() => result.current.buildGraph(tagged))
    act(() => result.current.buildGraph(back))

    const fresh = renderHook(() => useCanvasModel(rig().deps)).result
    act(() => fresh.current.buildGraph(back))
    expect(result.current.posRef.current).toEqual({})
    for (const id of ['m1/a', 'm1/b', 'ei/s', 'ei/s#ba9876543210'])
      expect(at(result, id)).toEqual(at(fresh, id))
  })

  it('keeps every other node where it stands once one is dragged', () => {
    const { deps } = rig()
    const { result } = renderHook(() => useCanvasModel(deps))
    act(() => result.current.buildGraph(GRAPH))
    const before = at(result, 'm1/a')
    act(() =>
      result.current.setNodes((ns) =>
        ns.map((n) => (n.id === 'm1/b' ? { ...n, position: { x: 640, y: 410 } } : n))
      )
    )
    result.current.posRef.current['m1/b'] = { x: 640, y: 410 }
    act(() => result.current.buildGraph(GRAPH))
    expect(at(result, 'm1/a')).toEqual(before)
    expect(at(result, 'm1/b')).toEqual({ x: 640, y: 410 })
  })
})

describe('expand and collapse', () => {
  const expandRoutes: Routes = {
    'POST /api/v1/model/expand': {
      inputs: [
        {
          database: 'ei',
          code: 'x',
          name: 'market for part',
          location: 'GLO',
          unit: 'kg',
          external: true,
          read_only: true
        }
      ],
      edges: [{ uid: 'u-xb', amount: 2, source: 'ei/x', target: 'm1/b' }]
    }
  }

  it('reveals the direct inputs and collapse removes exactly them again', async () => {
    const { deps } = rig(expandRoutes)
    const { result } = renderHook(() => useCanvasModel(deps))
    act(() => result.current.buildGraph(GRAPH))

    await act(async () => result.current.expandNode('m1/b'))
    await waitFor(() => expect(result.current.nodes).toHaveLength(3))
    const revealed = result.current.nodes.find((n) => n.id === 'ei/x')
    expect((revealed?.data as { revealed?: boolean }).revealed).toBe(true)
    expect((result.current.nodes.find((n) => n.id === 'm1/b')?.data as { expanded?: boolean }).expanded).toBe(
      true
    )
    // A revealed arrow is named after both ends: the same exchange shows under every box expanded.
    expect(result.current.edges.map((e) => e.id).sort()).toEqual(['ei/x__m1/b__u-xb', 'u-ab'])

    act(() => result.current.collapse('m1/b'))
    expect(result.current.nodes.map((n) => n.id).sort()).toEqual(['m1/a', 'm1/b'])
    expect(result.current.edges.map((e) => e.id)).toEqual(['u-ab'])
    expect((result.current.nodes.find((n) => n.id === 'm1/b')?.data as { expanded?: boolean }).expanded).toBe(
      false
    )
  })
})

describe('boxes per occurrence', () => {
  // Electricity feeds Assembly untagged and Part under "Use": two boxes of one dataset.
  const TWO_BOXES: Graph = {
    ...GRAPH,
    bg_nodes: [
      {
        id: 'ei/e',
        dataset_id: 'ei/e',
        uids: ['u1'],
        tags: [],
        name: 'electricity',
        location: 'DE',
        unit: 'kWh',
        external: true
      },
      {
        id: 'ei/e#0123456789ab',
        dataset_id: 'ei/e',
        uids: ['u2'],
        tags: [{ dimension: 'Phase', value: 'Use' }],
        name: 'electricity',
        location: 'DE',
        unit: 'kWh',
        external: true
      }
    ] as Graph['bg_nodes'],
    bg_edges: [
      { uid: 'u1', amount: 1, type: 'technosphere', source: 'ei/e', target: 'm1/a' },
      { uid: 'u2', amount: 2, type: 'technosphere', source: 'ei/e#0123456789ab', target: 'm1/b' }
    ]
  } as Graph

  it('draws one box per occurrence and each expands on its own', async () => {
    const { deps } = rig({
      'POST /api/v1/model/expand': {
        inputs: [
          {
            database: 'ei',
            code: 'coal',
            name: 'coal',
            location: 'GLO',
            unit: 'kg',
            external: true,
            read_only: true
          }
        ],
        edges: [{ uid: null, amount: 1, source: 'ei/coal', target: 'ei/e' }]
      }
    })
    const { result } = renderHook(() => useCanvasModel(deps))
    act(() => result.current.buildGraph(TWO_BOXES))
    expect(result.current.nodes.map((n) => n.id).sort()).toEqual([
      'ei/e',
      'ei/e#0123456789ab',
      'm1/a',
      'm1/b'
    ])
    await act(async () => result.current.expandNode('ei/e'))
    await act(async () => result.current.expandNode('ei/e#0123456789ab'))
    await waitFor(() => expect(result.current.nodes).toHaveLength(6))
    // The second box's coal is a node of its own, hanging under that box only.
    expect(result.current.nodes.map((n) => n.id)).toContain('ei/coal#ei/e#0123456789ab')
    const underTagged = result.current.edges
      .filter((e) => e.target === 'ei/e#0123456789ab')
      .map((e) => e.source)
    expect(underTagged).toEqual(['ei/coal#ei/e#0123456789ab'])
  })

  it('carries position and group to the new id when a box is tagged', () => {
    const { deps } = rig()
    const { result } = renderHook(() => useCanvasModel(deps))
    act(() => result.current.buildGraph(TWO_BOXES))
    act(
      () =>
        result.current.posRef.current['ei/e#0123456789ab'] &&
        delete result.current.posRef.current['ei/e#0123456789ab']
    )
    result.current.posRef.current['ei/e'] = { x: 11, y: 22 }
    act(() => result.current.putGroups([{ id: 'g1', color: '#000', members: ['ei/e', 'm1/a'] }]))
    // u1 now carries "Raw materials": its box gets another id.
    const retagged: Graph = {
      ...TWO_BOXES,
      bg_nodes: [
        {
          ...TWO_BOXES.bg_nodes![0],
          id: 'ei/e#ba9876543210',
          tags: [{ dimension: 'Phase', value: 'Raw materials' }]
        },
        TWO_BOXES.bg_nodes![1]
      ],
      bg_edges: [{ ...TWO_BOXES.bg_edges![0], source: 'ei/e#ba9876543210' }, TWO_BOXES.bg_edges![1]]
    } as Graph
    act(() => result.current.buildGraph(retagged))
    expect(result.current.nodes.find((n) => n.id === 'ei/e#ba9876543210')?.position).toEqual({ x: 11, y: 22 })
    expect(result.current.groupsRef.current[0].members).toEqual(['ei/e#ba9876543210', 'm1/a'])
    expect(result.current.nodes.map((n) => n.id)).not.toContain('ei/e')
  })

  it('keeps a copy connected before it was tagged as a box of its own, and tags it alone', () => {
    const { deps } = rig()
    const { result } = renderHook(() => useCanvasModel(deps))
    act(() => result.current.buildGraph(TWO_BOXES))
    act(() =>
      result.current.addReference(
        { database: 'ei', code: 'e', name: 'electricity', geography: 'DE', unit: 'kWh' } as never,
        { x: 5, y: 5 }
      )
    )
    const copy = result.current.nodes.find((n) => n.id.startsWith('ei/e#new-'))!.id
    // A line from the untagged copy into Part: the backend puts the new input u3 into the untagged box.
    act(() => result.current.noteConnected(copy, 'u3'))
    const after: Graph = {
      ...TWO_BOXES,
      bg_nodes: [{ ...TWO_BOXES.bg_nodes![0], uids: ['u1', 'u3'] }, TWO_BOXES.bg_nodes![1]],
      bg_edges: [
        ...TWO_BOXES.bg_edges!,
        { uid: 'u3', amount: 1, type: 'technosphere', source: 'ei/e', target: 'm1/b' }
      ]
    } as Graph
    act(() => result.current.buildGraph(after))
    const own = result.current.nodes.find((n) => n.id === copy)
    expect((own?.data as { uids?: string[] }).uids).toEqual(['u3'])
    expect((result.current.nodes.find((n) => n.id === 'ei/e')?.data as { uids?: string[] }).uids).toEqual([
      'u1'
    ])
    expect(result.current.nodes.find((n) => n.id === copy)?.position).toEqual({ x: 5, y: 5 })
    expect(result.current.edges.find((e) => (e.data as { uid?: string }).uid === 'u3')?.source).toBe(copy)
  })
})

describe('deleteSelected', () => {
  it('asks once with the count, deletes through the backend and sweeps the edges', async () => {
    const deleted: unknown[] = []
    const routes: Routes = {
      'POST /api/v1/model/activities/delete': (body: unknown) => {
        deleted.push(body)
        return { ok: true }
      },
      // The follow-up reload after the deletion answers with the surviving node.
      'GET /api/v1/model/graph/m1': {
        database: 'm1',
        nodes: [{ id: 'm1/a', name: 'Assembly', location: 'DE', unit: 'unit', external: false }],
        edges: []
      },
      'GET /api/v1/views/m1': { view: {} },
      'PUT /api/v1/views/m1': { ok: true }
    }
    const { deps, confirms } = rig(routes, 'm1')
    const { result } = renderHook(() => useCanvasModel(deps))
    // The model-switch effect (activeDb = 'm1') loads the stored view and the graph on its own.
    await waitFor(() => expect(result.current.nodes).toHaveLength(1))
    act(() => result.current.buildGraph(GRAPH))
    act(() => result.current.setSelected(['m1/a', 'm1/b']))

    act(() => result.current.deleteSelected())
    expect(confirms).toHaveLength(1)
    expect(confirms[0].message).toContain('2 selected processes')

    await act(async () => {
      confirms[0].onConfirm()
      // let the queued deletion + reload settle
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => expect(deleted).toHaveLength(2))
    // The reload answered with the survivor only — and no edge may outlive its endpoint.
    await waitFor(() => expect(result.current.nodes.map((n) => n.id)).toEqual(['m1/a']))
    expect(result.current.edges).toHaveLength(0)
    expect(result.current.selected).toEqual([])
  })
})

/** A process still used outside the selection is asked about on its own, one after the other — as Delete on
 *  a single process asks — instead of being kept with a note at the end. */
describe('deleting several processes that are still in use', () => {
  const THREE: Graph = {
    ...GRAPH,
    nodes: [
      ...GRAPH.nodes,
      { id: 'm1/c', name: 'Coating', location: 'DE', unit: 'kg', external: false }
    ] as Graph['nodes']
  } as Graph

  it('asks for each in turn, naming who uses it, and deletes only what is confirmed', async () => {
    const deleted: { code: string; force?: boolean }[] = []
    const { deps } = rig(
      {
        'GET /api/v1/views/m1': { view: {} },
        'PUT /api/v1/views/m1': { ok: true },
        'GET /api/v1/model/graph/m1': THREE,
        'POST /api/v1/model/activities/delete': (body: unknown) => {
          const b = body as { code: string; force?: boolean }
          if (b.force) return (deleted.push(b), { ok: true })
          return {
            status: 409,
            body: {
              error: {
                code: 'delete_blocked',
                message: 'in use',
                details: { consumers: [{ database: 'm2', code: 'z', name: 'Bike' }] }
              }
            }
          }
        }
      },
      'm1'
    )
    // The real dialog, wired as the Workbench wires it: it closes itself right after an answer.
    let model: ReturnType<typeof useCanvasModel> | null = null
    function Harness(): JSX.Element | null {
      const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
      model = useCanvasModel({ ...deps, setConfirm })
      return confirm ? <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} /> : null
    }
    render(<Harness />)
    await waitFor(() => expect(model!.nodes).toHaveLength(3))
    act(() => model!.deleteSelected(['m1/b', 'm1/c']))
    fireEvent.click(screen.getByText('Delete 2'))
    await screen.findByText('Process is in use (1 of 2)')
    expect(screen.getByText(/“Part” is still an input of “Bike” in the model “m2”/)).toBeTruthy()

    fireEvent.click(screen.getByText('Cancel')) // keep Part; the next question still comes
    await screen.findByText('Process is in use (2 of 2)')
    expect(screen.getByText(/“Coating” is still an input/)).toBeTruthy()
    fireEvent.click(screen.getByText('Delete anyway'))
    await waitFor(() => expect(deleted).toEqual([{ database: 'm1', code: 'c', force: true }]))
    await waitFor(() => expect(screen.queryByText(/Process is in use/)).toBeNull())
  })

  /** Both of THREE's processes in use; the forced delete answers as ``force`` says. The real dialog as the
   *  Workbench wires it, and a ``run`` that keeps errors, as the Workbench's does. */
  async function twoInUse(force: (body: { code: string }) => unknown) {
    const blocked = {
      status: 409,
      body: { error: { code: 'delete_blocked', message: 'in use', details: { consumers: [] } } }
    }
    const { deps, prism } = rig(
      {
        'GET /api/v1/views/m1': { view: {} },
        'PUT /api/v1/views/m1': { ok: true },
        'GET /api/v1/views/m2': { view: {} },
        'PUT /api/v1/views/m2': { ok: true },
        'GET /api/v1/model/graph/m1': THREE,
        'GET /api/v1/model/graph/m2': { database: 'm2', nodes: [], edges: [] },
        'POST /api/v1/model/activities/delete': (body: unknown) =>
          (body as { force?: boolean }).force ? force(body as { code: string }) : blocked
      },
      'm1'
    )
    const errors: string[] = []
    deps.run = async (fn) => {
      try {
        await fn()
      } catch (e) {
        errors.push(String(e))
      }
    }
    let model: ReturnType<typeof useCanvasModel> | null = null
    function Harness(): JSX.Element | null {
      const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
      model = useCanvasModel({ ...deps, setConfirm })
      return confirm ? <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} /> : null
    }
    const view = render(<Harness />)
    await waitFor(() => expect(model!.nodes).toHaveLength(3))
    act(() => model!.deleteSelected(['m1/b', 'm1/c']))
    fireEvent.click(screen.getByText('Delete 2'))
    await screen.findByText('Process is in use (1 of 2)')
    return { deps, prism, errors, rerender: () => view.rerender(<Harness />), model: () => model! }
  }

  it('stops asking when a forced delete fails, so its error stays in view', async () => {
    const { errors } = await twoInUse(() => ({ status: 500, body: { error: { message: 'disk full' } } }))
    fireEvent.click(screen.getByText('Delete anyway'))
    await waitFor(() => expect(errors).toHaveLength(1))
    expect(errors[0]).toContain('disk full')
    expect(screen.queryByText(/Process is in use/)).toBeNull() // Coating is not asked about over it
  })

  it('stops when another model is opened while a forced delete is under way', async () => {
    let answer: (v: unknown) => void = () => {}
    const { deps, prism, rerender, model } = await twoInUse(() => new Promise((r) => (answer = r)))
    fireEvent.click(screen.getByText('Delete anyway'))
    deps.activeDb = 'm2'
    rerender()
    await waitFor(() => expect(model().activeDbRef.current).toBe('m2'))
    const m1Reads = prism.calls.filter((c) => c.path === '/api/v1/model/graph/m1').length
    await act(async () => answer({ ok: true }))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText(/Process is in use/)).toBeNull()
    expect(prism.calls.filter((c) => c.path === '/api/v1/model/graph/m1')).toHaveLength(m1Reads)
  })

  it('removing several references says so, and names the inputs that go with them', async () => {
    const boxes = {
      ...GRAPH,
      bg_nodes: [
        { id: 'ei/s', dataset_id: 'ei/s', uids: ['u1'], name: 'steel', external: true },
        { id: 'ei/e', dataset_id: 'ei/e', uids: ['u2'], name: 'electricity', external: true }
      ],
      bg_edges: [
        { uid: 'u1', amount: 2, type: 'technosphere', source: 'ei/s', target: 'm1/b' },
        { uid: 'u2', amount: 2, type: 'technosphere', source: 'ei/e', target: 'm1/b' }
      ]
    } as unknown as Graph
    const { deps, confirms } = rig(
      {
        'GET /api/v1/views/m1': { view: {} },
        'PUT /api/v1/views/m1': { ok: true },
        'GET /api/v1/model/graph/m1': boxes
      },
      'm1'
    )
    const { result } = renderHook(() => useCanvasModel(deps))
    await waitFor(() => expect(result.current.nodes).toHaveLength(4))
    act(() => result.current.deleteSelected(['ei/s', 'ei/e']))
    expect(confirms[0].title).toBe('Remove from canvas')
    expect(confirms[0].message).toBe(
      'Remove the 2 selected references from the canvas? This deletes 2 inputs of your processes as well — Undo brings them back, one click per input.'
    )
  })
})

/**
 * A canvas still loading — or whose load failed — is empty, and saving it replaced the stored
 * arrangement with nothing.
 */
describe('saving the canvas', () => {
  it('writes nothing while the model is not on the canvas, and writes once it is', async () => {
    let releaseGraph: (v: unknown) => void = () => {}
    const { deps, prism } = rig(
      {
        'GET /api/v1/views/m1': { view: { layout: { pos: { 'm1/a': { x: 5, y: 5 } } } } },
        'GET /api/v1/model/graph/m1': () => new Promise((r) => (releaseGraph = () => r(GRAPH)))
      },
      'm1'
    )
    const { result } = renderHook(() => useCanvasModel(deps))
    await waitFor(() => expect(prism.calls.some((c) => c.path === '/api/v1/model/graph/m1')).toBe(true))
    const { flushViews } = await import('../lib/modelView')
    act(() => result.current.saveCanvas('m1')) // the graph has not arrived
    flushViews()
    expect(prism.calls.filter((c) => c.method === 'PUT')).toEqual([])

    await act(async () => releaseGraph(undefined))
    await waitFor(() => expect(result.current.nodesRef.current.length).toBeGreaterThan(0))
    act(() => result.current.saveCanvas('m1'))
    flushViews()
    await waitFor(() =>
      expect(prism.calls.some((c) => c.method === 'PUT' && c.path === '/api/v1/views/m1')).toBe(true)
    )
  })
})

/**
 * Localize, Delete and removing a supplier take a node away through a model edit, and Undo brings it back —
 * under its old id, or for Localize as the box the process came from. It came back in the fallback column,
 * without its colour and outside its group box.
 */
describe('what Undo brings back', () => {
  const STEEL: NonNullable<Graph['bg_nodes']>[number] = {
    database: 'ei',
    code: 's',
    product: 'steel',
    read_only: true,
    id: 'ei/s',
    dataset_id: 'ei/s',
    uids: ['u1'],
    tags: [],
    name: 'steel',
    location: 'GLO',
    unit: 'kg',
    external: true
  }
  const BOX: Graph = {
    ...GRAPH,
    bg_nodes: [STEEL],
    bg_edges: [{ uid: 'u1', amount: 2, type: 'technosphere', source: 'ei/s', target: 'm1/b' }]
  } as Graph
  // After Localize: the copy m1/p supplies Part through the very same input.
  const LOCALIZED: Graph = {
    ...GRAPH,
    nodes: [...GRAPH.nodes, { id: 'm1/p', name: 'steel', location: 'GLO', unit: 'kg', external: false }],
    edges: [...GRAPH.edges, { uid: 'u1', amount: 2, type: 'technosphere', source: 'm1/p', target: 'm1/b' }]
  } as Graph
  const SPOT = { x: 640, y: 410 }
  type Hook = ReturnType<typeof renderHook<ReturnType<typeof useCanvasModel>, unknown>>['result']
  const at = (r: Hook, id: string) => r.current.nodes.find((n) => n.id === id)?.position
  const members = (r: Hook) => [...(r.current.groupsRef.current[0]?.members ?? [])].sort()

  /** The model open, arranged by hand; steel painted, and in a group box with Part. */
  async function arranged(routes: Routes) {
    const { deps, confirms, prism } = rig(
      {
        'GET /api/v1/views/m1': { view: {} },
        'PUT /api/v1/views/m1': { ok: true },
        'GET /api/v1/model/graph/m1': BOX,
        ...routes
      },
      'm1'
    )
    const { result } = renderHook(() => useCanvasModel(deps))
    await waitFor(() => expect(result.current.nodes).toHaveLength(3))
    act(() =>
      result.current.setNodes((ns) => ns.map((n) => (n.id === 'ei/s' ? { ...n, position: SPOT } : n)))
    )
    result.current.posRef.current = { 'm1/a': { x: 0, y: 0 }, 'm1/b': { x: 300, y: 0 }, 'ei/s': SPOT }
    act(() => result.current.setNodeColor('ei/s', '#e11d48'))
    act(() => result.current.putGroups([{ id: 'g1', color: '#000000', members: ['ei/s', 'm1/b'] }]))
    const reload = async (g: Graph) => {
      prism.setRoute('GET /api/v1/model/graph/m1', g)
      await act(async () => {
        await result.current.reloadGraph('m1')
      })
    }
    return { result, confirms, prism, reload }
  }

  it('Localize hands spot, colour and group to the process, Undo back to the box, Redo again', async () => {
    const { result, prism, reload } = await arranged({
      'POST /api/v1/model/activities/copy': { activity: { code: 'p' } }
    })
    prism.setRoute('GET /api/v1/model/graph/m1', LOCALIZED)
    act(() => result.current.localize(['ei/s']))
    await waitFor(() => expect(result.current.nodes.map((n) => n.id)).toContain('m1/p'))
    const copy = prism.calls.find((c) => c.path === '/api/v1/model/activities/copy')
    expect(copy?.body).toMatchObject({ source_code: 's', relink_consumers: true, uids: ['u1'] })
    expect(at(result, 'm1/p')).toEqual(SPOT)
    await waitFor(() => expect(result.current.nodeColors['m1/p']).toBe('#e11d48'))
    expect(members(result)).toEqual(['m1/b', 'm1/p'])

    await reload(BOX) // Undo: the copy is gone, the input draws on steel again
    expect(at(result, 'ei/s')).toEqual(SPOT)
    expect(result.current.nodeColors['ei/s']).toBe('#e11d48')
    expect(members(result)).toEqual(['ei/s', 'm1/b'])

    await reload(LOCALIZED) // Redo
    expect(at(result, 'm1/p')).toEqual(SPOT)
    expect(result.current.nodeColors['m1/p']).toBe('#e11d48')
    expect(members(result)).toEqual(['m1/b', 'm1/p'])
  })

  it('a removed supplier comes back with its input on Undo — on its spot, in its colour and group', async () => {
    const { result, confirms, reload, prism } = await arranged({
      'POST /api/v1/model/exchanges/remove': { ok: true }
    })
    prism.setRoute('GET /api/v1/model/graph/m1', GRAPH)
    act(() => void result.current.deleteRef('ei/s'))
    await act(async () => confirms[0].onConfirm())
    await waitFor(() => expect(result.current.nodes.map((n) => n.id)).not.toContain('ei/s'))
    // The delete forgets both, so a later box of steel starts plain …
    expect(result.current.nodeColors['ei/s']).toBeUndefined()
    expect(members(result)).toEqual(['m1/b'])

    await reload(BOX) // … but Undo brings them back
    expect(at(result, 'ei/s')).toEqual(SPOT)
    expect(result.current.nodeColors['ei/s']).toBe('#e11d48')
    expect(members(result)).toEqual(['ei/s', 'm1/b'])
  })

  it('a new input of the same dataset under the old id does not bring back the deleted box', async () => {
    const { result, confirms, reload, prism } = await arranged({
      'POST /api/v1/model/exchanges/remove': { ok: true }
    })
    prism.setRoute('GET /api/v1/model/graph/m1', GRAPH)
    act(() => void result.current.deleteRef('ei/s'))
    await act(async () => confirms[0].onConfirm())
    await waitFor(() => expect(result.current.nodes.map((n) => n.id)).not.toContain('ei/s'))
    // Not an Undo: the assistant adds a fresh input from steel, which lands in a box of the same id.
    await reload({
      ...BOX,
      bg_nodes: [{ ...STEEL, uids: ['u9'] }],
      bg_edges: [{ uid: 'u9', amount: 1, type: 'technosphere', source: 'ei/s', target: 'm1/a' }]
    } as Graph)
    expect(result.current.nodeColors['ei/s']).toBeUndefined()
    expect(members(result)).toEqual(['m1/b'])
  })

  it("keeps what a model's box left with to that model — another model's box of the dataset starts plain", async () => {
    // Model m2 draws on steel through an input of the same uid (a duplicate of m1, say).
    const M2 = {
      ...BOX,
      database: 'm2',
      nodes: [{ id: 'm2/x', name: 'Other', location: 'DE', unit: 'kg', external: false }] as Graph['nodes'],
      edges: [],
      bg_edges: [{ uid: 'u1', amount: 2, type: 'technosphere', source: 'ei/s', target: 'm2/x' }]
    } as Graph
    const { deps, confirms, prism } = rig(
      {
        'GET /api/v1/views/m1': { view: {} },
        'PUT /api/v1/views/m1': { ok: true },
        'GET /api/v1/views/m2': { view: {} },
        'PUT /api/v1/views/m2': { ok: true },
        'GET /api/v1/model/graph/m1': BOX,
        'GET /api/v1/model/graph/m2': M2,
        'POST /api/v1/model/exchanges/remove': { ok: true }
      },
      'm1'
    )
    const { result, rerender } = renderHook(() => useCanvasModel(deps))
    await waitFor(() => expect(result.current.nodes).toHaveLength(3))
    act(() => result.current.setNodeColor('ei/s', '#e11d48'))
    prism.setRoute('GET /api/v1/model/graph/m1', GRAPH)
    act(() => void result.current.deleteRef('ei/s'))
    await act(async () => confirms[0].onConfirm())
    await waitFor(() => expect(result.current.nodes.map((n) => n.id)).not.toContain('ei/s'))

    deps.activeDb = 'm2'
    rerender()
    await waitFor(() => expect(result.current.nodes.map((n) => n.id)).toContain('m2/x'))
    expect(result.current.nodeColors['ei/s']).toBeUndefined()

    // Back in m1, its Undo still finds what the box left with.
    prism.setRoute('GET /api/v1/model/graph/m1', BOX)
    deps.activeDb = 'm1'
    rerender()
    await waitFor(() => expect(result.current.nodes.map((n) => n.id)).toContain('ei/s'))
    await waitFor(() => expect(result.current.nodeColors['ei/s']).toBe('#e11d48'))
  })

  it('a connected copy that was localized comes back as that copy, and Redo hands it on again', async () => {
    // Steel feeds Part (u1, its box) and, through a copy the user placed and connected, Assembly (u3).
    const both = {
      ...BOX,
      bg_nodes: [{ ...STEEL, uids: ['u1', 'u3'] }],
      bg_edges: [
        ...BOX.bg_edges!,
        { uid: 'u3', amount: 1, type: 'technosphere', source: 'ei/s', target: 'm1/a' }
      ]
    } as Graph
    const { result, prism, reload } = await arranged({
      'POST /api/v1/model/activities/copy': { activity: { code: 'p' } }
    })
    act(() =>
      result.current.addReference({ database: 'ei', code: 's', name: 'steel' } as never, { x: 9, y: 9 })
    )
    const copy = result.current.nodes.find((n) => n.id.startsWith('ei/s#new-'))!.id
    act(() => result.current.noteConnected(copy, 'u3'))
    await reload(both)
    act(() => result.current.putGroups([{ id: 'g2', color: '#000000', members: [copy, 'm1/a'] }]))
    const localized = {
      ...BOX,
      nodes: [...GRAPH.nodes, { id: 'm1/p', name: 'steel', location: 'GLO', unit: 'kg', external: false }],
      edges: [...GRAPH.edges, { uid: 'u3', amount: 1, type: 'technosphere', source: 'm1/p', target: 'm1/a' }]
    } as Graph
    prism.setRoute('GET /api/v1/model/graph/m1', localized)
    act(() => result.current.localize([copy]))
    await waitFor(() => expect(result.current.nodes.map((n) => n.id)).toContain('m1/p'))
    const g2 = () => [...(result.current.groupsRef.current.find((g) => g.id === 'g2')?.members ?? [])].sort()
    expect(g2()).toEqual(['m1/a', 'm1/p'])

    await reload(both) // Undo
    expect(at(result, copy)).toEqual({ x: 9, y: 9 })
    expect(g2()).toEqual([copy, 'm1/a'].sort())

    await reload(localized) // Redo
    expect(at(result, 'm1/p')).toEqual({ x: 9, y: 9 })
    expect(g2()).toEqual(['m1/a', 'm1/p'])
  })

  it('a deleted process comes back in its colour and its group box', async () => {
    const { result, confirms, reload, prism } = await arranged({
      'POST /api/v1/model/activities/delete': { ok: true }
    })
    act(() => result.current.setNodeColor('m1/b', '#2563eb'))
    // Part goes, and with it the inputs on it: steel has no consumer left.
    prism.setRoute('GET /api/v1/model/graph/m1', { ...GRAPH, nodes: [GRAPH.nodes[0]], edges: [] })
    act(() => result.current.deleteNode('m1/b'))
    await act(async () => confirms[0].onConfirm())
    await waitFor(() => expect(result.current.nodes.map((n) => n.id)).toEqual(['m1/a']))
    expect(result.current.nodeColors['m1/b']).toBeUndefined()

    await reload(BOX)
    expect(at(result, 'm1/b')).toEqual({ x: 300, y: 0 })
    expect(result.current.nodeColors['m1/b']).toBe('#2563eb')
    expect(members(result)).toEqual(['ei/s', 'm1/b'])
  })
})

describe('the node menu on a selection', () => {
  const TWO = {
    ...GRAPH,
    bg_nodes: [
      {
        id: 'ei/e',
        dataset_id: 'ei/e',
        uids: ['u1'],
        tags: [],
        name: 'electricity',
        location: 'DE',
        unit: 'kWh',
        external: true
      },
      {
        id: 'ei/h',
        dataset_id: 'ei/h',
        uids: ['u2'],
        tags: [],
        name: 'heat',
        location: 'DE',
        unit: 'MJ',
        external: true
      }
    ] as unknown as Graph['bg_nodes'],
    bg_edges: [
      { uid: 'u1', amount: 1, type: 'technosphere', source: 'ei/e', target: 'm1/a' },
      { uid: 'u2', amount: 1, type: 'technosphere', source: 'ei/h', target: 'm1/b' }
    ]
  } as Graph

  it('expands several boxes one after the other — an input they share gets a node under each', async () => {
    const { deps } = rig({
      'POST /api/v1/model/expand': (body: unknown) => ({
        inputs: [
          {
            database: 'ei',
            code: 'coal',
            name: 'coal',
            location: 'GLO',
            unit: 'kg',
            external: true,
            read_only: true
          }
        ],
        edges: [{ uid: null, amount: 1, source: 'ei/coal', target: `ei/${(body as { code: string }).code}` }]
      })
    })
    const { result } = renderHook(() => useCanvasModel(deps))
    act(() => result.current.buildGraph(TWO))
    act(() => result.current.expandNodes(['ei/e', 'ei/h']))
    await waitFor(() => expect(result.current.nodes).toHaveLength(6))
    expect(result.current.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['ei/coal', 'ei/coal#ei/h']))

    act(() => result.current.collapseNodes(['ei/e', 'ei/h']))
    expect(result.current.nodes.map((n) => n.id).sort()).toEqual(['ei/e', 'ei/h', 'm1/a', 'm1/b'])
  })

  it('localizes several boxes, each with its own inputs, under one reload', async () => {
    let n = 0
    const { deps, prism } = rig(
      {
        'GET /api/v1/views/m1': { view: {} },
        'PUT /api/v1/views/m1': { ok: true },
        'GET /api/v1/model/graph/m1': TWO,
        'POST /api/v1/model/activities/copy': () => ({ activity: { code: `c${++n}` } })
      },
      'm1'
    )
    const { result } = renderHook(() => useCanvasModel(deps))
    await waitFor(() => expect(result.current.nodes).toHaveLength(4))
    const graphReads = () => prism.calls.filter((c) => c.path === '/api/v1/model/graph/m1').length
    const before = graphReads()
    act(() => result.current.localize(['ei/e', 'ei/h']))
    await waitFor(() => expect(graphReads()).toBe(before + 1))
    const copies = prism.calls.filter((c) => c.path === '/api/v1/model/activities/copy').map((c) => c.body)
    expect(copies).toEqual([
      expect.objectContaining({ source_code: 'e', uids: ['u1'] }),
      expect.objectContaining({ source_code: 'h', uids: ['u2'] })
    ])
  })
})
