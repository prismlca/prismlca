import type { Edge } from '@xyflow/react'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import {
  ARROW_COLOR,
  arrowMarker,
  arrowSize,
  collectShares,
  highlightEdges,
  HOT_COLOR,
  HAND_PAN_BUTTONS,
  HOT_EXTRA_WIDTH,
  PAN_BUTTONS,
  splitId
} from './canvas'
import type { ShareTreeNode } from './canvas'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('splitId', () => {
  it('splits a canvas id into database and code', () => {
    expect(splitId('My Model/abc123')).toEqual(['My Model', 'abc123'])
  })

  it('splits on the first slash only (codes may contain slashes)', () => {
    expect(splitId('db/code/with/slashes')).toEqual(['db', 'code/with/slashes'])
  })
})

describe('arrowSize', () => {
  it('keeps the rendered tip roughly constant: size scales inversely with stroke width', () => {
    // markerUnits="strokeWidth" multiplies the marker by the stroke width, so
    // size × width should stay near the 26px target across the Sankey range.
    for (const w of [1.6, 2, 4, 6.5]) {
      expect(arrowSize(w) * w).toBeGreaterThan(20)
      expect(arrowSize(w) * w).toBeLessThan(33)
    }
  })

  it('clamps to the 4–16 range at the extremes', () => {
    expect(arrowSize(0.1)).toBe(16)
    expect(arrowSize(13)).toBe(4)
  })
})

describe('arrowMarker', () => {
  it('builds a closed-arrow marker in the shared edge colour', () => {
    const m = arrowMarker(1.6) as { type: string; width: number; height: number; color: string }
    expect(m.type).toBe('arrowclosed')
    expect(m.width).toBe(m.height)
    expect(m.width).toBe(arrowSize(1.6))
    expect(m.color).toBe(ARROW_COLOR)
  })
  it('takes another colour for the highlighted arrows', () => {
    const m = arrowMarker(1.6, HOT_COLOR) as { color: string }
    expect(m.color).toBe(HOT_COLOR)
  })
})

describe('highlightEdges', () => {
  const edge = (id: string, source: string, target: string, w = 1.6): Edge => ({
    id,
    source,
    target,
    zIndex: 20,
    style: { stroke: ARROW_COLOR, strokeWidth: w },
    markerEnd: arrowMarker(w)
  })
  const edges = [edge('a', 'x', 'y'), edge('b', 'y', 'z', 4), edge('c', 'p', 'q')]

  it('returns the very same array when nothing is highlighted', () => {
    expect(highlightEdges(edges, new Set())).toBe(edges)
  })
  it('marks only the arrows touching a highlighted node — in and out, not the chain behind', () => {
    const out = highlightEdges(edges, new Set(['y']))
    expect(out.map((e) => e.className)).toEqual(['hot', 'hot', undefined])
    expect(out[2]).toBe(edges[2])
  })
  it('turns a marked arrow green, thicker, and lifts it above its neighbours', () => {
    const [a, b] = highlightEdges(edges, new Set(['y']))
    expect(a.style).toEqual({ stroke: HOT_COLOR, strokeWidth: 1.6 + HOT_EXTRA_WIDTH })
    expect(a.zIndex).toBe(21)
    expect((a.markerEnd as { color: string }).color).toBe(HOT_COLOR)
    // A Sankey-thick arrow keeps its share width and just grows by the same step.
    expect(b.style?.strokeWidth).toBe(4 + HOT_EXTRA_WIDTH)
    expect((b.markerEnd as { width: number }).width).toBe(arrowSize(4))
  })
  it('keeps an existing class beside the marker class', () => {
    const [a] = highlightEdges([{ ...edges[0], className: 'x' }], new Set(['x']))
    expect(a.className).toBe('x hot')
  })
})

