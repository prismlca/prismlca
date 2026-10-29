/**
 * The canvas's own undo history through the canvas model: what makes a step (auto-layout, painting, group
 * boxes, a drag that moved something), what does not (a write that follows from something else), and that
 * taking a step back and bringing it back restores the arrangement exactly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { makePrism, type Routes } from '../test/prism'
import { resetQueryCache } from '../lib/server/useQuery'
import { useCanvasModel, type CanvasModelDeps } from './useCanvasModel'
import { beginWorkspaceSwitch, endWorkspaceSwitch } from '../lib/modelView'

beforeEach(() => resetQueryCache())

const ROUTES: Routes = {
  'GET /api/v1/model/graph/m1': {
    database: 'm1',
    nodes: [
      { id: 'm1/a', name: 'Assembly', location: 'DE', unit: 'unit', external: false },
      { id: 'm1/b', name: 'Part', location: 'DE', unit: 'kg', external: false }
    ],
    edges: [{ uid: 'u-ab', amount: 0.5, type: 'technosphere', source: 'm1/b', target: 'm1/a' }]
  },
  'GET /api/v1/views/m1': { view: {} },
  'PUT /api/v1/views/m1': { ok: true },
  // A model without processes: loaded, and empty.
  'GET /api/v1/model/graph/m2': { database: 'm2', nodes: [], edges: [] },
  'GET /api/v1/views/m2': { view: {} },
  'PUT /api/v1/views/m2': { ok: true },
  // A model whose first load fails and a later one succeeds.
  'GET /api/v1/model/graph/m3': () =>
    m3Loads++ === 0
      ? { status: 500, body: { error: { message: 'down' } } }
      : { database: 'm3', nodes: [], edges: [] },
  'GET /api/v1/views/m3': { view: {} },
  'PUT /api/v1/views/m3': { ok: true }
}
let m3Loads = 0

async function mounted() {
  const fixture = makePrism(ROUTES)
  ;(window as unknown as { prism: unknown }).prism = fixture.prism
  const deps = (activeDb: string): CanvasModelDeps => ({
    // Like the app's runner: a failed request becomes the error line, it does not escape.
    run: async (fn) => {
      await fn().catch(() => {})
    },
    activeDb,
    setConfirm: () => {},
    setError: () => {},
    reloadAudit: vi.fn(async () => {}),
    edgeDigits: 3
  })
  const hook = renderHook((p: CanvasModelDeps) => useCanvasModel(p), { initialProps: deps('m1') })
  await waitFor(() => expect(hook.result.current.history.ready('m1')).toBe(true))
  return {
    get current() {
      return hook.result.current
    },
    switchTo: (db: string) => hook.rerender(deps(db))
  }
}

const posOf = (r: { current: ReturnType<typeof useCanvasModel> }, id: string) =>
  r.current.nodes.find((n) => n.id === id)!.position

describe('the canvas undo history', () => {
  it('takes back an auto-layout and brings it back', async () => {
    const r = await mounted()
    act(() => r.current.setNodes((ns) => ns.map((n, i) => ({ ...n, position: { x: 900 + i, y: 900 } }))))
    const laidFrom = posOf(r, 'm1/a')
    act(() => r.current.autoLayout())
    const laid = posOf(r, 'm1/a')
    expect(laid).not.toEqual(laidFrom)
    expect(r.current.history.top('m1', 'undo')?.label).toBe('Auto-layout')
    act(() => void r.current.history.undo('m1'))
    expect(posOf(r, 'm1/a')).toEqual(laidFrom)
    expect(r.current.posRef.current['m1/a']).toEqual(laidFrom)
    act(() => void r.current.history.redo('m1'))
    expect(posOf(r, 'm1/a')).toEqual(laid)
  })

  it('takes back painting, grouping and a drag, each on its own', async () => {
    const r = await mounted()
    act(() => r.current.paintNodes(['m1/a'], '#c33'))
    act(() => r.current.groupSelection(['m1/a', 'm1/b']))
    const from = posOf(r, 'm1/b')
    act(() => r.current.history.begin())
    act(() =>
      r.current.setNodes((ns) => ns.map((n) => (n.id === 'm1/b' ? { ...n, position: { x: 5, y: 7 } } : n)))
    )
    act(() => r.current.history.end('Move process', { id: 'm1/b', position: { x: 5, y: 7 } }))
    expect(r.current.history.top('m1', 'undo')?.label).toBe('Move process')

    act(() => void r.current.history.undo('m1'))
    expect(posOf(r, 'm1/b')).toEqual(from)
    expect(r.current.groups).toHaveLength(1)
    act(() => void r.current.history.undo('m1'))
    expect(r.current.groups).toHaveLength(0)
    expect(r.current.nodeColors['m1/a']).toBe('#c33')
    act(() => void r.current.history.undo('m1'))
    expect(r.current.nodeColors['m1/a']).toBeUndefined()
    expect(r.current.history.top('m1', 'undo')).toBeUndefined()
    act(() => void r.current.history.redo('m1'))
    expect(r.current.nodeColors['m1/a']).toBe('#c33')
  })

  it('makes no step of a box let go where it was, nor of a write that follows from something else', async () => {
    const r = await mounted()
    const at = posOf(r, 'm1/a')
    act(() => r.current.history.begin())
    act(() => r.current.history.end('Move process', { id: 'm1/a', position: at }))
    act(() => r.current.putGroups([{ id: 'g', label: 'x', color: '#000', members: ['m1/a', 'm1/b'] }]))
    act(() => r.current.setNodeColor('m1/b', '#0a0'))
    expect(r.current.history.top('m1', 'undo')).toBeUndefined()
  })

  it('is the workspace’s: after a switch, a namesake model starts without the old steps', async () => {
    const r = await mounted()
    act(() => r.current.paintNodes(['m1/a'], '#c33'))
    expect(r.current.history.top('m1', 'undo')).toBeDefined()
    const fence = await beginWorkspaceSwitch()
    endWorkspaceSwitch(fence)
    expect(r.current.history.top('m1', 'undo')).toBeUndefined()
  })

  it('takes nothing back while its model loads, and keeps the step; a loaded empty model is ready', async () => {
    const r = await mounted()
    act(() => r.current.paintNodes(['m1/a'], '#c33'))
    act(() => r.switchTo('m2')) // loading m2: m1 is not on the canvas
    let took = true
    act(() => void (took = r.current.history.undo('m1')))
    expect(took).toBe(false)
    expect(r.current.history.top('m1', 'undo')?.label).toBe('Colour processes')
    await waitFor(() => expect(r.current.history.ready('m2')).toBe(true)) // no processes, still loaded
    act(() => r.current.autoLayout())
    act(() => void (took = r.current.history.undo('m2')))
    expect(took).toBe(true)
  })

  it('makes one step of a run of arrow-key nudges that moved a box, and none when nothing moved', async () => {
    const r = await mounted()
    const box = document.createElement('div')
    box.className = 'react-flow__node'
    document.body.appendChild(box)
    const tick = () => act(() => new Promise((res) => setTimeout(res, 0)))
    const press = async (moveTo?: number, ctrlKey = false) => {
      act(
        () =>
          void box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, ctrlKey }))
      )
      // What React Flow does with the key, when it moves anything at all (not in hand mode).
      if (moveTo !== undefined)
        act(() =>
          r.current.setNodes((ns) =>
            ns.map((n) => (n.id === 'm1/a' ? { ...n, position: { x: moveTo, y: 0 } } : n))
          )
        )
      await tick()
    }
    await press() // hand mode: the key moves nothing
    expect(r.current.history.top('m1', 'undo')).toBeUndefined()
    await press(301)
    await press(302)
    expect(r.current.history.top('m1', 'undo')?.label).toBe('Nudge processes')
    act(() => void r.current.history.undo('m1'))
    expect(r.current.history.top('m1', 'undo')).toBeUndefined()
    await press(400, true) // Ctrl+arrow moves a focused selection in React Flow too
    expect(r.current.history.top('m1', 'undo')?.label).toBe('Nudge processes')
    box.remove()
  })

  it('becomes ready with the load that reaches the canvas — also one that recovers a failed first load', async () => {
    const r = await mounted()
    act(() => r.switchTo('m3'))
    await act(() => new Promise((res) => setTimeout(res, 20)))
    expect(r.current.history.ready('m3')).toBe(false) // the first load failed
    await act(async () => void (await r.current.reloadGraph('m3')))
    expect(r.current.history.ready('m3')).toBe(true)
  })
})
