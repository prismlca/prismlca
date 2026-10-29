/**
 * What a group box has to get right when nobody is looking: the rectangle it derives, the alpha rule
 * the picker previews with, the stack, and what a membership change does to the *other* boxes.
 *
 * The view store is stubbed the same way `modelView.test.ts` does it, because the last test here is
 * about the *path* the groups travel, not about the list: a group that round-trips through a mock of
 * its own store proves nothing.
 */
import { readFileSync } from 'node:fs'
import { tokenSource } from './themeTokenSource'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addGroup,
  addTarget,
  addToGroup,
  drawnGroups,
  GROUP_HEADER,
  GROUP_PAD,
  groupLabel,
  groupOf,
  groupRect,
  groupsFromTags,
  groupTints,
  groupZ,
  newGroupId,
  nextGroupColor,
  nodeBoxes,
  paintOrder,
  pruneGroups,
  readGroups,
  removeGroup,
  renameGroup,
  restack,
  softEdge,
  softTint,
  type NodeBox,
  type NodeGroup,
  type Rect
} from './groups'
import { NODE_COLORS } from './palette'

const calls: Array<{ method: string; path: string; body?: unknown }> = []

vi.stubGlobal('window', {
  prism: {
    api: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      if (method === 'GET') return { status: 200, body: { view: {} } }
      return { status: 200, body: { view: body } }
    }
  },
  addEventListener: () => {},
  removeEventListener: () => {}
})

const store: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v
  },
  removeItem: (k: string) => {
    delete store[k]
  },
  get length() {
    return Object.keys(store).length
  },
  key: (i: number) => Object.keys(store)[i] ?? null
})

const mv = await import('./modelView')

const box = (x: number, y: number, width = 210, height = 60): NodeBox => ({ x, y, width, height })
const g = (id: string, members: string[], extra: Partial<NodeGroup> = {}): NodeGroup => ({
  id,
  color: NODE_COLORS[0],
  members,
  ...extra
})

beforeEach(() => {
  calls.length = 0
  for (const k of Object.keys(store)) delete store[k]
})

describe('the rectangle a group derives from its members', () => {
  const boxes = new Map<string, NodeBox>([
    ['a', box(100, 100)],
    ['b', box(400, 300)],
    ['far', box(-500, 900)]
  ])

  it('wraps the members with padding and room for the grab strip', () => {
    const rect = groupRect(['a', 'b'], boxes)
    expect(rect).toEqual({
      x: 100 - GROUP_PAD,
      y: 100 - GROUP_PAD - GROUP_HEADER,
      width: 400 + 210 - 100 + 2 * GROUP_PAD,
      height: 300 + 60 - 100 + 2 * GROUP_PAD + GROUP_HEADER
    })
  })

  it('follows a member that moved — the box has no stored geometry to go stale', () => {
    const before = groupRect(['a', 'b'], boxes)!
    const moved = new Map(boxes)
    moved.set('b', box(900, 300))
    const after = groupRect(['a', 'b'], moved)!
    expect(after.width).toBe(before.width + 500)
    expect(after.x).toBe(before.x) // the left edge is still node 'a'
  })

  it('ignores a node that is NOT a member even when it sits inside the rectangle', () => {
    // 'inside' is geometrically enclosed by the a–b box. Membership is a list, so it must not count.
    const withIntruder = new Map(boxes).set('inside', box(250, 200))
    expect(groupRect(['a', 'b'], withIntruder)).toEqual(groupRect(['a', 'b'], boxes))
  })

  it('skips members that are off the canvas, and draws nothing when they all are', () => {
    // Collapsing a node's upstream removes it from the canvas without deleting it — membership has
    // to survive that, so an absent member is skipped rather than treated as an error.
    expect(groupRect(['a', 'gone'], boxes)).toEqual(groupRect(['a'], boxes))
    expect(groupRect(['gone', 'also-gone'], boxes)).toBeNull()
  })

  it('sizes an unmeasured node from the process card’s own width instead of dropping it', () => {
    // React Flow measures nothing offscreen and nothing in jsdom; a box that ignored such a node
    // would be drawn around a hole.
    const boxed = nodeBoxes([
      { id: 'a', position: { x: 0, y: 0 } },
      { id: 'b', position: { x: 5, y: 5 }, measured: { width: 300, height: 90 } },
      { id: 'hidden', position: { x: 0, y: 0 }, hidden: true }
    ])
    expect(boxed.get('a')).toEqual({ x: 0, y: 0, width: 210, height: 64 })
    expect(boxed.get('b')?.width).toBe(300)
    expect(boxed.has('hidden')).toBe(false)
  })
})

