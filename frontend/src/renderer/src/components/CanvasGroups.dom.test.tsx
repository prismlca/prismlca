import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react'

import CanvasGroups from './CanvasGroups'
import { GROUP_HEADER, GROUP_PAD, softTint, type NodeGroup } from '../lib/groups'
import { NODE_COLORS } from '../lib/palette'

/**
 * What only a mounted canvas can show: that the boxes really end up *behind* the process cards, that
 * the fill lets the canvas underneath keep working, that a raised box covers the one it overlaps
 * including its strip, and that renaming and recolouring do not turn into a drag.
 *
 * The z-index and the click-through are asserted as inline styles on purpose — they are inline in the
 * component for the same reason. A box drawn in front of the nodes, or one whose fill swallows the
 * rubber band, is still a box that renders, so a render assertion would pass through both bugs.
 *
 * jsdom has no layout, so nodes carry explicit dimensions — React Flow skips an unmeasured node, and
 * the boxes would then be sized from the fallback instead of the real cards.
 */
const node = (id: string, x: number, y = 0): Node => ({
  id,
  position: { x, y },
  width: 210,
  height: 60,
  data: { label: id }
})

const group = (id: string, color: string, members: string[], depth?: number): NodeGroup => ({
  id,
  color,
  members,
  ...(depth === undefined ? {} : { depth })
})

const mount = (
  nodes: Node[],
  groups: NodeGroup[],
  props: Partial<Parameters<typeof CanvasGroups>[0]> = {}
): { container: HTMLElement; handlers: Record<string, ReturnType<typeof vi.fn>> } => {
  const handlers = {
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onMoveEnd: vi.fn(),
    onContextMenu: vi.fn(),
    onPickColor: vi.fn(),
    onEdit: vi.fn(),
    onRename: vi.fn()
  }
  const { container } = render(
    <ReactFlowProvider>
      <ReactFlow nodes={nodes} edges={[]}>
        <CanvasGroups
          groups={groups}
          nodes={nodes}
          selected={null}
          editing={null}
          dark={false}
          {...handlers}
          {...props}
        />
      </ReactFlow>
    </ReactFlowProvider>
  )
  return { container, handlers }
}

/** The z-index of the layer one box lives on — fill and strip share it, which is the point. */
const layerOf = (container: HTMLElement, id: string): number => {
  const box = container.querySelector<HTMLElement>(`[data-group="${id}"]`)!
  return Number((box.parentElement as HTMLElement).style.zIndex)
}

