import { describe, expect, it, vi } from 'vitest'
import { modelTools } from './model'

/**
 * Deleting a model is the one irreversible delete that had no question of its own: under the MCP's
 * third approval mode, or with the chat card off, it ran unasked while deleting one custom method
 * asked. It now asks in the window unless an approval card already did.
 */
const deleteModel = modelTools.find((t) => t.spec.function.name === 'delete_model')!

function ctx(preApproved: boolean, answer: string | null) {
  const api = vi.fn(async () => ({ deleted: 'old-test' }))
  const ui = vi.fn(async (_name: string, _args: unknown) =>
    answer ? { answers: [answer] } : { answers: [] }
  )
  return { c: { preApproved, api, ui } as never, api, ui }
}

describe('delete_model', () => {
  it('asks in the window when no approval card was answered, and deletes on "Delete"', async () => {
    const t = ctx(false, 'Delete')
    await deleteModel.run({ database: 'old-test' }, t.c)
    expect(t.ui).toHaveBeenCalledTimes(1)
    expect(t.ui.mock.calls[0][0]).toBe('ask_user')
    expect(t.api).toHaveBeenCalledWith(
      'POST',
      '/api/v1/databases/foreground/delete',
      expect.objectContaining({ database: 'old-test' })
    )
  })

  it('deletes nothing when the question is cancelled or left unanswered', async () => {
    for (const answer of ['Cancel', null]) {
      const t = ctx(false, answer)
      const out = await deleteModel.run({ database: 'old-test' }, t.c)
      expect(t.api).not.toHaveBeenCalled()
      expect(JSON.stringify(out)).toContain('cancelled')
    }
  })

  it('does not ask a second time after an approval card was allowed', async () => {
    const t = ctx(true, null)
    await deleteModel.run({ database: 'old-test' }, t.c)
    expect(t.ui).not.toHaveBeenCalled()
    expect(t.api).toHaveBeenCalledTimes(1)
  })
})
