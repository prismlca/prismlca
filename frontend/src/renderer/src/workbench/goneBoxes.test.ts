import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'

import type { NodeGroup } from '../lib/groups'
import { rejoinGroup, rememberGone, stashGone, takeGone, type GoneBoxes } from './goneBoxes'

const node = (id: string, x: number, y: number): Node => ({ id, position: { x, y }, data: {} }) as Node
const G1: NodeGroup = { id: 'g1', color: '#123456', label: 'Frame', members: ['a', 'b'] }

describe('what a box takes with it', () => {
  it('a delete path stashes spot, colour and group; the rebuild after it keeps them', () => {
    const gone: GoneBoxes = {}
    stashGone(['a'], [node('a', 1, 2), node('b', 3, 4)], { a: '#e11d48' }, [G1], gone)
    expect(gone.a).toEqual({ pos: { x: 1, y: 2 }, color: '#e11d48', group: G1 })
    // The process is still on the outgoing canvas when the reload after the delete runs.
    rememberGone([node('a', 1, 2), node('b', 3, 4)], new Set(['b']), gone)
    expect(gone.a.color).toBe('#e11d48')
    expect(takeGone('a', gone)?.group).toEqual(G1)
    expect(takeGone('a', gone)).toBeUndefined() // handed out once
  })

  it('gives a new box under the old id the spot, but not the colour and group of the deleted one', () => {
    const gone: GoneBoxes = {}
    const box = { ...node('ei/s', 1, 2), data: { uids: ['u1', 'u2'] } } as Node
    stashGone(['ei/s'], [box], { 'ei/s': '#e11d48' }, [{ ...G1, members: ['ei/s', 'b'] }], gone)
    const fresh = { ...gone }
    expect(takeGone('ei/s', fresh, ['u9'])).toEqual({ pos: { x: 1, y: 2 } })
    expect(takeGone('ei/s', gone, ['u2'])?.color).toBe('#e11d48') // Undo brings back one of its inputs
  })

  it('forgets what a box left with once it is back on the canvas', () => {
    const gone: GoneBoxes = { a: { pos: { x: 1, y: 2 }, color: '#e11d48' } }
    rememberGone([node('a', 5, 5)], new Set(['a']), gone)
    expect(gone).toEqual({})
  })
})

describe('rejoinGroup', () => {
  it('puts a returning node back into its box', () => {
    const now = [{ ...G1, members: ['b'] }]
    expect(rejoinGroup(now, 'a', G1)[0].members).toEqual(['b', 'a'])
  })

  it('puts the box back when the node was its last member', () => {
    expect(rejoinGroup([], 'a', G1)).toEqual([{ ...G1, members: ['a'] }])
  })

  it('leaves a node that is in a box already where it is', () => {
    const now = [{ ...G1, id: 'g2', members: ['a', 'c'] }]
    expect(rejoinGroup(now, 'a', G1)).toBe(now)
  })
})