describe('the group boxes on the canvas', () => {
  it('draws the box behind every process card, and lets the canvas through its fill', () => {
    const { container } = mount([node('a', 0), node('b', 400)], [group('g1', NODE_COLORS[0], ['a', 'b'])])
    const box = container.querySelector<HTMLElement>('.pgroup')!
    const grip = container.querySelector<HTMLElement>('.pgroup-grip')!
    const cards = [...container.querySelectorAll<HTMLElement>('.react-flow__node')]

    expect(cards).toHaveLength(2)
    expect(layerOf(container, 'g1')).toBeLessThan(0)
    // React Flow puts its nodes at z-index 0 (or above, when selected) — the whole box goes under that.
    for (const card of cards)
      expect(Number(card.style.zIndex || '0')).toBeGreaterThan(layerOf(container, 'g1'))
    // Inside a group the box covers most of the canvas; an interactive fill would eat the rubber band.
    expect(box.style.pointerEvents).toBe('none')
    expect(grip.style.pointerEvents).toBe('all')
    // Fill and strip are on ONE layer, so a depth applies to the whole box and not to half of it.
    expect(box.parentElement).toBe(grip.parentElement)
  })

  it('sits in React Flow’s viewport, so it pans and zooms with the nodes', () => {
    const { container } = mount([node('a', 0), node('b', 400)], [group('g1', NODE_COLORS[0], ['a', 'b'])])
    // Not merely "somewhere in the DOM": outside the viewport the box would stay put while the canvas moved.
    expect(container.querySelector('.react-flow__viewport-portal > .pgroup-box > .pgroup')).not.toBeNull()
  })

  it('wraps its members and ignores a node that only happens to sit inside', () => {
    const { container } = mount(
      [node('a', 0), node('b', 400), node('intruder', 200, 10)],
      [group('g1', NODE_COLORS[0], ['a', 'b'])]
    )
    const box = container.querySelector<HTMLElement>('.pgroup')!
    expect(box.style.transform).toBe(`translate(${-GROUP_PAD}px, ${-GROUP_PAD - GROUP_HEADER}px)`)
    expect(box.style.width).toBe(`${400 + 210 + 2 * GROUP_PAD}px`)
    // The intruder moved nothing: it is not on the member list, and geometry never makes it one.
    expect(box.style.height).toBe(`${60 + 2 * GROUP_PAD + GROUP_HEADER}px`)
  })

  it('paints two overlapping groups in their own colours, at low opacity', () => {
    const { container } = mount(
      [node('a', 0), node('b', 400), node('c', 800)],
      [group('small', NODE_COLORS[2], ['b', 'c']), group('big', NODE_COLORS[0], ['a', 'b', 'c'])]
    )
    const boxes = [...container.querySelectorAll<HTMLElement>('.pgroup')]
    // No depth on either: the old area order still decides, so a stored view does not rearrange itself.
    expect(boxes.map((b) => b.dataset.group)).toEqual(['big', 'small'])
    // The paint is the palette colour with an alpha, not a desaturated variant of it.
    expect(boxes[0].style.background).toBe(softTint(NODE_COLORS[0], false))
    expect(boxes[1].style.background).toBe(softTint(NODE_COLORS[2], false))
    expect(boxes[0].style.background).toMatch(/^rgba\(147, 193, 32, 0\.16\)$/)
  })

  it('lets a raised box cover the one it overlaps, strip included', () => {
    // The bug seen in a screenshot: one box's title strip crossing into the other box. With a depth,
    // the box in front is in front of the *whole* box behind it.
    const { container } = mount(
      [node('a', 0), node('b', 400), node('c', 800)],
      [group('lower', NODE_COLORS[1], ['a', 'b'], 0), group('raised', NODE_COLORS[3], ['b', 'c'], 1)]
    )
    expect(layerOf(container, 'raised')).toBeGreaterThan(layerOf(container, 'lower'))
    // …and both are still under every node.
    for (const card of container.querySelectorAll<HTMLElement>('.react-flow__node')) {
      expect(Number(card.style.zIndex || '0')).toBeGreaterThan(layerOf(container, 'raised'))
    }
    // The frontmost box is exactly one step below the node layer — no gap to fall into.
    expect(layerOf(container, 'raised')).toBe(-1)
  })

  it('selects on a click of the grab strip and drags the members, not itself', () => {
    const { container, handlers } = mount(
      [node('a', 0), node('b', 400)],
      [group('g1', NODE_COLORS[0], ['a', 'b'])]
    )
    const grip = container.querySelector<HTMLElement>('.pgroup-grip')!
    fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    expect(handlers.onSelect).toHaveBeenCalledWith('g1')

    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 130, clientY: 90 })
    // At zoom 1 a screen pixel is a flow unit; the box itself is never positioned, the members are.
    expect(handlers.onMove).toHaveBeenCalledWith('g1', 30, -10)
    fireEvent.pointerUp(grip, { pointerId: 1 })
    expect(handlers.onMoveEnd).toHaveBeenCalledWith('g1')

    // …and the drag really ended: further movement must not keep dragging the group.
    handlers.onMove.mockClear()
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 400, clientY: 400 })
    expect(handlers.onMove).not.toHaveBeenCalled()
  })

  it('offers its own context menu on the strip', () => {
    const { container, handlers } = mount(
      [node('a', 0), node('b', 400)],
      [group('g1', NODE_COLORS[0], ['a', 'b'])]
    )
    fireEvent.contextMenu(container.querySelector('.pgroup-grip')!, { clientX: 12, clientY: 34 })
    expect(handlers.onSelect).toHaveBeenCalledWith('g1')
    expect(handlers.onContextMenu.mock.calls[0][1]).toBe('g1')
  })

  it('draws nothing for a group whose members have all left the canvas', () => {
    // Collapsing a node's upstream is not deleting it: the group stays, the box just has nothing to wrap.
    const { container } = mount([node('a', 0)], [group('g1', NODE_COLORS[0], ['x', 'y'])])
    expect(container.querySelector('.pgroup')).toBeNull()
  })
})

