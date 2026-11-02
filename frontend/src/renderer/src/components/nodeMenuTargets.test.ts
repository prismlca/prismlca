import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'

import { menuTargets, processes } from './nodeMenuTargets'

const node = (id: string, data: Record<string, unknown>): Node =>
  ({ id, position: { x: 0, y: 0 }, data }) as Node

const NODES = [
  node('ei/a', { readOnly: true, upstream: 4 }),
  node('ei/b', { readOnly: true, upstream: -1 }),
  node('ei/c', { readOnly: true, upstream: 2, expanded: true }),
  node('m1/p', { readOnly: false, upstream: 0 })
]

describe('menuTargets', () => {
  it('acts on every selected node an entry applies to when the click is inside the selection', () => {
    expect(menuTargets(NODES, ['ei/a', 'ei/b', 'ei/c', 'm1/p'], 'ei/a')).toEqual({
      expand: ['ei/a', 'ei/b'],
      collapse: ['ei/c'],
      locked: ['ei/a', 'ei/b', 'ei/c'],
      own: ['m1/p']
    })
  })

  it('acts on the clicked node alone outside the selection', () => {
    expect(menuTargets(NODES, ['ei/a', 'ei/b'], 'm1/p')).toEqual({
      expand: [],
      collapse: [],
      locked: [],
      own: ['m1/p']
    })
    expect(menuTargets(NODES, ['ei/a', 'ei/b'], 'ei/c')).toEqual({
      expand: [],
      collapse: ['ei/c'],
      locked: ['ei/c'],
      own: []
    })
  })

  it('counts in words', () => {
    expect(processes(1)).toBe('1 process')
    expect(processes(3)).toBe('3 processes')
  })
})
