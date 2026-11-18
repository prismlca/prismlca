/**
 * The contribution tree's meta as the model reads it: the per-input impacts carry names instead of exchange
 * uids, and the tree's root split is not called "direct" beside two other meanings of the word.
 */
import { describe, expect, it, vi } from 'vitest'
import { foregroundInputs, readableMeta } from './contributionReply'
import type { ToolCtx } from './context'

const graph = {
  nodes: [{ id: 'fg/M', name: 'Manufacturing' }],
  bg_nodes: [
    { id: 'bg/steel#1', name: 'market for steel, low-alloyed', location: 'GLO' },
    { id: 'bg/elec#1', name: 'market for electricity, medium voltage', location: 'DE' }
  ],
  bg_edges: [
    { uid: 'u-steel', source: 'bg/steel#1', target: 'fg/M' },
    { uid: 'u-elec', source: 'bg/elec#1', target: 'fg/M' }
  ]
}

const ctx = (api: ToolCtx['api']) => ({ api }) as unknown as ToolCtx

describe('foregroundInputs', () => {
  it('names every input by process and dataset, largest first, with its share', async () => {
    const api = vi.fn<ToolCtx['api']>(async () => graph)
    const rows = await foregroundInputs(ctx(api), 'fg', { inputs: { 'u-elec': 4, 'u-steel': 6 }, total: 12 })
    expect(api).toHaveBeenCalledWith('GET', '/api/v1/model/graph/fg')
    expect(rows).toEqual([
      { process: 'Manufacturing', input: 'market for steel, low-alloyed', geo: 'GLO', impact: 6, share: 0.5 },
      {
        process: 'Manufacturing',
        input: 'market for electricity, medium voltage',
        geo: 'DE',
        impact: 4,
        share: 4 / 12
      }
    ])
  })

  it('reads nothing when there are no inputs, and gives up quietly when the graph cannot be read', async () => {
    const api = vi.fn<ToolCtx['api']>(async () => {
      throw new Error('no graph')
    })
    expect(await foregroundInputs(ctx(api), 'fg', { inputs: {}, total: 1 })).toBeUndefined()
    expect(api).not.toHaveBeenCalled()
    expect(await foregroundInputs(ctx(api), 'fg', { inputs: { u: 1 }, total: 1 })).toBeUndefined()
  })
})

describe('readableMeta', () => {
  it('drops the uid map and renames the root split', () => {
    const meta = { total: 12, direct: 3, upstream: 9, foreground_direct: 2, inputs: { u: 1 }, unit: 'kg' }
    const rows = [{ process: 'P', input: 'I', impact: 1, share: 0.1 }]
    const out = readableMeta(meta, rows, 25)
    expect(out).toEqual({
      total: 12,
      foreground_direct: 2,
      unit: 'kg',
      tree_remainder: 3,
      foreground_inputs: rows
    })
  })

  it('says how many inputs a cut list leaves out', () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      process: 'P',
      input: `I${i}`,
      impact: 4 - i,
      share: 0
    }))
    const out = readableMeta({ total: 10, direct: 0 }, rows, 2)
    expect(out.foreground_inputs).toHaveLength(2)
    expect(out.foreground_inputs_cut).toMatch(/2 largest of 4/)
  })
})
