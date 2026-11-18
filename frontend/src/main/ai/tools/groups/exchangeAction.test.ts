import { describe, expect, it } from 'vitest'
import { TOOL_BY_NAME } from '..'
import { fakeExchanges } from '../../test/fakeExchanges'
import { actionOf } from './exchangeAction'

const run = async (args: Record<string, unknown>, ctx: any): Promise<any> =>
  JSON.parse(String(await TOOL_BY_NAME.edit_exchange.run(args, ctx)))

describe('which action an edit_exchange item asks for', () => {
  it('takes the named action, and refuses an unknown one — prototype names included', () => {
    expect(actionOf({ action: ' set_formula ' })).toBe('set_formula')
    expect(() => actionOf({ action: 'explode' })).toThrow('Unknown action "explode"')
    expect(() => actionOf({ action: 'constructor' })).toThrow('Unknown action "constructor"')
  })

  it('reads an input with an amount or a formula as an add when nothing names an exchange', () => {
    expect(actionOf({ input_code: 'steel', amount: 2 })).toBe('add')
    expect(actionOf({ input_code: 'steel', formula: 'mass * 2' })).toBe('add')
    expect(() => actionOf({ input_code: 'steel' })).toThrow('Missing "action"')
    expect(() => actionOf({ uid: 'u1', formula: 'mass' })).toThrow('Missing "action"')
  })

  it('says a call names no exchange instead of asking for an action', () => {
    expect(() => actionOf({})).toThrow('names no exchange')
    expect(() => actionOf({ activity_code: 'frame', input_database: 'ei' })).toThrow('nothing was done')
    // Anything that points at an exchange or says what to write still hears about the action.
    expect(() => actionOf({ uid: 'u1' })).toThrow('Missing "action"')
    expect(() => actionOf({ comment: 'per shelf' })).toThrow('Missing "action"')
    expect(() => actionOf({ new_input_code: 'x' })).toThrow('Missing "action"')
  })

  it('refuses a uid beside an input_code without an action, with both readings', () => {
    const msg = (() => {
      try {
        actionOf({ uid: 'u1', input_code: 'steel', formula: 'mass * 2' })
      } catch (e) {
        return (e as Error).message
      }
      return ''
    })()
    expect(msg).toContain('nothing was done')
    expect(msg).toContain('"set_formula"')
    expect(msg).toContain('"replace_input" with new_input_code')
    expect(msg).toContain('send action "add" without a uid')
    // Without a number or a formula it is no add either, and the same two readings still apply.
    expect(() => actionOf({ uid: 'u1', input_code: 'steel', comment: 'why' })).toThrow('nothing was done')
  })
})

describe('edit_exchange that names no exchange', () => {
  it('says so and writes nothing, for "exchanges": null beside a process', async () => {
    const fake = fakeExchanges('M', [
      { uid: 'steel1', activity: 'frame', amount: 7, input: { database: 'ei', code: 'steel' } }
    ])
    // The executor drops `exchanges: null` before the tool; what arrives is the process alone.
    const out = await run({ activity_code: 'frame' }, fake.ctx)
    expect(out.error).toContain('This call names no exchange')
    expect(fake.writes).toEqual([])
  })
})

describe('edit_exchange with a uid and no action', () => {
  // The shape of the batch that doubled a shelf's inputs: per item uid + input_code + formula + comment, no
  // action anywhere — meant as "put these formulas on the exchanges I have".
  const seed = [
    { uid: 'steel1', activity: 'frame', amount: 7, input: { database: 'ei', code: 'steel' } },
    { uid: 'zinc1', activity: 'frame', amount: 0.14, input: { database: 'ei', code: 'zinc' } },
    { uid: 'wood1', activity: 'frame', amount: 6, input: { database: 'ei', code: 'board' } }
  ]
  const items = seed.map((e) => ({
    uid: e.uid,
    activity_code: 'frame',
    input_database: 'ei',
    input_code: e.input.code,
    formula: `${e.input.code}_kg`,
    comment: 'per shelf'
  }))

  it('refuses every item and adds nothing', async () => {
    const fake = fakeExchanges('M', seed)
    const out = await run({ exchanges: items }, fake.ctx)
    expect(out.succeeded).toBe(0)
    expect(out.error).toContain('none succeeded')
    for (const r of out.results) expect(r.error).toContain('fits two different edits')
    expect(fake.writes).toEqual([])
    expect(fake.on('frame').map((e) => e.uid)).toEqual(['steel1', 'zinc1', 'wood1'])
  })

  it('refuses the single-item form the same way', async () => {
    const fake = fakeExchanges('M', seed)
    const out = await run(items[0], fake.ctx)
    expect(out.error).toContain('fits two different edits')
    expect(fake.writes).toEqual([])
  })

  it('changes the named exchanges once the action is said, at the top of the batch', async () => {
    const fake = fakeExchanges('M', seed)
    const out = await run({ action: 'set_formula', exchanges: items }, fake.ctx)
    expect(out.succeeded).toBe(3)
    expect(fake.on('frame').map((e) => [e.uid, e.formula])).toEqual([
      ['steel1', 'steel_kg'],
      ['zinc1', 'zinc_kg'],
      ['wood1', 'board_kg']
    ])
  })

  it('still adds an input given with a formula and no uid', async () => {
    const fake = fakeExchanges('M', seed)
    const out = await run(
      { activity_code: 'frame', input_database: 'ei', input_code: 'paint', formula: 'paint_kg' },
      fake.ctx
    )
    expect(out.error).toBeUndefined()
    expect(fake.on('frame').map((e) => e.input.code)).toEqual(['steel', 'zinc', 'board', 'paint'])
  })
})
