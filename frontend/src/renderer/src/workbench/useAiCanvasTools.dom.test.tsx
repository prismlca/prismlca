import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useAiCanvasTools, type AiCanvasToolsDeps } from './useAiCanvasTools'

/**
 * The end of an agent turn that added boxes: the chat asks for a reload with `fit`, and the canvas is
 * fitted once the rebuilt graph is in — not before, or the new boxes would still be outside the frame.
 * Off the Model view the canvas is not mounted and fits itself when shown.
 */
function setup(view: AiCanvasToolsDeps['view']) {
  let finishReload: () => void = () => {}
  const reloadGraph = vi.fn(() => new Promise<void>((resolve) => (finishReload = resolve)))
  const fitView = vi.fn()
  const canvas = {
    nodes: [],
    setNodes: vi.fn(),
    setEdges: vi.fn(),
    selected: [],
    setSelected: vi.fn(),
    nodesRef: { current: [] },
    edgesRef: { current: [] },
    posRef: { current: {} },
    rfRef: { current: { fitView } },
    autoLayout: vi.fn(),
    deleteRef: vi.fn(),
    reloadGraph,
    history: { ready: () => true }
  } as unknown as AiCanvasToolsDeps['canvas']
  const { result } = renderHook(() =>
    useAiCanvasTools({
      activeDb: 'm',
      methods: [],
      chosen: '',
      setChosen: vi.fn(),
      calcBusy: null,
      calculate: vi.fn(),
      view,
      setView: vi.fn(),
      setResultsTab: vi.fn(),
      reloadAudit: vi.fn(async () => {}),
      refreshDatabases: vi.fn(async () => []),
      reloadTagGroups: vi.fn(async () => {}),
      canvas
    })
  )
  return { refresh: result.current.chatUi.refresh, reloadGraph, fitView, finishReload: () => finishReload() }
}

describe('refresh with fit', () => {
  it('fits after the rebuilt graph is in, not before', async () => {
    const { refresh, reloadGraph, fitView, finishReload } = setup('model')
    refresh({ canvas: true, fit: true })
    expect(reloadGraph).toHaveBeenCalledWith('m')
    await new Promise((r) => setTimeout(r, 200))
    expect(fitView).not.toHaveBeenCalled()
    finishReload()
    await waitFor(() => expect(fitView).toHaveBeenCalledTimes(1))
  })

  it('leaves the framing alone without fit, and off the Model view', async () => {
    for (const [view, fit] of [
      ['model', false],
      ['results', true]
    ] as const) {
      const { refresh, fitView, finishReload } = setup(view)
      refresh({ canvas: true, fit })
      finishReload()
      await new Promise((r) => setTimeout(r, 300))
      expect(fitView).not.toHaveBeenCalled()
    }
  })
})

/**
 * Centring a process and the screenshot need the canvas on screen. From another page the Model view is
 * opened first, and they wait until it is drawn — not until the old React Flow instance answers, which
 * belongs to a canvas that is gone.
 */
describe('the wait for the drawn canvas', () => {
  function rig() {
    const rfRef: { current: unknown } = { current: { getNodes: () => [], fitView: vi.fn() } }
    const canvas = {
      setNodes: vi.fn(),
      setEdges: vi.fn(),
      selected: [],
      setSelected: vi.fn(),
      selectOnly: vi.fn(),
      nodesRef: { current: [] },
      edgesRef: { current: [] },
      posRef: { current: {} },
      rfRef,
      autoLayout: vi.fn(),
      deleteRef: vi.fn(),
      reloadGraph: vi.fn(async () => true),
      history: { ready: (db: string | null) => db === 'm' }
    } as unknown as AiCanvasToolsDeps['canvas']
    const hook = renderHook(
      ({ view }: { view: AiCanvasToolsDeps['view'] }) =>
        useAiCanvasTools({
          activeDb: 'm',
          methods: [],
          chosen: '',
          setChosen: vi.fn(),
          calcBusy: null,
          calculate: vi.fn(),
          view,
          setView: vi.fn(),
          setResultsTab: vi.fn(),
          reloadAudit: vi.fn(async () => {}),
          refreshDatabases: vi.fn(async () => []),
          reloadTagGroups: vi.fn(async () => {}),
          canvas
        }),
      { initialProps: { view: 'model' as AiCanvasToolsDeps['view'] } }
    )
    return { ...hook, rfRef }
  }

  it('drops the instance when the model view goes, and resolves once the new one has measured its boxes', async () => {
    const t = rig()
    t.rerender({ view: 'results' })
    expect(t.rfRef.current).toBeNull()
    let done: boolean | undefined
    void t.result.current.whenDrawn().then((ok) => (done = ok))
    t.rerender({ view: 'model' })
    await new Promise((r) => setTimeout(r, 120))
    expect(done).toBeUndefined() // the view is back, React Flow has not handed over its instance yet
    const boxes = [{ id: 'm/a', measured: undefined as { width: number } | undefined }]
    t.rfRef.current = { getNodes: () => boxes, fitView: vi.fn() }
    await new Promise((r) => setTimeout(r, 120))
    expect(done).toBeUndefined() // a box React Flow still hides
    boxes[0].measured = { width: 210 }
    await waitFor(() => expect(done).toBe(true))
  })
})
