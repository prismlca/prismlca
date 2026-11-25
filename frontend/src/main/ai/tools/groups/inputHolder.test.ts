import { describe, expect, it } from 'vitest'
import { TOOL_BY_NAME } from '..'
import { ApiError } from '../../../../shared/backendError'
import { fakeExchanges } from '../../test/fakeExchanges'

const run = async (args: Record<string, unknown>, ctx: any): Promise<any> =>
  JSON.parse(String(await TOOL_BY_NAME.edit_exchange.run(args, ctx)))

const seed = [{ uid: 'box1', activity: 'tray', amount: 1, input: { database: 'ei', code: 'box' } }]

/** The fake model backend, with the holder lookup answered as `lookup` says. */
function withLookup(lookup: (code: string) => unknown) {
  const fake = fakeExchanges('M', seed)
  const asked: string[] = []
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    const m = /^\/api\/v1\/model\/activity\?database=M&code=([^&]+)&background_fallback=true$/.exec(path)
    if (m) {
      asked.push(decodeURIComponent(m[1]))
      return lookup(decodeURIComponent(m[1]))
    }
    return fake.ctx.api(method, path, body)
  }
  return { fake, asked, ctx: { ...fake.ctx, api } }
}

const add = { action: 'add', activity_code: 'tray', input_code: 'abc123', amount: 0.3 }

describe('edit_exchange add without input_database', () => {
  it('names the background database that holds the code', async () => {
    const { fake, asked, ctx } = withLookup(() => ({ found_in: 'ecoinvent-3.12-cutoff', activity: {} }))
    const out = await run(add, ctx)
    expect(out.error).toBe(
      'action="add" also requires: input_database. The code abc123 is a dataset of ' +
        '\'ecoinvent-3.12-cutoff\' — send input_database: "ecoinvent-3.12-cutoff".'
    )
    expect(asked).toEqual(['abc123'])
    expect(fake.writes).toEqual([])
  })

  it("names the model itself when the code is one of the model's processes", async () => {
    const { ctx } = withLookup(() => ({ activity: { code: 'abc123' } }))
    const out = await run(add, ctx)
    expect(out.error).toContain('is a process of this model, \'M\' — send input_database: "M".')
  })

  it("hands on the backend's hint when several databases or none hold the code", async () => {
    const { ctx } = withLookup(() => {
      throw new ApiError(
        "Activity 'abc123' not found in 'M'. — That code exists in 'ecoinvent-3.12-cutoff' and " +
          "'bafu-2026', not in 'M'. Give the database you mean.",
        404,
        'activity_not_found'
      )
    })
    const out = await run(add, ctx)
    expect(out.error).toMatch(/^action="add" also requires: input_database\. Looking the code up: /)
    expect(out.error).toContain("exists in 'ecoinvent-3.12-cutoff' and 'bafu-2026'")
  })

  it('looks nothing up when the code is missing too', async () => {
    const { asked, ctx } = withLookup(() => ({}))
    const out = await run({ action: 'add', activity_code: 'tray', amount: 1 }, ctx)
    expect(out.error).toBe('action="add" also requires: input_database and input_code.')
    expect(asked).toEqual([])
  })
})
