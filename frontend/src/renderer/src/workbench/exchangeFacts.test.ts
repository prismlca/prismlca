import { describe, expect, it } from 'vitest'
import type { Node } from '@xyflow/react'
import { exchangeFacts } from './exchangeFacts'

const box = (id: string, data: Record<string, unknown>): Node => ({ id, position: { x: 0, y: 0 }, data })

describe('exchangeFacts', () => {
  it("names the supplier's reference product as the flow and counts the amount in its unit", () => {
    const nodes = [
      box('ei/s', {
        label: 'market for steel, low-alloyed',
        product: 'steel, low-alloyed',
        geo: 'GLO',
        unit: 'kilogram'
      }),
      box('m1/a', { label: 'Assembly', geo: null, unit: 'unit' })
    ]
    expect(exchangeFacts(nodes, 'ei/s', 'm1/a')).toEqual({
      facts: [
        { label: 'Flow', value: 'steel, low-alloyed' },
        { label: 'From', value: 'market for steel, low-alloyed · GLO' },
        { label: 'Into', value: 'Assembly' }
      ],
      unit: 'kg'
    })
  })

  it('falls back to the process name when the box carries no product', () => {
    const nodes = [box('m1/p', { label: 'Part', unit: 'pallet place' }), box('m1/a', { label: 'Assembly' })]
    const out = exchangeFacts(nodes, 'm1/p', 'm1/a')
    expect(out.facts[0]).toEqual({ label: 'Flow', value: 'Part' })
    expect(out.unit).toBe('pallet place') // an unknown unit stays whole — the arrow label may cut it
  })
})
