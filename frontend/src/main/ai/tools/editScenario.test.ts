import { describe, expect, it } from 'vitest'
import type { ToolCtx } from './context'
import { TOOL_BY_NAME } from './registry'
import { withoutEmptyArgs } from '../emptyArgs'

/**
 * `edit_scenario` action="update": a scenario renamed, or its description rewritten, without deleting and
 * re-creating it. Re-creating gave it a new id and a new place at the end of the list, and the audit log
 * recorded a change of content where only a word had changed.
 */
describe('edit_scenario action="update"', () => {
  const tool = TOOL_BY_NAME['edit_scenario']

  const run = async (
    args: Record<string, unknown>,
    activeDb: string | null = 'demo-model'
  ): Promise<{ calls: Array<{ path: string; body: any }>; out: any }> => {
    const calls: Array<{ path: string; body: any }> = []
    const ctx = {
      api: async (_method: string, path: string, body?: unknown) => {
        calls.push({ path, body })
        return { scenario: { id: 's1', name: 'Short haul' }, scenarios: [{ id: 's1' }, { id: 's2' }] }
      },
      ui: async () => ({ ok: true }),
      activeDb
    } as unknown as ToolCtx
    // The executor's own step before a tool runs: empty optional fields read as left out.
    const normalised = withoutEmptyArgs('edit_scenario', tool.spec.function.parameters, args)
    return { calls, out: JSON.parse(String(await tool.run(normalised, ctx))) }
  }

  it('sends only the fields it is given, so the overrides and the rest stay as they are', async () => {
    const renamed = await run({ action: 'update', id: 's1', name: 'Short haul', description: '' })
    expect(renamed.calls).toEqual([
      {
        path: '/api/v1/scenarios/update',
        body: { database: 'demo-model', id: 's1', name: 'Short haul', description: '', source: 'ai' }
      }
    ])
    // The written scenario comes back, not the copy of every other one.
    expect(renamed.out).toEqual({ scenario: { id: 's1', name: 'Short haul' } })

    const reworded = await run({ action: 'update', id: 's1', description: '100 km by lorry', name: '' })
    expect(reworded.calls[0].body).toEqual({
      database: 'demo-model',
      id: 's1',
      description: '100 km by lorry',
      source: 'ai'
    })
  })

  it('refuses overrides before anything is sent, and says how one is changed', async () => {
    for (const extra of [{ overrides: { dist: 100 } }, { param: 'dist', value: 100 }]) {
      const { calls, out } = await run({ action: 'update', id: 's1', name: 'X', ...extra })
      expect(calls).toEqual([])
      expect(out.error).toContain('name and the description only, and nothing was changed')
      expect(out.error).toContain('action="set_value" (id, param, value)')
    }
    // A number field padded with 0 is not an override: `value` names nothing without `param`.
    expect((await run({ action: 'update', id: 's1', name: 'X', value: 0 })).calls).toHaveLength(1)
  })

  it('names what is missing instead of sending a request the endpoint cannot read', async () => {
    const noId = await run({ action: 'update', name: 'X' })
    expect(noId.calls).toEqual([])
    expect(noId.out.error).toContain('needs the scenario id')
    const nothing = await run({ action: 'update', id: 's1', name: '' })
    expect(nothing.calls).toEqual([])
    expect(nothing.out.error).toBe('action="update" needs a new name, a new description, or both.')
    expect((await run({ action: 'update', id: 's1', name: 'X' }, null)).out.error).toBe('No model is open.')
  })

  it('is listed in the description and in the action field the model reads', () => {
    const fn = tool.spec.function
    expect(fn.description).toContain('"update" renames a scenario or rewrites its description')
    expect(JSON.stringify(fn.parameters)).toContain('create | set_value | update | duplicate | delete')
  })
})
