import { describe, expect, it } from 'vitest'
import { TOOL_BY_NAME } from '..'
import { fakeExchanges } from '../../test/fakeExchanges'
import { SAME_INPUT_NOTE } from './sameInput'

const run = async (args: Record<string, unknown>, ctx: any): Promise<any> =>
  JSON.parse(String(await TOOL_BY_NAME.edit_exchange.run(args, ctx)))

const seed = [
  {
    uid: 'lorry1',
    activity: 'dist',
    amount: 9.66,
    formula: 'mass_t * km_leg1',
    comment: 'Leg 1: plant to retailer',
    input: { database: 'ei', code: 'lorry' }
  },
  { uid: 'box1', activity: 'dist', amount: 0.4, input: { database: 'ei', code: 'box' } },
  // The same dataset on another process is not this process's business.
  { uid: 'lorry2', activity: 'eol', amount: 1, input: { database: 'ei', code: 'lorry' } }
]

describe('an add from an input the process already has', () => {
  it('goes through, and the answer names the exchange that was already there', async () => {
    const fake = fakeExchanges('M', seed)
    const out = await run(
      {
        action: 'add',
        activity_code: 'dist',
        input_database: 'ei',
        input_code: 'lorry',
        formula: 'mass_t * km_leg2',
        comment: 'Leg 2: retailer to customer'
      },
      fake.ctx
    )
    expect(out.error).toBeUndefined()
    expect(fake.on('dist').filter((e) => e.input.code === 'lorry')).toHaveLength(2)
    expect(out.same_input_already).toEqual([
      { uid: 'lorry1', amount: 9.66, formula: 'mass_t * km_leg1', comment: 'Leg 1: plant to retailer' }
    ])
    expect(out.same_input_note).toBe(SAME_INPUT_NOTE)
  })

  it('says nothing for an input the process did not have', async () => {
    const fake = fakeExchanges('M', seed)
    const out = await run(
      { action: 'add', activity_code: 'dist', input_database: 'ei', input_code: 'pallet', amount: 0.02 },
      fake.ctx
    )
    expect(out.error).toBeUndefined()
    expect(out.same_input_already).toBeUndefined()
    expect(out.same_input_note).toBeUndefined()
  })

  it('reads the process once before a batch, and names the twin of an add made in the same batch', async () => {
    const fake = fakeExchanges('M', seed)
    const reads: string[] = []
    const api = fake.ctx.api
    const ctx = {
      ...fake.ctx,
      api: (m: string, p: string, b?: unknown) => {
        if (m === 'GET' && p.endsWith('&code=dist')) reads.push(p)
        return api(m, p, b)
      }
    }
    const out = await run(
      {
        action: 'add',
        activity_code: 'dist',
        input_database: 'ei',
        exchanges: [
          { input_code: 'pallet', amount: 0.02 },
          { input_code: 'foil', amount: 0.01 },
          { input_code: 'pallet', amount: 0.02 }
        ]
      },
      ctx
    )
    expect(out.succeeded).toBe(3)
    // One read before the adds and one to check the hint once the batch has run — not one per item.
    expect(reads).toHaveLength(2)
    const flagged = out.results.filter((r: any) => r.result.same_input_already)
    expect(flagged).toHaveLength(1)
    // Items 0 and 2 are the pallets; a success carries its index, not the item.
    const twins = out.results.filter((r: any) => r.i !== 1).map((r: any) => r.result.uid)
    expect(flagged[0].result.same_input_already.map((e: any) => e.uid)).toEqual(
      twins.filter((u: string) => u !== flagged[0].result.uid)
    )
    expect(out.same_input_note).toBe(SAME_INPUT_NOTE)
  })

  it('checks the hint against the model as the batch left it', async () => {
    // Swapping by hand in one batch: add the new exchange, remove the old one. The old one is gone by the
    // time the answer is written, so naming it — and advising to edit it — would send the caller to a
    // uid that no longer exists.
    const fake = fakeExchanges('M', seed)
    const swapped = await run(
      {
        activity_code: 'dist',
        exchanges: [
          { action: 'add', input_database: 'ei', input_code: 'lorry', formula: 'mass_t * 750' },
          { action: 'remove', uid: 'lorry1' }
        ]
      },
      fake.ctx
    )
    expect(swapped.succeeded).toBe(2)
    expect(fake.on('dist').filter((e) => e.input.code === 'lorry')).toHaveLength(1)
    expect(swapped.results[0].result.same_input_already).toBeUndefined()
    expect(swapped.same_input_note).toBeUndefined()

    // Changed in the same batch: the hint shows the exchange as it is now, not as it was read.
    const again = fakeExchanges('M', seed)
    const changed = await run(
      {
        activity_code: 'dist',
        exchanges: [
          { action: 'add', input_database: 'ei', input_code: 'lorry', amount: 0.69 },
          { action: 'set_amount', uid: 'lorry1', amount: 10.35 }
        ]
      },
      again.ctx
    )
    expect(changed.results[0].result.same_input_already).toEqual([
      { uid: 'lorry1', amount: 10.35, comment: 'Leg 1: plant to retailer' }
    ])
    expect(changed.same_input_note).toBe(SAME_INPUT_NOTE)
  })

  it('still adds when the read for the hint fails', async () => {
    const fake = fakeExchanges('M', seed)
    const api = fake.ctx.api
    const ctx = {
      ...fake.ctx,
      api: (m: string, p: string, b?: unknown) =>
        m === 'GET' && p.endsWith('/dist') ? Promise.reject(new Error('boom')) : api(m, p, b)
    }
    const out = await run(
      { action: 'add', activity_code: 'dist', input_database: 'ei', input_code: 'lorry', amount: 1 },
      ctx
    )
    expect(out.error).toBeUndefined()
    expect(fake.on('dist').filter((e) => e.input.code === 'lorry')).toHaveLength(2)
  })
})
