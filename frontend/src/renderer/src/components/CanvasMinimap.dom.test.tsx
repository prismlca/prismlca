import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react'

import CanvasMinimap from './CanvasMinimap'

/**
 * The wiring between the map and the canvas it maps.
 *
 * Not a render smoke test: what can silently break here is the join between three files. The class
 * names come from `lib/minimap.ts`, the fills that make them mean anything come from `index.css`, and
 * the minimap has to sit OUTSIDE `<ReactFlow>` (it lives in the chat dock) while still reading the
 * same store. Rename one class or drop the provider and the map goes uniformly grey, which no
 * type-check and no eye on a screenshot of a green canvas would catch.
 *
 * jsdom has no layout, so nodes carry explicit dimensions — React Flow skips an unmeasured node.
 */
const node = (id: string, x: number, data: Record<string, unknown>): Node => ({
  id,
  position: { x, y: 0 },
  width: 210,
  height: 60,
  data
})

const noop = (): void => {}

const mount = (nodes: Node[]): HTMLElement => {
  const { container } = render(
    <ReactFlowProvider>
      <ReactFlow nodes={nodes} edges={[]} />
      <CanvasMinimap />
    </ReactFlowProvider>
  )
  return container
}

describe('the canvas minimap', () => {
  it('draws one rect per process, classed as the canvas paints it', () => {
    const container = mount([
      node('a', 0, { label: 'foreground' }),
      node('b', 300, { label: 'locked', readOnly: true }),
      node('c', 600, { label: 'tagged', highlight: true }),
      node('d', 900, { label: 'coloured', color: '#9f5987' })
    ])
    const rects = [...container.querySelectorAll('.react-flow__minimap-node')]
    expect(rects).toHaveLength(4)
    expect(rects.map((r) => r.getAttribute('class'))).toEqual([
      'react-flow__minimap-node mm-node',
      'react-flow__minimap-node mm-node ext',
      'react-flow__minimap-node mm-node hl',
      'react-flow__minimap-node mm-node'
    ])
    // The user's own colour is the one fill that cannot come from a class — it is per node.
    expect(rects.map((r) => (r as SVGElement).style.fill)).toEqual(['', '', '', 'rgb(159, 89, 135)'])
  })

  it('reads the viewport from the store while sitting outside the canvas element', () => {
    // The mask's hole IS the viewport rectangle. If the provider were missing (or the minimap were
    // still nested inside <ReactFlow>), there would be no mask to find out here at all.
    const container = mount([node('a', 0, { label: 'p' })])
    const svg = container.querySelector('.canvas-minimap .react-flow__minimap-svg')
    expect(svg?.getAttribute('viewBox')).toMatch(/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/)
    expect(container.querySelector('.react-flow__minimap-mask')?.getAttribute('d')).toContain('M')
  })

  it('moves its rectangle when the canvas is panned and resizes it on zoom', () => {
    // The reason the thing exists. The rectangle is the hole in the mask path, so the path is where
    // panning and zooming have to show up — a map that drew the graph but not the viewport would
    // pass every other assertion in this file.
    const nodes = [node('a', 0, { label: 'p' }), node('b', 900, { label: 'q' })]
    const mask = (): string => document.querySelector('.react-flow__minimap-mask')?.getAttribute('d') ?? ''

    const { rerender } = render(
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={[]} viewport={{ x: 0, y: 0, zoom: 1 }} onViewportChange={noop} />
        <CanvasMinimap />
      </ReactFlowProvider>
    )
    const still = mask()

    rerender(
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={[]} viewport={{ x: -400, y: -80, zoom: 1 }} onViewportChange={noop} />
        <CanvasMinimap />
      </ReactFlowProvider>
    )
    const panned = mask()
    expect(panned).not.toBe(still)

    rerender(
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={[]} viewport={{ x: -400, y: -80, zoom: 2 }} onViewportChange={noop} />
        <CanvasMinimap />
      </ReactFlowProvider>
    )
    expect(mask()).not.toBe(panned)
  })
})

/* ---------------------------------------------------------------------------------------------
   The map as a target: a dataset dropped on it, and the pointer resting on it.
--------------------------------------------------------------------------------------------- */

/** jsdom measures nothing, and both features are geometry. These are the numbers of a real corner:
 *  a 208x132 map 16 px in from the bottom right of a 1280x800 canvas, above a 60 px chat pill. */
const STAGE = { left: 0, top: 0, width: 1280, height: 800 }
const CORNER = { left: 1056, top: 528, width: 208, height: 132 }

const stubRect = (el: Element, r: { left: number; top: number; width: number; height: number }): void => {
  const rect = { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }
  el.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect
}

