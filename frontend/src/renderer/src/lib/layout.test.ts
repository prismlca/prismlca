/**
 * Auto-layout and group boxes: the one thing this has to prove is that arranging a model **with**
 * groups separates their boxes and arranging one **without** groups is untouched.
 *
 * The second half matters more than the first. Making the ordinary Auto-layout worse in order to
 * satisfy grouped models would be a bad trade, so it is asserted as an equality against a plain
 * (non-compound) dagre graph built here — not as "looks about the same".
 */
import Dagre from '@dagrejs/dagre'
import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'

import { layoutWithDagre } from './layout'
import { groupRect, nodeBoxes, type Rect } from './groups'

const W = 210
const H = 64

const node = (id: string): Node => ({ id, position: { x: 0, y: 0 }, width: W, height: H, data: {} })
const edge = (s: string, t: string): Edge => ({ id: `${s}->${t}`, source: s, target: t })

/** The screenshot's shape: a root, three phase hubs, and the markets that feed two of them. */
const NODES = ['root', 'eol', 'pack', 'use', 'w1', 'w2', 'w3', 'w4', 'm1', 'm2', 'm3', 'm4', 'm5'].map(node)
const EDGES = [
  edge('eol', 'root'),
  edge('pack', 'root'),
  edge('use', 'root'),
  ...['w1', 'w2', 'w3', 'w4'].map((w) => edge(w, 'eol')),
  ...['m1', 'm2', 'm3', 'm4', 'm5'].map((m) => edge(m, 'pack'))
]
/** Deliberately the pairing seen in a real model: the treatment markets and the use phase in one
 *  box, the packaging markets in another — two boxes whose members dagre has no reason to keep apart. */
const CLUSTERS = [
  ['w1', 'w2', 'w3', 'w4', 'use'],
  ['m1', 'm2', 'm3', 'm4', 'm5']
]

const rects = (laid: Node[]): Rect[] => {
  const boxes = nodeBoxes(laid)
  return CLUSTERS.map((members) => groupRect(members, boxes) as Rect)
}
const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

describe('auto-layout with group boxes', () => {
  it('arranges a model with no groups exactly as a plain dagre graph would', () => {
    // The guarantee that grouping costs nothing to everybody else. `compound: true` with no parent set
    // has to be a no-op, and this is the assertion that says so.
    const plain = new Dagre.graphlib.Graph()
    plain.setDefaultEdgeLabel(() => ({}))
    plain.setGraph({
      rankdir: 'LR',
      ranker: 'tight-tree',
      nodesep: 34,
      ranksep: 150,
      edgesep: 24,
      marginx: 40,
      marginy: 40
    })
    NODES.forEach((n) => plain.setNode(n.id, { width: W, height: H }))
    EDGES.forEach((e) => plain.setEdge(e.source, e.target))
    Dagre.layout(plain)

    const laid = layoutWithDagre(NODES, EDGES)
    for (const n of laid) {
      const p = plain.node(n.id)
      expect(n.position).toEqual({ x: p.x - W / 2, y: p.y - H / 2 })
    }
  })

  it('separates two group boxes that plainly overlap without the clusters', () => {
    const before = rects(layoutWithDagre(NODES, EDGES))
    expect(overlap(before[0], before[1])).toBeGreaterThan(0) // the bug, reproduced

    const after = rects(layoutWithDagre(NODES, EDGES, CLUSTERS))
    expect(overlap(after[0], after[1])).toBe(0)
  })

  it('never drops or doubles a node, and stays deterministic', () => {
    const once = layoutWithDagre(NODES, EDGES, CLUSTERS)
    const twice = layoutWithDagre(NODES, EDGES, CLUSTERS)
    expect(once.map((n) => n.id).sort()).toEqual(NODES.map((n) => n.id).sort())
    expect(once.map((n) => n.position)).toEqual(twice.map((n) => n.position))
    // No two process cards land on top of each other — a cluster must not pack members into a heap.
    for (let i = 0; i < once.length; i++) {
      for (let j = i + 1; j < once.length; j++) {
        const a = once[i].position
        const b = once[j].position
        expect(Math.abs(a.x - b.x) >= W || Math.abs(a.y - b.y) >= H).toBe(true)
      }
    }
  })

  it('ignores a cluster it cannot use instead of failing on it', () => {
    // A group whose members are (nearly all) off the canvas, and a group of one: a cluster of one
    // constrains nothing, and a member dagre has never heard of would throw if it were set as a child.
    const laid = layoutWithDagre(NODES, EDGES, [['w1'], ['ghost', 'phantom'], ['w2', 'ghost']])
    expect(laid).toHaveLength(NODES.length)
    expect(laid.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true)
  })
})
