import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { TOOL_BY_NAME } from '..'
import { softError } from '../../execute'

describe('edit_process on a code that is no process', () => {
  const ctx = (): ToolCtx => ({
    api: (async (method: string, path: string) => {
      if (method === 'POST' && path === '/api/v1/model/activities/fields')
        throw new Error("Activity 'T2' / '4a4690f4' not found.")
      return []
    }) as ToolCtx['api'],
    ui: async () => ({}),
    activeDb: 'T2'
  })

  it('answers with an error the run counts as a rejected call, not as a write that went through', async () => {
    // A scenario id passed as the process code: the backend refuses, and the refusal has to reach
    // the trace as one — as bare text the call was booked "ok".
    const out = String(
      await TOOL_BY_NAME.edit_process.run({ code: '4a4690f4', comment: 'placeholder' }, ctx())
    )
    expect(softError(out)).toBe("Activity 'T2' / '4a4690f4' not found.")
  })

  it('still answers an edit that went through with what the backend returned', async () => {
    const ok: ToolCtx = {
      api: (async () => ({ code: 'abc', name: 'Frame' })) as ToolCtx['api'],
      ui: async () => ({}),
      activeDb: 'T2'
    }
    const out = String(await TOOL_BY_NAME.edit_process.run({ code: 'abc', comment: 'steel tube' }, ok))
    expect(softError(out)).toBeUndefined()
    expect(JSON.parse(out)).toMatchObject({ code: 'abc' })
  })

  it('reports the same failure per item in a batch', async () => {
    const out = JSON.parse(
      String(
        await TOOL_BY_NAME.edit_process.run(
          {
            processes: [
              { code: 'a', comment: 'x' },
              { code: 'b', comment: 'y' }
            ]
          },
          ctx()
        )
      )
    )
    expect(out.failed).toBe(2)
  })
})
