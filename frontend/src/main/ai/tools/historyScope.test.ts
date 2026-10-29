import { describe, expect, it } from 'vitest'
import { historyTools } from './groups/history'
import type { ToolCtx } from './context'

/**
 * Undo is scoped to the model: the assistant's undo never takes back a change in
 * another model. Its look-ups have to ask about the same model, or `get_audit` reports a can_undo that
 * the scoped undo then refuses.
 */
function run(name: string, args: Record<string, unknown>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const ctx = {
    activeDb: 'Garden hose',
    api: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      return {}
    }
  } as unknown as ToolCtx
  const tool = historyTools.find((t) => t.spec.function.name === name)!
  return { calls, done: tool.run(args, ctx) }
}

describe('the assistant’s undo and its look-ups', () => {
  it('get_audit asks about the session’s model', async () => {
    const { calls, done } = run('get_audit', {})
    await done
    expect(calls.map((c) => c.path)).toEqual([
      '/api/v1/model/audit?database=Garden%20hose',
      '/api/v1/model/history?database=Garden%20hose'
    ])
  })

  it('history sends the session’s model with the step', async () => {
    const { calls, done } = run('history', { action: 'undo' })
    await done
    expect(calls[0]).toMatchObject({ path: '/api/v1/model/undo', body: { database: 'Garden hose' } })
  })
})
