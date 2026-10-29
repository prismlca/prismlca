/**
 * Unit tests for the canvas state machine — the first tests that reach buildGraph, expand/collapse
 * and the multi-delete sweep directly instead of through a mounted Workbench. Written with the
 * wave-4.1 extraction: the hook owns the ref mirrors, so a regression in "the mirror and the state
 * disagree" (the class behind the resurrected-ghost bug on the Kimi run) turns red here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { makePrism, type PrismFixture, type Routes } from '../test/prism'
import { resetQueryCache } from '../lib/server/useQuery'
import { useCanvasModel, type CanvasModelDeps } from './useCanvasModel'
import type { Graph } from '../lib/api'
import type { ConfirmSpec } from '../views/ConfirmDialog'

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
  errors: (string | null)[]
  deps: CanvasModelDeps
}

function rig(routes: Routes = {}, activeDb: string | null = null): Rig {
  const fixture = makePrism(routes)
  ;(window as unknown as { prism: unknown }).prism = fixture.prism
  const confirms: ConfirmSpec[] = []
  const errors: (string | null)[] = []
  const deps: CanvasModelDeps = {
    run: async (fn) => {
      await fn()
    },
    activeDb,
    setConfirm: (spec) => {
      if (spec) confirms.push(spec)
    },
    setError: (msg) => errors.push(msg),
    reloadAudit: vi.fn(async () => {}),
    edgeDigits: 3
  }
  return { prism: fixture, confirms, errors, deps }
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
