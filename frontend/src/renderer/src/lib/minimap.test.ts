import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'

import {
  ENLARGE_CLEARANCE,
  MINIMAP_SIZE,
  enlargedMinimapSize,
  minimapFlowPoint,
  minimapNodeClass,
  minimapNodeColor,
  parseMinimapViewBox,
  showMinimap
} from './minimap'

/**
 * The minimap's job is to be a smaller truth about the canvas, not a second opinion on it.
 *
 * (These two also carry a performance contract that no test can express: React Flow memoises the
 * minimap's whole node layer on their identity, so they must stay module-level constants. Inline them
 * into JSX and every rect re-renders on every pan frame — see the comment in minimap.ts.)
 */
const node = (data: Record<string, unknown>): Node => ({
  id: 'db/code',
  type: 'prism',
  position: { x: 0, y: 0 },
  data
})

describe('what a node looks like on the minimap', () => {
  it('gives a plain foreground process no inline colour, so CSS (and the theme) decides', () => {
    expect(minimapNodeColor(node({ label: 'p' }))).toBe('')
    expect(minimapNodeClass(node({ label: 'p' }))).toBe('mm-node')
  })

  it('keeps the colour the user assigned to the process', () => {
    // Colour-coding is the one node property the user sets by hand; a map that dropped it would
    // stop being a map of THIS canvas.
    expect(minimapNodeColor(node({ color: '#9f5987' }))).toBe('#9f5987')
  })

  it('marks a locked background process, which the canvas draws greyed and dashed', () => {
    expect(minimapNodeClass(node({ readOnly: true }))).toBe('mm-node ext')
  })

  it('lets the tag highlight win over locked — highlighting answers a question just asked', () => {
    expect(minimapNodeClass(node({ readOnly: true, highlight: true }))).toBe('mm-node hl')
  })

  it('survives a node with no data at all rather than throwing inside the store subscription', () => {
    // The minimap reads every node in the store, including one a caller built without `data`. A
    // throw here happens inside React Flow's per-node subscription, i.e. it takes the canvas down.
    const bare = { id: 'x', position: { x: 0, y: 0 } } as Node
    expect(minimapNodeColor(bare)).toBe('')
    expect(minimapNodeClass(bare)).toBe('mm-node')
  })
})

describe('when there is a map to show', () => {
  it('shows nothing for an empty model', () => {
    // A model with no processes would get a grey box with a rectangle in it, on top of the canvas
    // that is asking the user to add their first process.
    expect(showMinimap(0)).toBe(false)
  })

  it('shows the map for a single node', () => {
    // Deliberately NOT hidden: React Flow's bounds are the union of the node bounds and the
    // viewport, so one node cannot collapse the scale to a point — the rect stays meaningful.
    expect(showMinimap(1)).toBe(true)
    expect(showMinimap(400)).toBe(true)
  })
})

/**
 * Where a dataset dropped on the map ends up.
 *
 * The decision this encodes: a point on the map names a point in the MODEL, not the canvas pixel the
 * map is covering. The two readings are hundreds of units apart for the same pixel — that difference
 * is the test, because a regression to the other reading would still produce a plausible number.
 */
describe('the point on the map', () => {
  /** A 208x132 map in the bottom-right corner of a 1280x800 canvas. */
  const rect = { left: 1056, top: 528, width: 208, height: 132 }
  /** ~4160 x 2640 units of model, as React Flow writes it into the SVG's viewBox. */
  const view = { x: -100, y: -50, width: 4160, height: 2640 }

  it('names the place in the model the pixel stands for', () => {
    expect(minimapFlowPoint({ x: 1076, y: 548 }, rect, view)).toEqual({ x: 300, y: 350 })
  })

  it('is nowhere near the canvas point under the cursor — which is the whole decision', () => {
    // The other reading: the pointer, straight through an identity viewport. It would put the process
    // behind the map that took the drop, ~780 units to the right of where the user pointed IN the
    // model. Both numbers are legal positions, which is why this is asserted and not eyeballed.
    const pointer = { x: 1076, y: 548 }
    const underCursor = { x: pointer.x, y: pointer.y } // screenToFlowPosition at zoom 1, no pan
    const onMap = minimapFlowPoint(pointer, rect, view)!
    expect(onMap.x).toBeLessThan(underCursor.x - 700)
    expect(onMap.y).toBeGreaterThan(underCursor.y - 250)
  })

  it('reaches both corners of the model exactly', () => {
    expect(minimapFlowPoint({ x: 1056, y: 528 }, rect, view)).toEqual({ x: -100, y: -50 })
    expect(minimapFlowPoint({ x: 1264, y: 660 }, rect, view)).toEqual({ x: 4060, y: 2590 })
  })

  it('refuses an unmeasured map instead of dividing by its width', () => {
    // jsdom, a hidden model page, a map mid-mount: a zero rect would otherwise place the process at
    // Infinity, and React Flow renders that as a node nobody can ever find again.
    expect(minimapFlowPoint({ x: 10, y: 10 }, { ...rect, width: 0 }, view)).toBeNull()
    expect(minimapFlowPoint({ x: 10, y: 10 }, { ...rect, height: 0 }, view)).toBeNull()
  })
})

