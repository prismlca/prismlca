import { describe, expect, it } from 'vitest'
import { TOOL_BY_NAME } from '..'
import { fakeExchanges } from '../../test/fakeExchanges'
import { KEPT_COMMENT_NOTE } from './replaceInput'

const run = async (args: Record<string, unknown>, ctx: any): Promise<any> =>
  JSON.parse(String(await TOOL_BY_NAME.edit_exchange.run(args, ctx)))

const seed = [
  {
    uid: 'pp1',
    activity: 'tray',
    amount: 0.2,
    comment: 'PP granulate, RER market — the closest region to the German producer',
    input: { database: 'ei', code: 'pp-rer' }
  },
  {
    uid: 'pet1',
    activity: 'tray',
    amount: 0.1,
    comment: 'Mass per the supplier datasheet',
    input: { database: 'ei', code: 'pet-rer' }
  },
  { uid: 'box1', activity: 'tray', amount: 1, input: { database: 'ei', code: 'box' } }
]

describe('edit_exchange replace_input and the comment it carries over', () => {
  it('quotes the kept comment and says once per call that it must fit the new dataset', async () => {
    const fake = fakeExchanges('M', seed)
    const out = await run(
      {
        action: 'replace_input',
        activity_code: 'tray',
        exchanges: [
          { uid: 'pp1', new_input_code: 'pp-glo' },
          { uid: 'pet1', new_input_code: 'pet-glo' }
        ]
      },
      fake.ctx
    )
    expect(out.succeeded).toBe(2)
    const [pp, pet] = out.results.map((r: any) => r.result)
    expect(pp.kept_comment).toBe(seed[0].comment)
    expect(pp.kept_old.comment).toBe(true)
    expect(pet.kept_comment).toBe('Mass per the supplier datasheet')
    // Said once beside the batch, not per item.
    expect(out.kept_comment_note).toBe(KEPT_COMMENT_NOTE)
    expect(JSON.stringify(out.results)).not.toContain('kept_comment_note')
    // The comment still travels to the new exchange as before.
    expect(fake.on('tray').find((e) => e.input.code === 'pp-glo')?.comment).toBe(seed[0].comment)
  })

  it('says no comment was kept where there was none, and adds no note', async () => {
    const fake = fakeExchanges('M', seed)
    const out = await run(
      { action: 'replace_input', activity_code: 'tray', uid: 'box1', new_input_code: 'box2' },
      fake.ctx
    )
    expect(out.replaced).toBe('box1')
    expect(out.kept_old.comment).toBe(false)
    expect(out.kept_comment).toBeUndefined()
    expect(out.kept_comment_note).toBeUndefined()
  })

  it('keeps nothing to quote when the call brings its own comment', async () => {
    const fake = fakeExchanges('M', seed)
    const out = await run(
      {
        action: 'replace_input',
        activity_code: 'tray',
        uid: 'pp1',
        new_input_code: 'pp-glo',
        comment: 'GLO'
      },
      fake.ctx
    )
    expect(out.commented).toBe(true)
    expect(out.kept_old.comment).toBe(false)
    expect(out.kept_comment).toBeUndefined()
    expect(out.kept_comment_note).toBeUndefined()
  })

  it('shortens a long kept comment in the answer, not on the exchange', async () => {
    const long = `${'Proxy chosen because no regional dataset exists. '.repeat(8)}End.`
    const fake = fakeExchanges('M', [{ ...seed[0], comment: long }])
    const out = await run(
      { action: 'replace_input', activity_code: 'tray', uid: 'pp1', new_input_code: 'pp-glo' },
      fake.ctx
    )
    expect(out.kept_comment.length).toBeLessThanOrEqual(201)
    expect(out.kept_comment.endsWith('…')).toBe(true)
    expect(fake.on('tray')[0].comment).toBe(long)
  })
})