const datasetDrag = (): DataTransfer =>
  ({
    types: ['application/prism-hit'],
    dropEffect: 'none',
    getData: () => '{}'
  }) as unknown as DataTransfer

/**
 * A drag event at a point, built by hand.
 *
 * `fireEvent.drop(el, { clientX })` looks like it would do this, but jsdom has no `DragEvent`, so
 * Testing Library falls back to a plain `Event` and the coordinates never arrive — which is the one
 * thing every assertion here is about. A MouseEvent carries them, and React dispatches on the type
 * name, not on the constructor.
 */
const drag = (
  type: 'dragover' | 'dragleave' | 'drop',
  el: Element,
  at: { clientX: number; clientY: number },
  dataTransfer: DataTransfer = datasetDrag()
): void => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...at })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  act(() => {
    fireEvent(el, event)
  })
}

/** A model wider than one screen: four cards over ~1100 units, so one map pixel is worth several. */
const spread = [
  node('a', 0, { label: 'a' }),
  node('b', 300, { label: 'b' }),
  node('c', 600, { label: 'c' }),
  node('d', 900, { label: 'd' })
]

const mountTarget = (
  onDropDataset?: (e: React.DragEvent, flow: { x: number; y: number }) => void
): {
  dock: HTMLElement
  stage: HTMLElement
  svg: SVGSVGElement
  onDockDrop: ReturnType<typeof vi.fn>
} => {
  const onDockDrop = vi.fn()
  const { container } = render(
    // The parent stands in for the chat dock, which forwards a drop to the canvas underneath. The map
    // must not let its own drops reach it — that would add the process twice, in two places.
    <div onDrop={onDockDrop}>
      <ReactFlowProvider>
        <ReactFlow nodes={spread} edges={[]} />
        <CanvasMinimap onDropDataset={onDropDataset} />
      </ReactFlowProvider>
    </div>
  )
  const dock = container.querySelector('.canvas-minimap-dock') as HTMLElement
  const svg = container.querySelector('svg.react-flow__minimap-svg') as SVGSVGElement
  const stage = container.querySelector('.react-flow') as HTMLElement
  stubRect(stage, STAGE)
  stubRect(dock, CORNER)
  stubRect(svg, CORNER)
  return { dock, stage, svg, onDockDrop }
}

/** Halfway across the map, in client coordinates. */
const onMap = (fx: number, fy: number): { clientX: number; clientY: number } => ({
  clientX: CORNER.left + CORNER.width * fx,
  clientY: CORNER.top + CORNER.height * fy
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a dataset dropped on the map', () => {
  it('lands where the map points in the model, not on the canvas pixel under the cursor', () => {
    // The decision, end to end. Two drops 100 px apart on the map are hundreds of units apart in the
    // model, because the map is showing ~1100 units through 208 pixels. Under the other reading —
    // the cursor straight through the viewport — the same two drops would be 100 units apart, and the
    // process would be created behind the map that took the drop.
    const drops: { x: number; y: number }[] = []
    const { dock } = mountTarget((_e, flow) => drops.push(flow))

    drag('drop', dock, onMap(0.25, 0.5))
    drag('drop', dock, {
      clientX: CORNER.left + CORNER.width * 0.25 + 100,
      clientY: CORNER.top + CORNER.height * 0.5
    })

    expect(drops).toHaveLength(2)
    expect(drops[1].x - drops[0].x).toBeGreaterThan(300)
    expect(drops[1].y).toBeCloseTo(drops[0].y, 5)
    // And it is a point in the model, i.e. somewhere in the stretch the map is showing.
    const view = svgViewBox(dock)
    expect(drops[0].x).toBeGreaterThan(view.x)
    expect(drops[0].x).toBeLessThan(view.x + view.width)
  })

  it('does not let the same drop reach the dock behind it', () => {
    const onDrop = vi.fn()
    const { dock, onDockDrop } = mountTarget(onDrop)
    drag('drop', dock, onMap(0.5, 0.5))
    expect(onDrop).toHaveBeenCalledTimes(1)
    expect(onDockDrop).not.toHaveBeenCalled()
  })

  it('leaves a drag that is not a dataset to the dock', () => {
    // A dragged file or a piece of text is not ours to interpret as a place in the model.
    const onDrop = vi.fn()
    const { dock, onDockDrop } = mountTarget(onDrop)
    const foreign = { types: ['text/plain'], getData: () => 'hello' } as unknown as DataTransfer
    drag('drop', dock, onMap(0.5, 0.5), foreign)
    expect(onDrop).not.toHaveBeenCalled()
    expect(onDockDrop).toHaveBeenCalledTimes(1)
  })

  it('marks the spot while the dataset is still in the air', () => {
    const { dock } = mountTarget()
    drag('dragover', dock, onMap(0.25, 0.75))
    expect(dock.className).toContain('aiming')
    const aim = dock.querySelector('.mm-aim') as HTMLElement
    expect(aim.style.left).toBe(`${CORNER.width * 0.25}px`)
    expect(aim.style.top).toBe(`${CORNER.height * 0.75}px`)
    expect(dock.textContent).toContain('Drop to place here')

    drag('dragleave', dock, { clientX: 10, clientY: 10 })
    expect(dock.className).not.toContain('aiming')
  })

  it('keeps aiming when the drag crosses onto the map inside the wrapper', () => {
    // `dragleave` fires for that boundary too, and taking it at face value made the indicator (and the
    // enlargement under it) flicker off in the middle of aiming.
    const { dock } = mountTarget()
    drag('dragover', dock, onMap(0.5, 0.5))
    drag('dragleave', dock, onMap(0.5, 0.5))
    expect(dock.className).toContain('aiming')
  })
})

