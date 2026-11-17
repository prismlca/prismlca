import { describe, expect, it, vi } from 'vitest'
import type { ToolCtx } from '../context'
import { TOOL_BY_NAME } from '..'
import { tagGroupsOf } from './tags'

const body = {
  database: 'Bottle',
  groups: [
    {
      name: 'Life-cycle phase',
      color: '#123',
      values: ['Production', 'Use', 'Refurbishment'],
      used: true,
      unused: ['Refurbishment']
    },
    { name: 'Component', color: '#456', values: ['Lid'], used: true, unused: [] }
  ]
}

const ctxWith = (api: ToolCtx['api'], activeDb: string | null = 'Bottle'): ToolCtx => ({
  api,
  ui: async () => ({}),
  activeDb
})

describe('list_tags', () => {
  it('lists the session model’s own groups, and names the values nobody carries', async () => {
    const api = vi.fn(async () => body)
    const out = JSON.parse(String(await TOOL_BY_NAME.list_tags.run({}, ctxWith(api as ToolCtx['api']))))
    expect(api).toHaveBeenCalledWith('GET', '/api/v1/model/tag-groups?database=Bottle')
    expect(out.groups).toEqual([
      {
        name: 'Life-cycle phase',
        color: '#123',
        values: ['Production', 'Use', 'Refurbishment'],
        unused: ['Refurbishment']
      },
      { name: 'Component', color: '#456', values: ['Lid'] }
    ])
  })

  it('reads another model’s groups when that model is named', async () => {
    const api = vi.fn(async () => body)
    await TOOL_BY_NAME.list_tags.run({ database: 'Can / 0.33 l' }, ctxWith(api as ToolCtx['api']))
    expect(api).toHaveBeenCalledWith('GET', '/api/v1/model/tag-groups?database=Can%20%2F%200.33%20l')
  })

  it('answers an activity’s tags beside the session model’s groups', async () => {
    const api = vi.fn(async (_m: string, path: string) =>
      path.startsWith('/api/v1/model/tags/') ? [{ dimension: 'Component', value: 'Lid' }] : body
    )
    const out = JSON.parse(
      String(
        await TOOL_BY_NAME.list_tags.run({ database: 'Bottle', code: 'abc' }, ctxWith(api as ToolCtx['api']))
      )
    )
    expect(out.activity_tags).toEqual([{ dimension: 'Component', value: 'Lid' }])
    expect(out.groups).toHaveLength(2)
  })

  it('says so when no model is open, instead of asking the backend for nobody’s groups', async () => {
    const api = vi.fn(async () => body)
    const out = JSON.parse(String(await TOOL_BY_NAME.list_tags.run({}, ctxWith(api as ToolCtx['api'], null))))
    expect(out.error).toMatch(/No model is open/)
    expect(api).not.toHaveBeenCalled()
  })

  it('tolerates an answer without groups', () => {
    expect(tagGroupsOf({ nope: 1 })).toEqual([])
  })
})

describe('edit_tags on the model’s own groups', () => {
  it('sends the session’s model with every group action', async () => {
    const api = vi.fn(async () => ({ ok: true }))
    const ctx = ctxWith(api as ToolCtx['api'])
    await TOOL_BY_NAME.edit_tags.run({ action: 'create_group', name: 'Component' }, ctx)
    await TOOL_BY_NAME.edit_tags.run({ action: 'add_value', group: 'Component', value: 'Lid' }, ctx)
    await TOOL_BY_NAME.edit_tags.run(
      { action: 'merge_value', group: 'Component', value: 'Lid', into: 'Cap' },
      ctx
    )
    await TOOL_BY_NAME.edit_tags.run({ action: 'merge_group', name: 'Part', into: 'Component' }, ctx)
    const sent = api.mock.calls.map((c) => [
      (c as unknown[])[1],
      ((c as unknown[])[2] as { database?: string }).database
    ])
    expect(sent).toEqual([
      ['/api/v1/model/tag-groups', 'Bottle'],
      ['/api/v1/model/tag-groups/values', 'Bottle'],
      ['/api/v1/model/tag-groups/values/merge', 'Bottle'],
      ['/api/v1/model/tag-groups/merge', 'Bottle']
    ])
  })

  it('takes the model the call names over the session’s', async () => {
    const api = vi.fn(async () => ({ ok: true }))
    await TOOL_BY_NAME.edit_tags.run(
      { action: 'add_value', database: 'Can', group: 'Component', value: 'Lid' },
      ctxWith(api as ToolCtx['api'])
    )
    expect(api).toHaveBeenCalledWith(
      'POST',
      '/api/v1/model/tag-groups/values',
      expect.objectContaining({ database: 'Can', group: 'Component', value: 'Lid' })
    )
  })

  it('refuses a group action without a model, in words', async () => {
    const api = vi.fn(async () => ({ ok: true }))
    const out = JSON.parse(
      String(
        await TOOL_BY_NAME.edit_tags.run(
          { action: 'create_group', name: 'X' },
          ctxWith(api as ToolCtx['api'], null)
        )
      )
    )
    expect(out.error).toMatch(/No model is open/)
    expect(api).not.toHaveBeenCalled()
  })

  it('writes a batch of assignments as one set per value, with nothing added first', async () => {
    const api = vi.fn(async () => ({ set: 1 }))
    await TOOL_BY_NAME.edit_tags.run(
      {
        action: 'assign',
        group: 'Life-cycle phase',
        assignments: [
          { keys: [{ database: 'Bottle', code: 'a' }], value: 'Production' },
          { keys: [{ uid: 'f'.repeat(32) }], value: 'Raw materials' }
        ]
      },
      ctxWith(api as ToolCtx['api'])
    )
    expect(api.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      '/api/v1/model/tags/set',
      '/api/v1/model/tags/set'
    ])
  })
})