describe('collectShares', () => {
  const tree: ShareTreeNode = {
    db: 'model',
    c: 'root',
    shr: 1,
    ch: [
      {
        db: 'model',
        c: 'production',
        shr: 0.6,
        ch: [{ db: 'ecoinvent', c: 'elec', shr: 0.25 }]
      },
      {
        db: 'model',
        c: 'use',
        shr: 0.4,
        ch: [{ db: 'ecoinvent', c: 'elec', shr: 0.3 }]
      }
    ]
  }

  it('keys shares by the full db/code canvas id', () => {
    const shares = collectShares(tree, 'model')
    expect(shares['model/root']).toBe(1)
    expect(shares['model/production']).toBe(0.6)
    expect(shares['ecoinvent/elec']).toBeCloseTo(0.55)
  })

  it('sums the disjoint contributions of a process reached through several branches', () => {
    // 'elec' feeds both production and use — the overlay must show its total
    // flow-through (0.25 + 0.3), not whichever branch the walk visited last.
    expect(collectShares(tree, 'model')['ecoinvent/elec']).toBeCloseTo(0.55)
  })

  it('does not confuse same-code activities across databases', () => {
    const t: ShareTreeNode = {
      db: 'model',
      c: 'x',
      shr: 1,
      ch: [{ db: 'ecoinvent', c: 'x', shr: 0.2 }]
    }
    const shares = collectShares(t, 'model')
    expect(shares['model/x']).toBe(1)
    expect(shares['ecoinvent/x']).toBe(0.2)
  })

  it('falls back to the calculated database when a node carries no db field', () => {
    const t: ShareTreeNode = { c: 'legacy', shr: 1 }
    expect(collectShares(t, 'model')['model/legacy']).toBe(1)
  })
})

describe('PAN_BUTTONS', () => {
  it('pans with the middle button and nothing else', () => {
    // A tripwire, not logic: the right button (2) is the canvas context menu — empty canvas, group
    // box and node each open a different one — and the left button (0) draws the selection box.
    expect(PAN_BUTTONS).toEqual([1])
  })

  it('is what the canvas is actually configured with', () => {
    // Pinning the constant is worth nothing if the component passes its own literal.
    expect(read('../Workbench.tsx')).toContain('panOnDrag={hand ? HAND_PAN_BUTTONS : PAN_BUTTONS}')
  })

  it('lets the hand tool add the left button, never the right one', () => {
    // The right button is the context menu in the hand mode too.
    expect(HAND_PAN_BUTTONS).toEqual([0, 1])
  })
})

describe('the rectangle left behind by a box selection', () => {
  /**
   * React Flow paints two rectangles the same way: the rubber band you drag
   * (`.react-flow__selection`) and the bounding box it mounts around the selection *after* the
   * release (`.react-flow__nodesselection-rect`) — which is why the band looked like it stayed.
   * The fix is in `styles/canvas.css`, and jsdom cannot prove it (it drops the `var()` paint React Flow
   * declares, so a rendered assertion would pass with or without our rule). So this reads the two
   * stylesheets: it fails if React Flow starts painting the box some other way, and it fails if
   * anyone widens our rule to the band, which must keep its fill.
   */
  const ours = read('../styles/canvas.css')
  const theirs = read('../../../../node_modules/@xyflow/react/dist/style.css')

  it('is painted by React Flow with exactly the two properties we neutralise', () => {
    const rule = theirs.match(/\.react-flow__nodesselection-rect,\s*\n?\.react-flow__selection\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    const props = [...(rule?.[1] ?? '').matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]).sort()
    expect(props).toEqual(['background', 'border'])
  })

  it('is painted out in our stylesheet, and only it', () => {
    expect(ours).toContain('.react-flow__nodesselection-rect { background: transparent; border: none; }')
    // Left mounted on purpose: React Flow focuses it to nudge a whole selection with the arrow keys.
    expect(ours).not.toMatch(/\.react-flow__nodesselection-rect[^{]*\{[^}]*display:\s*none/)
    expect(ours).not.toMatch(/\.react-flow__selection\s*\{/)
  })
})
