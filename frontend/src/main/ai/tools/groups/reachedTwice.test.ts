import { describe, expect, it } from 'vitest'
import { TOOL_BY_NAME } from '..'
import { fakeExchanges } from '../../test/fakeExchanges'
import { REACHED_TWICE_NOTE } from './reachedTwice'

const run = async (args: Record<string, unknown>, ctx: any): Promise<any> =>
  JSON.parse(String(await TOOL_BY_NAME.edit_exchange.run(args, ctx)))

const PATH = '/api/v1/model/reached-twice/M'

// What the backend says about the wheelbarrow: the tray hangs under delivery directly and again under the
// final assembly that was put in between.
const TRAY = {
  process: 'delivery',
  input: 'tray',
  unit: 'unit',
  amount: 1,
  direct_uids: ['d-tray'],
  also_through: 'delivery → final assembly → tray',
  through_uids: ['f-tray']
}

/** The fake backend, plus the reached-twice endpoint answering `reply` (or failing) and recording its asks. */
function backend(reply: unknown[] | Error, seed: Parameters<typeof fakeExchanges>[1] = []) {
  const fake = fakeExchanges('M', seed)
  const asked: any[] = []
  const api = fake.ctx.api
  const ctx = {
    ...fake.ctx,
    api: async (m: string, p: string, b?: unknown) => {
      if (p === PATH) {
        asked.push(b)
        if (reply instanceof Error) throw reply
        return { reached_twice: reply }
      }
      return api(m, p, b)
    }
  }
  return { fake, asked, ctx }
}

describe('an add that makes a process take one of the model’s processes twice', () => {
  it('goes through, and the answer names both links once the batch has run', async () => {
    const { fake, asked, ctx } = backend([TRAY])
    const out = await run(
      {
        action: 'add',
        activity_code: 'delivery',
        exchanges: [
          { input_database: 'M', input_code: 'final', amount: 1 },
          { input_database: 'ei', input_code: 'lorry', amount: 8.28 }
        ]
      },
      ctx
    )
    expect(out.succeeded).toBe(2)
    expect(fake.on('delivery')).toHaveLength(2)
    // One ask for the whole call, with the link between the model's own processes only.
    expect(asked).toEqual([{ touching: [['delivery', 'final']] }])
    expect(out.reached_twice).toEqual([TRAY])
    expect(out.reached_twice_note).toBe(REACHED_TWICE_NOTE)
  })

  it('carries the hint on a single add too', async () => {
    const { ctx } = backend([TRAY])
    const out = await run(
      { action: 'add', activity_code: 'delivery', input_database: 'M', input_code: 'final', amount: 1 },
      ctx
    )
    expect(out.uid).toBeTruthy()
    expect(out.reached_twice).toEqual([TRAY])
  })

  it('does not ask when the call linked nothing of the model’s own', async () => {
    const { asked, ctx } = backend([TRAY])
    const out = await run(
      { action: 'add', activity_code: 'delivery', input_database: 'ei', input_code: 'lorry', amount: 8.28 },
      ctx
    )
    expect(asked).toEqual([])
    expect(out.reached_twice).toBeUndefined()
    expect(out.reached_twice_note).toBeUndefined()
  })

  it('says nothing when the new link is part of no double', async () => {
    const { asked, ctx } = backend([])
    const out = await run(
      { action: 'add', activity_code: 'final', input_database: 'M', input_code: 'tray', amount: 1 },
      ctx
    )
    expect(asked).toHaveLength(1)
    expect(out.reached_twice).toBeUndefined()
    expect(out.reached_twice_note).toBeUndefined()
  })

  it('asks after a replacement that links one of the model’s processes too', async () => {
    const { asked, ctx } = backend(
      [TRAY],
      [{ uid: 'd-tray', activity: 'delivery', amount: 1, input: { database: 'M', code: 'tray' } }]
    )
    const out = await run(
      { action: 'replace_input', activity_code: 'delivery', input_code: 'tray', new_input_code: 'final' },
      ctx
    )
    expect(out.replaced).toBeTruthy()
    expect(asked).toEqual([{ touching: [['delivery', 'final']] }])
    expect(out.reached_twice).toEqual([TRAY])
  })

  it('keeps the add when the check fails', async () => {
    const { fake, ctx } = backend(new Error('backend down'))
    const out = await run(
      { action: 'add', activity_code: 'delivery', input_database: 'M', input_code: 'final', amount: 1 },
      ctx
    )
    expect(out.error).toBeUndefined()
    expect(fake.on('delivery')).toHaveLength(1)
    expect(out.reached_twice).toBeUndefined()
  })
})
