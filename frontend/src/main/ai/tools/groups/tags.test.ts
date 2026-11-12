import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { TOOL_BY_NAME } from '..'
import { tagGroupsForModel } from './tags'

const body = {
  groups: [
    {
      name: 'Life-cycle phase',
      color: '#123',
      values: ['Production'],
      databases: ['Bottle', 'Can', 'Jar', 'Tub']
    },
    { name: 'Component', color: '#456', values: ['Lid'], databases: ['Jar'] },
    { name: 'Supplier', color: '#789', values: [], databases: [] }
  ]
}

describe('list_tags (V492)', () => {
  it('says per group whether this model uses it and counts the others, without their names', async () => {
    const ctx: ToolCtx = {
      api: (async () => body) as ToolCtx['api'],
      ui: async () => ({}),
      activeDb: 'Bottle',
      scope: { readable: ['Can'] }
    }
    const out = String(await TOOL_BY_NAME.list_tags.run({}, ctx))
    for (const foreign of ['Jar', 'Tub']) expect(out).not.toContain(foreign)
    const groups = JSON.parse(out).groups
    expect(groups[0]).toEqual({
      name: 'Life-cycle phase',
      color: '#123',
      values: ['Production'],
      in_this_model: true,
      in_compared_models: ['Can'],
      in_other_models: 2
    })
    expect(groups[1]).toMatchObject({ in_this_model: false, in_other_models: 1 })
    expect(groups[1].in_compared_models).toBeUndefined()
    expect(groups[2]).toEqual({ name: 'Supplier', color: '#789', values: [], in_this_model: false })
  })

  it('gives an unfenced session the same view from its own model', () => {
    // An MCP session has no fence, so no comparison list: its model counts as "this", the rest are counted.
    const groups = tagGroupsForModel(body, { activeDb: 'Jar' }) as Array<Record<string, unknown>>
    expect(groups[0]).toMatchObject({ in_this_model: true, in_other_models: 3 })
    expect(groups[1]).toMatchObject({ in_this_model: true })
    expect(tagGroupsForModel({ nope: 1 }, { activeDb: 'Jar' })).toEqual([])
  })
})