describe('the alpha rule', () => {
  /* The rule states itself in contrast against the canvas the box is painted on, so the check has to
     composite the colour the same way the browser will. `--bg` is #f3f5f2 light and #131c24 dark. */
  const CANVAS = { light: '#f3f5f2', dark: '#131c24' }
  const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = (rgb: number[]): number =>
    0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2])
  /** Either paint form: the translucent fill, or the strip's already-flattened hex (alpha 1). */
  const parse = (paint: string): { rgb: number[]; alpha: number } => {
    const rgba = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(paint)
    if (rgba) return { rgb: [+rgba[1] / 255, +rgba[2] / 255, +rgba[3] / 255], alpha: +rgba[4] }
    if (/^#[0-9a-f]{6}$/.test(paint)) return { rgb: channels(paint), alpha: 1 }
    throw new Error(`not a paint: ${paint}`)
  }
  /** The contrast ratio of `paint` composited over its own canvas, against that canvas. */
  const presence = (paint: string, dark: boolean): number => {
    const { rgb, alpha } = parse(paint)
    const bg = channels(dark ? CANVAS.dark : CANVAS.light)
    const over = rgb.map((c, i) => c * alpha + bg[i] * (1 - alpha))
    const [hi, lo] = [luminance(over), luminance(bg)].sort((a, b) => b - a)
    return (hi + 0.05) / (lo + 0.05)
  }

  it('paints the palette colour itself, not a shifted variant of it', () => {
    // The whole point of the change: the box wears the colour that was picked. A saturation cap made
    // the lime #93c120 a grey-green nobody would name.
    for (const dark of [false, true]) {
      for (const c of NODE_COLORS) {
        expect(parse(softTint(c, dark)).rgb.map((v) => Math.round(v * 255))).toEqual(
          [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
        )
      }
    }
    expect(softTint('#93c120', false)).toBe('rgba(147, 193, 32, 0.16)')
    expect(softTint('#93c120', true)).toBe('rgba(147, 193, 32, 0.2)')
  })

  it('reads as a hint on both canvases, and the weakest colour reaches the same presence on each', () => {
    // An alpha tuned on white vanishes on the dark canvas, because the palette's *darkest* colour is
    // the one at risk there and its *lightest* is the one at risk on paper. The two numbers exist to
    // put those two worst cases at the same distance from their own background.
    const floor = (dark: boolean): number =>
      Math.min(...NODE_COLORS.map((c) => presence(softTint(c, dark), dark)))
    for (const dark of [false, true]) {
      for (const c of NODE_COLORS) {
        expect(presence(softTint(c, dark), dark)).toBeGreaterThan(1.08) // visible
        expect(presence(softTint(c, dark), dark)).toBeLessThan(1.6) // still a hint, not a slab
      }
    }
    expect(Math.abs(floor(false) - floor(true))).toBeLessThan(0.02)
  })

  it('gives the border and the strip more presence than the fill, in both themes', () => {
    for (const dark of [false, true]) {
      for (const c of NODE_COLORS) {
        expect(presence(softEdge(c, dark), dark)).toBeGreaterThan(presence(softTint(c, dark), dark))
      }
    }
  })

  it('hands the strip over OPAQUE, at exactly the colour three times the fill’s alpha would look', () => {
    // The reason it is flattened rather than translucent: two see-through layers look almost the same
    // in either order, so a box brought forward would change its z-index and nothing else. Opaque, the
    // strip of the box in front covers the box behind it — which is the whole point of the control.
    // And it must be the *same* colour, or the border and the fill would stop being one rule.
    for (const dark of [false, true]) {
      const bg = channels(dark ? CANVAS.dark : CANVAS.light)
      for (const c of NODE_COLORS) {
        const edge = softEdge(c, dark)
        expect(edge).toMatch(/^#[0-9a-f]{6}$/) // no alpha: it covers
        const a = 3 * parse(softTint(c, dark)).alpha
        const wanted = channels(c).map((ch, i) => Math.round(255 * (ch * a + bg[i] * (1 - a))))
        expect(parse(edge).rgb.map((v) => Math.round(v * 255))).toEqual(wanted)
      }
    }
  })

  it('flattens onto the canvas colour the stylesheet actually uses', () => {
    // The canvas colour is duplicated in groups.ts because the flattening is arithmetic. This is the
    // guard: change --bg in the token source without changing it there and this fails. The tokens
    // moved from index.css to design/prism-theme.css (the binding palette file); tokenSource is the
    // one pointer every stylesheet-reading test shares.
    const css = readFileSync(new URL(tokenSource, import.meta.url), 'utf8')
    expect(css).toContain(`--bg: ${CANVAS.light};`)
    expect(css).toContain(`--bg: ${CANVAS.dark};`)
  })

  it('shows the picker exactly the colours the box will paint', () => {
    // One rule: a swatch computed differently from the fill is a lying preview.
    for (const dark of [false, true]) {
      expect(groupTints(dark)).toEqual(
        NODE_COLORS.map((color) => ({ color, tint: softTint(color, dark), edge: softEdge(color, dark) }))
      )
    }
  })

  it('does not crash on a colour that is not a hex triple', () => {
    expect(softTint('var(--green)', false)).toBe('rgba(154, 162, 168, 0.16)')
  })
})

describe('the stack', () => {
  const boxes = new Map<string, NodeBox>([
    ['a', box(0, 0)],
    ['b', box(400, 0)],
    ['c', box(800, 0)]
  ])
  // Every member here is on the canvas, so every rectangle exists.
  const entries = (list: NodeGroup[]): { group: NodeGroup; rect: Rect }[] =>
    list.map((group) => ({ group, rect: groupRect(group.members, boxes) as Rect }))

  it('keeps the old area order for boxes that have no depth yet', () => {
    // A view written before depth existed must not rearrange itself on open.
    const outer = g('outer', ['a', 'b', 'c'])
    const inner = g('inner', ['a', 'b'])
    expect(paintOrder(entries([inner, outer])).map((e) => e.group.id)).toEqual(['outer', 'inner'])
  })

  it('puts depth above area, so a raised small box is not shoved behind a big one again', () => {
    const outer = g('outer', ['a', 'b', 'c'], { depth: 1 })
    const inner = g('inner', ['a', 'b'], { depth: 0 })
    expect(paintOrder(entries([inner, outer])).map((e) => e.group.id)).toEqual(['inner', 'outer'])
  })

  it('never puts a box in front of a process or an arrow, however deep the stack', () => {
    // React Flow draws nodes and edges at z-index 0 and above. This is the invariant, as arithmetic:
    // every box in a stack of any size is strictly negative, and the frontmost is exactly -1.
    for (const count of [1, 2, 5, 40]) {
      for (let i = 0; i < count; i++) expect(groupZ(i, count)).toBeLessThan(0)
      expect(groupZ(count - 1, count)).toBe(-1)
      // …and back to front is strictly increasing, so the order on screen is the order computed.
      for (let i = 1; i < count; i++) expect(groupZ(i, count)).toBeGreaterThan(groupZ(i - 1, count))
    }
  })

  it('moves one box a single step and writes the whole order down as depths', () => {
    const list = [g('x', ['a', 'b']), g('y', ['b', 'c']), g('z', ['a', 'c'])]
    const order = ['x', 'y', 'z']
    const up = restack(list, order, 'x', 1)
    expect(up.map((n) => [n.id, n.depth])).toEqual([
      ['x', 1],
      ['y', 0],
      ['z', 2]
    ])
    // Every drawn box gets an explicit depth, not only the two that swapped: leaving the rest on the
    // area tie-break would let the next render undo the step.
    expect(up.every((n) => typeof n.depth === 'number')).toBe(true)
    // And a second call against the new order is idempotent in the other direction.
    expect(restack(up, ['y', 'x', 'z'], 'x', -1).map((n) => [n.id, n.depth])).toEqual([
      ['x', 0],
      ['y', 1],
      ['z', 2]
    ])
  })

  it('does nothing at the ends of the stack, and leaves an off-canvas box out of it', () => {
    const list = [g('x', ['a', 'b']), g('y', ['b', 'c']), g('gone', ['nowhere', 'else'], { depth: 9 })]
    const order = drawnGroups(list, boxes).map((e) => e.group.id)
    expect(order).toEqual(['x', 'y']) // 'gone' has no rectangle, so it is in no stack
    expect(restack(list, order, 'y', 1)).toBe(list) // already frontmost
    expect(restack(list, order, 'x', -1)).toBe(list) // already backmost
    expect(restack(list, order, 'gone', 1)).toBe(list) // not in the order at all
    // Restacking the drawn boxes leaves the off-canvas one's stored depth alone.
    expect(restack(list, order, 'x', 1).find((n) => n.id === 'gone')?.depth).toBe(9)
  })

  it('orders the canvas and the restack from one function, so they cannot disagree', () => {
    const list = [g('big', ['a', 'b', 'c']), g('small', ['a', 'b'], { depth: 0 })]
    expect(drawnGroups(list, boxes).map((e) => e.group.id)).toEqual(
      paintOrder(entries(list)).map((e) => e.group.id)
    )
  })
})

describe('a process belongs to one group', () => {
  const two: NodeGroup[] = [g('g1', ['a', 'b'])]

  it('refuses a group of fewer than two, and dedupes the members it is given', () => {
    expect(addGroup([], ['a'], NODE_COLORS[0])).toEqual([])
    expect(addGroup([], ['a', 'a', 'b'], NODE_COLORS[0])[0].members).toEqual(['a', 'b'])
  })

  it('hands out an id and a colour nothing else is using', () => {
    const list = addGroup(two, ['c', 'd'], nextGroupColor(two))
    expect(list[1].id).not.toBe('g1')
    expect(list[1].color).not.toBe(two[0].color)
  })

  it('MOVES a process out of the box it was in rather than sharing it', () => {
    const moved = addGroup(two, ['b', 'c'], NODE_COLORS[1])
    expect(moved.find((x) => x.id === 'g1')?.members).toEqual(['a']) // 'b' left
    expect(moved.at(-1)?.members).toEqual(['b', 'c'])
    expect(groupOf(moved, 'b')?.id).toBe(moved.at(-1)?.id)
    // A box down to one member survives: the user grouped those two on purpose, and *Add to group*
    // can put something back into it.
    expect(moved).toHaveLength(2)
  })

  it('drops a box the move emptied, without recycling its id in the same breath', () => {
    const emptied = addGroup(two, ['a', 'b', 'c'], NODE_COLORS[1])
    expect(emptied).toHaveLength(1)
    // 'g1' is gone, and the new box is NOT called 'g1' — a reused id would read as a rename in the
    // stored view instead of as one box replacing another.
    expect(emptied[0].id).not.toBe('g1')
    expect(emptied[0].members).toEqual(['a', 'b', 'c'])
  })

  it('adds to an existing box, taking the newcomers out of theirs', () => {
    const list = [g('g1', ['a', 'b']), g('g2', ['c', 'd'])]
    const added = addToGroup(list, 'g1', ['c', 'x'])
    expect(added.find((n) => n.id === 'g1')?.members).toEqual(['a', 'b', 'c', 'x'])
    expect(added.find((n) => n.id === 'g2')?.members).toEqual(['d'])
    // Nothing to add, nothing to write: identity, so the canvas does not re-render for a no-op.
    expect(addToGroup(list, 'g1', ['a', 'b'])).toBe(list)
    expect(addToGroup(list, 'nope', ['x', 'y'])).toBe(list)
  })

  it('repairs a stored list that still shares a member, keeping the first claim', () => {
    // Written by the version that allowed sharing. Repaired on read and deliberately not written
    // back — opening a model must not dirty it — so the healed list reaches disk on the next edit.
    const shared = readGroups([
      { id: 'g1', color: NODE_COLORS[0], members: ['a', 'b', 'c'] },
      { id: 'g2', color: NODE_COLORS[1], members: ['c', 'd'] },
      { id: 'g3', color: NODE_COLORS[2], members: ['c'] } // nothing left once 'c' is claimed
    ])
    expect(shared.map((n) => [n.id, n.members])).toEqual([
      ['g1', ['a', 'b', 'c']],
      ['g2', ['d']]
    ])
    expect(shared.every((n) => groupOf(shared, 'c')?.id === 'g1' || !n.members.includes('c'))).toBe(true)
    // Reading the repaired list again is a no-op: the repair is idempotent, not a slow drift.
    expect(readGroups(shared)).toEqual(shared)
  })

  it('makes a stored section safe to draw', () => {
    expect(readGroups(undefined)).toEqual([])
    expect(readGroups([{ id: 'g1' }, null, 42, { members: ['a'] }])).toEqual([])
    expect(readGroups([{ id: 'g1', members: ['a', 'a', 'b'], color: 7, depth: 'x', label: '  ' }])).toEqual([
      { id: 'g1', color: NODE_COLORS[0], members: ['a', 'b'] }
    ])
    expect(readGroups([{ id: 'g1', members: ['a', 'b'], depth: 3, label: 'Packaging' }])[0]).toMatchObject({
      depth: 3,
      label: 'Packaging'
    })
  })

  it('forgets a deleted member and drops a group whose last member is gone', () => {
    expect(pruneGroups(two, ['a'])[0].members).toEqual(['b'])
    expect(pruneGroups(two, ['a'])).toHaveLength(1)
    expect(pruneGroups(two, ['a', 'b'])).toEqual([])
    expect(pruneGroups(two, ['x'])).toBe(two) // identity: no write, no re-render
  })

  it('ungroups without touching a member', () => {
    const list = [g('g1', ['a', 'b']), g('g2', ['c', 'd'])]
    const left = removeGroup(list, 'g1')
    expect(left.map((n) => n.id)).toEqual(['g2'])
    expect(left[0].members).toEqual(['c', 'd'])
  })

  it('gives out ids that nothing in the list is using', () => {
    expect(newGroupId([g('g1', ['a', 'b']), g('g3', ['c', 'd'])])).toBe('g2')
  })
})

describe('when “Add to group” may be offered', () => {
  const list = [g('g1', ['a', 'b']), g('g2', ['c', 'd'])]

  it('offers the one group the selection touches, when the selection also reaches outside it', () => {
    expect(addTarget(list, ['a', 'x'])?.id).toBe('g1')
    expect(addTarget(list, ['a', 'b', 'x', 'y'])?.id).toBe('g1')
    expect(addTarget(list, ['c', 'x'])?.id).toBe('g2')
  })

  it('stays away when there is no single answer, or nothing to add', () => {
    expect(addTarget(list, ['a', 'c'])).toBeNull() // two groups: which one?
    expect(addTarget(list, ['a', 'b'])).toBeNull() // all of them already in it
    expect(addTarget(list, ['x', 'y'])).toBeNull() // no group in the selection at all
    expect(addTarget(list, ['a'])).toBeNull() // one process cannot be both a member and an outsider
    expect(addTarget(list, [])).toBeNull()
    expect(addTarget([], ['a', 'b'])).toBeNull()
  })
})

describe('the name on the strip', () => {
  it('falls back to the member count until a name is stored', () => {
    expect(groupLabel(g('g1', ['a', 'b', 'c']))).toBe('Group of 3')
    expect(groupLabel(g('g1', ['a', 'b'], { label: 'Packaging' }))).toBe('Packaging')
  })

  it('stores a trimmed name, and stores NOTHING for a blank one', () => {
    const named = renameGroup([g('g1', ['a', 'b'])], 'g1', '  Packaging  ')
    expect(named[0].label).toBe('Packaging')
    // Clearing the field must delete the key, not store "" — an empty string would print an empty
    // strip instead of falling back to "Group of N".
    const cleared = renameGroup(named, 'g1', '   ')
    expect('label' in cleared[0]).toBe(false)
    expect(groupLabel(cleared[0])).toBe('Group of 2')
  })

  it('renames only the box it was asked about', () => {
    const list = [g('g1', ['a', 'b']), g('g2', ['c', 'd'], { label: 'Keep me' })]
    const out = renameGroup(list, 'g1', 'New')
    expect(out.map((n) => n.label)).toEqual(['New', 'Keep me'])
  })
})

describe('boxes from a tag group', () => {
  const partition = [
    { value: 'Production', members: ['a', 'b'] },
    { value: 'Use', members: ['solo'] },
    { value: 'End-of-life', members: ['c', 'd', 'e'] }
  ]

  it('draws one box per tag, named after the tag, in its own colour', () => {
    const made = groupsFromTags([], partition)
    expect(made.created).toEqual(['Production', 'End-of-life'])
    expect(made.groups.map((n) => [n.label, n.members])).toEqual([
      ['Production', ['a', 'b']],
      ['End-of-life', ['c', 'd', 'e']]
    ])
    // Distinguishable from each other — which is exactly why the tag group's own single colour is not
    // used: every box would be the same colour and the partition would be unreadable.
    expect(made.groups[0].color).not.toBe(made.groups[1].color)
  })

  it('reports the tags it could not draw instead of dropping them silently', () => {
    const made = groupsFromTags([], partition)
    expect(made.skipped).toEqual(['Use']) // one process is not a group
    expect(made.moved).toBe(0)
  })

  it('obeys the one-group rule and says how many processes it moved', () => {
    const before = [g('hand-made', ['a', 'z'])]
    const made = groupsFromTags(before, partition)
    expect(made.moved).toBe(1) // 'a' was already in a box
    expect(made.groups.find((n) => n.id === 'hand-made')?.members).toEqual(['z'])
    expect(groupOf(made.groups, 'a')?.label).toBe('Production')
  })
})

describe('groups on the persistence path', () => {
  it('round-trips group and ungroup through the model view, not through a store of its own', () => {
    const db = 'M-groups'
    const made = addGroup(readGroups(mv.viewSync(db).groups), ['a', 'b'], NODE_COLORS[2])
    mv.viewSet(db, 'groups', made)
    // Read back the way the canvas reads it on the next open: cache → readGroups.
    expect(readGroups(mv.viewSync(db).groups)).toEqual(made)

    mv.viewSet(db, 'groups', removeGroup(readGroups(mv.viewSync(db).groups), made[0].id))
    expect(readGroups(mv.viewSync(db).groups)).toEqual([])

    // …and it goes to the backend as its own section of the model's view, leaving the others alone.
    mv.flushViews()
    const put = calls.filter((c) => c.method === 'PUT')
    expect(put).toHaveLength(1) // the debounce collapses group + ungroup into one write
    expect(put[0].path).toBe(`/api/v1/views/${encodeURIComponent(db)}`)
    expect(put[0].body).toEqual({ view: { groups: [] } })
  })

  it('carries a name and a depth through the store', () => {
    const db = 'M-named'
    let made = addGroup(addGroup([], ['a', 'b'], NODE_COLORS[0]), ['c', 'd'], NODE_COLORS[1])
    made = renameGroup(made, 'g1', 'Packaging')
    made = restack(made, ['g1', 'g2'], 'g1', 1) // g1 to the front
    mv.viewSet(db, 'groups', made)
    expect(readGroups(mv.viewSync(db).groups).map((n) => [n.id, n.label, n.depth])).toEqual([
      ['g1', 'Packaging', 1],
      ['g2', undefined, 0]
    ])
  })

  it('survives a view written by a version that never heard of groups', () => {
    store['prism.view.M-old'] = JSON.stringify({ layout: { pos: { a: { x: 1, y: 2 } } } })
    expect(readGroups(mv.viewSync('M-old').groups)).toEqual([])
  })
})