const svgViewBox = (dock: HTMLElement): { x: number; y: number; width: number; height: number } => {
  const [x, y, width, height] = (
    dock.querySelector('svg.react-flow__minimap-svg')!.getAttribute('viewBox') ?? ''
  )
    .split(/[\s,]+/)
    .map(Number)
  return { x, y, width, height }
}

const mapWidth = (dock: HTMLElement): string | null =>
  dock.querySelector('svg.react-flow__minimap-svg')!.getAttribute('width')

describe('holding the pointer on the map to enlarge it', () => {
  const rest = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms)
    })
  }

  it('grows for a pointer that stays, and not for one that is only passing through', () => {
    // The failure mode hover has to survive: the corner is on the way to the chat input, and a map
    // that grew every time somebody reached for the chat would be worse than a small map.
    const { dock } = mountTarget()
    vi.useFakeTimers()

    fireEvent.pointerOver(dock)
    rest(200)
    expect(mapWidth(dock)).toBe('208')
    fireEvent.pointerOut(dock)
    rest(1000)
    expect(mapWidth(dock)).toBe('208')

    fireEvent.pointerOver(dock)
    rest(400)
    expect(mapWidth(dock)).toBe('520')
    expect(dock.querySelector('svg.react-flow__minimap-svg')!.getAttribute('height')).toBe('330')
    expect(dock.className).toContain('big')
  })

  it('collapses when the pointer leaves', () => {
    const { dock } = mountTarget()
    vi.useFakeTimers()
    fireEvent.pointerOver(dock)
    rest(400)
    expect(mapWidth(dock)).toBe('520')

    fireEvent.pointerOut(dock)
    expect(mapWidth(dock)).toBe('208')
  })

  it('collapses on Escape, and stays collapsed under a pointer that has not moved', () => {
    // Shrinking moves the boundary out from under the pointer, and the browser then re-evaluates
    // hover on the new layout: without a latch, Escape was undone 400 ms later by an enter the user
    // never made.
    const { dock } = mountTarget()
    vi.useFakeTimers()
    fireEvent.pointerOver(dock)
    rest(400)
    expect(mapWidth(dock)).toBe('520')

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(mapWidth(dock)).toBe('208')

    fireEvent.pointerOver(dock)
    rest(1000)
    expect(mapWidth(dock)).toBe('208')

    // Leaving and coming back is the user asking again, and is answered.
    fireEvent.pointerOut(dock)
    fireEvent.pointerOver(dock)
    rest(400)
    expect(mapWidth(dock)).toBe('520')
  })

  it('grows for a drag resting on it, and collapses once the drop is made', () => {
    // The two features meet here: aiming at a 208 px map is the reason to make it bigger, and a map
    // left enlarged after the drop would cover the canvas with nothing hovering it.
    const { dock } = mountTarget(() => {})
    vi.useFakeTimers()
    drag('dragover', dock, onMap(0.5, 0.5))
    rest(400)
    expect(mapWidth(dock)).toBe('520')

    drag('drop', dock, onMap(0.5, 0.5))
    expect(mapWidth(dock)).toBe('208')
    expect(dock.className).not.toContain('aiming')
  })

  it('stays small on a window with no room for a bigger map', () => {
    const { dock, stage } = mountTarget()
    stubRect(stage, { left: 0, top: 0, width: 300, height: 200 })
    stubRect(dock, { left: 76, top: 8, width: 208, height: 132 })
    vi.useFakeTimers()
    fireEvent.pointerOver(dock)
    rest(400)
    expect(mapWidth(dock)).toBe('208')
    expect(dock.className).not.toContain('big')
  })
})