describe("reading the map's projection off the SVG", () => {
  it('takes the four numbers React Flow wrote, spaces or commas', () => {
    expect(parseMinimapViewBox('-100 -50 4160 2640')).toEqual({ x: -100, y: -50, width: 4160, height: 2640 })
    expect(parseMinimapViewBox(' -100,-50, 4160 , 2640 ')).toEqual({
      x: -100,
      y: -50,
      width: 4160,
      height: 2640
    })
  })

  it('says no rather than guessing when the attribute is missing or degenerate', () => {
    // The attribute is the only thing that makes a pixel mean a place. Without it there is no answer,
    // and a made-up one would place the process somewhere arbitrary.
    expect(parseMinimapViewBox(null)).toBeNull()
    expect(parseMinimapViewBox('')).toBeNull()
    expect(parseMinimapViewBox('0 0 100')).toBeNull()
    expect(parseMinimapViewBox('0 0 100 abc')).toBeNull()
    expect(parseMinimapViewBox('0 0 0 0')).toBeNull()
  })
})

/**
 * How big the map may grow while the pointer rests on it.
 *
 * The enlargement keeps the map's own corner and takes room upwards and leftwards, so the two things
 * that can go wrong are running off the left of the stage and sliding under the canvas toolbar in the
 * top right. Both are geometry, so both are arithmetic here rather than something to notice on a
 * screenshot of one window size.
 */
describe('the enlarged map', () => {
  /** The map's resting corner, 16 px in from the bottom right of a stage, above the chat pill. */
  const corner = (stage: { width: number; height: number }, pill = 60) => ({
    left: stage.width - 16 - MINIMAP_SIZE.width,
    top: stage.height - 16 - pill - MINIMAP_SIZE.height,
    right: stage.width - 16,
    bottom: stage.height - 16 - pill
  })
  const stageEdges = (stage: { width: number; height: number }) => ({
    left: 0,
    top: 0,
    right: stage.width,
    bottom: stage.height
  })
  /** The box the enlarged map would occupy: it keeps its right and bottom edges. */
  const placed = (size: { width: number; height: number }, anchor: ReturnType<typeof corner>) => ({
    left: anchor.right - size.width,
    top: anchor.bottom - size.height
  })

  it('grows to a size worth the interruption on a large window', () => {
    const stage = { width: 1600, height: 900 }
    const size = enlargedMinimapSize(stageEdges(stage), corner(stage))
    expect(size).toEqual({ width: 520, height: 330 })
  })

  it('stays inside the stage and clear of the toolbar, large window and small', () => {
    for (const stage of [
      { width: 1600, height: 900 },
      { width: 1280, height: 800 },
      { width: 620, height: 430 }
    ]) {
      const anchor = corner(stage)
      const size = enlargedMinimapSize(stageEdges(stage), anchor)
      const box = placed(size, anchor)
      expect(box.left).toBeGreaterThanOrEqual(ENLARGE_CLEARANCE.left)
      expect(box.top).toBeGreaterThanOrEqual(ENLARGE_CLEARANCE.top)
    }
  })

  it('is limited by the height, not by the fixed factor, on a short window', () => {
    // The failure this prevents: a fixed 520x330 on a 430 px tall stage reaches up over the canvas
    // toolbar, i.e. the map hides the controls the user would reach for next.
    const stage = { width: 620, height: 430 }
    const size = enlargedMinimapSize(stageEdges(stage), corner(stage))
    expect(size.height).toBe(430 - 16 - 60 - ENLARGE_CLEARANCE.top)
    expect(size.width).toBeLessThan(520)
    // Still the map's aspect ratio, so the model is not stretched on a small screen.
    expect(size.width / size.height).toBeCloseTo(MINIMAP_SIZE.width / MINIMAP_SIZE.height, 1)
  })

  it('keeps the resting size when there is no room, and when nothing is measured yet', () => {
    const tiny = { width: 300, height: 200 }
    expect(enlargedMinimapSize(stageEdges(tiny), corner(tiny))).toEqual(MINIMAP_SIZE)
    // An unmeasured stage (jsdom, an offscreen window) makes every ratio NaN. Small, not enormous.
    const zero = { left: 0, top: 0, right: 0, bottom: 0 }
    expect(enlargedMinimapSize(zero, zero)).toEqual(MINIMAP_SIZE)
  })
})