describe('the name on the strip', () => {
  const two = [node('a', 0), node('b', 400)]

  it('prints the member count until a name is stored', () => {
    const { container } = mount(two, [group('g1', NODE_COLORS[0], ['a', 'b'])])
    expect(container.querySelector('.pgroup-name')?.textContent).toBe('Group of 2')
    const { container: named } = mount(two, [
      { id: 'g1', color: NODE_COLORS[0], members: ['a', 'b'], label: 'Packaging' }
    ])
    expect(named.querySelector('.pgroup-name')?.textContent).toBe('Packaging')
  })

  // The name used to start an edit on click, and to do that it had to take the
  // pointer-down away from the drag. The name sits in the middle of the handle, so the part of the
  // strip you naturally grab was the one part that did not move the group. Renaming is a double-click
  // or the menu's "Rename…" now — and the point of this test is the *drag*, not the absent edit.
  it('is part of the drag handle: a drag started on the name moves the group', () => {
    const { container, handlers } = mount(two, [group('g1', NODE_COLORS[0], ['a', 'b'])])
    const name = container.querySelector<HTMLElement>('.pgroup-name')!
    fireEvent.pointerDown(name, { button: 0, pointerId: 1, clientX: 100, clientY: 100 })
    // The listener sits on the strip; the name is inside it, so the event has to reach it — which is
    // exactly what the removed `stopPropagation` used to prevent.
    fireEvent.pointerMove(name, { pointerId: 1, clientX: 130, clientY: 90 })
    expect(handlers.onMove).toHaveBeenCalledWith('g1', 30, -10)
    fireEvent.pointerUp(name, { pointerId: 1 })
    expect(handlers.onMoveEnd).toHaveBeenCalledWith('g1')
  })

  it('does not start an edit when it is clicked', () => {
    const { container, handlers } = mount(two, [group('g1', NODE_COLORS[0], ['a', 'b'])])
    const name = container.querySelector<HTMLElement>('.pgroup-name')!
    fireEvent.pointerDown(name, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.click(name)
    expect(handlers.onEdit).not.toHaveBeenCalled()
    // The edit itself still works — the menu and a double-click start it, and `editing` comes from outside.
    const { container: editing } = mount(two, [group('g1', NODE_COLORS[0], ['a', 'b'])], {
      editing: 'g1'
    })
    expect(editing.querySelector('.pgroup-rename')).not.toBeNull()
  })

  // A double-click on the strip used to reach React Flow, which zoomed the canvas in — the name looked
  // editable and the gesture people try first did something else entirely.
  it('starts an edit on a double-click, and the canvas does not zoom', () => {
    const { container, handlers } = mount(two, [group('g1', NODE_COLORS[0], ['a', 'b'])])
    // React Flow's double-click zoom listens natively on its renderer element, below React's root.
    const zoom = vi.fn()
    container.querySelector('.react-flow__renderer')!.addEventListener('dblclick', zoom)
    fireEvent.doubleClick(container.querySelector('.pgroup-name')!)
    expect(handlers.onEdit).toHaveBeenCalledWith('g1')
    expect(zoom).not.toHaveBeenCalled()

    // The dot keeps its own meaning: a double-click there neither renames nor zooms.
    handlers.onEdit.mockClear()
    fireEvent.doubleClick(container.querySelector('.pgroup-dot')!)
    expect(handlers.onEdit).not.toHaveBeenCalled()
    expect(zoom).not.toHaveBeenCalled()

    // Nor does a double-click in the field (selecting a word) restart the edit or zoom.
    const { container: editing, handlers: h2 } = mount(two, [group('g1', NODE_COLORS[0], ['a', 'b'])], {
      editing: 'g1'
    })
    const zoom2 = vi.fn()
    editing.querySelector('.react-flow__renderer')!.addEventListener('dblclick', zoom2)
    fireEvent.doubleClick(editing.querySelector('.pgroup-rename')!)
    expect(h2.onEdit).not.toHaveBeenCalled()
    expect(zoom2).not.toHaveBeenCalled()
  })

  it('commits on Enter, on blur, and stores an EMPTY name as no name at all', () => {
    const { container } = mount(two, [
      { id: 'g1', color: NODE_COLORS[0], members: ['a', 'b'], label: 'Packaging' }
    ])
    const { container: editing, handlers: h2 } = mount(
      two,
      [{ id: 'g1', color: NODE_COLORS[0], members: ['a', 'b'], label: 'Packaging' }],
      { editing: 'g1' }
    )
    expect(container.querySelector('.pgroup-rename')).toBeNull() // only while editing
    const input = editing.querySelector<HTMLInputElement>('.pgroup-rename')!
    // The field opens on the *stored* label, never on the "Group of N" fallback — offering the fallback
    // would turn it into a stored name the moment somebody pressed Enter.
    expect(input.value).toBe('Packaging')
    expect(input.placeholder).toBe('Group of 2')

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(h2.onRename).toHaveBeenCalledWith('g1', '   ') // trimming to nothing is the store's job
    expect(h2.onEdit).toHaveBeenCalledWith(null)

    h2.onRename.mockClear()
    fireEvent.change(input, { target: { value: 'End of life' } })
    fireEvent.blur(input)
    expect(h2.onRename).toHaveBeenCalledWith('g1', 'End of life')
  })

  it('leaves the stored name alone on Escape', () => {
    const { container, handlers } = mount(
      two,
      [{ id: 'g1', color: NODE_COLORS[0], members: ['a', 'b'], label: 'Packaging' }],
      { editing: 'g1' }
    )
    const input = container.querySelector<HTMLInputElement>('.pgroup-rename')!
    fireEvent.change(input, { target: { value: 'oops' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(handlers.onRename).not.toHaveBeenCalled()
    expect(handlers.onEdit).toHaveBeenCalledWith(null)
  })

  it('does not let the app act on the keys a name is being typed with', () => {
    // Delete on the canvas deletes the selected processes, and that handler is on `window` (see the
    // key effect in Workbench). Typing a name must not reach it.
    const { container } = mount(two, [group('g1', NODE_COLORS[0], ['a', 'b'])], { editing: 'g1' })
    const heard = vi.fn()
    window.addEventListener('keydown', heard)
    try {
      fireEvent.keyDown(container.querySelector('.pgroup-rename')!, { key: 'Delete' })
      expect(heard).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', heard)
    }
  })
})

describe('the colour dot on the strip', () => {
  const two = [node('a', 0), node('b', 400)]

  it('wears the group’s colour at full strength, so the box says which colour it is', () => {
    const { container } = mount(two, [group('g1', NODE_COLORS[3], ['a', 'b'])])
    const dot = container.querySelector<HTMLElement>('.pgroup-dot')!
    // Not the tint: at 16 % alpha the fill barely names its own colour, and the dot is what does.
    expect(dot.style.background).toBe('rgb(23, 121, 186)')
  })

  it('hands its SCREEN rectangle up instead of opening a popover of its own', () => {
    // The dot lives inside the zoomed viewport at a negative z-index — a popover parented to it could
    // never come out in front of the process cards, so the picker is opened outside the canvas.
    const { container, handlers } = mount(two, [group('g1', NODE_COLORS[0], ['a', 'b'])])
    const dot = container.querySelector<HTMLElement>('.pgroup-dot')!
    fireEvent.click(dot)
    expect(handlers.onPickColor).toHaveBeenCalledTimes(1)
    expect(handlers.onPickColor.mock.calls[0][1]).toBe('g1')
    expect(handlers.onPickColor.mock.calls[0][0]).toBeInstanceOf(Object)
    expect(container.querySelector('.tint-swatches')).toBeNull() // nothing opened inside the canvas
  })

  it('does not drag the group when the dot is grabbed', () => {
    const { container, handlers } = mount(two, [group('g1', NODE_COLORS[0], ['a', 'b'])])
    const dot = container.querySelector<HTMLElement>('.pgroup-dot')!
    fireEvent.pointerDown(dot, { button: 0, pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(dot, { pointerId: 1, clientX: 90, clientY: 10 })
    expect(handlers.onMove).not.toHaveBeenCalled()
  })
})
