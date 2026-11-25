import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { TOOL_BY_NAME } from '..'
import { createToolSession, type ApiRaw } from '../../execute'
import { inspectedKey } from '../advice/hotspots'

const ctxWith = (
  api: (method: string, path: string) => Promise<unknown>,
  inspected?: Set<string>
): ToolCtx => ({
  api: api as ToolCtx['api'],
  ui: async () => ({}),
  activeDb: 'Bottle',
  inspected
})

describe('get_process_details reads a code from the one background that has it (V470)', () => {
  it('asks for the fallback, records the dataset where it was found and keeps the note in a summary', async () => {
    const paths: string[] = []
    const inspected = new Set<string>()
    const out = JSON.parse(
      String(
        await TOOL_BY_NAME.get_process_details.run(
          { code: 'gran', summary: true },
          ctxWith(async (_m, path) => {
            paths.push(path)
            return {
              found_in: 'bg-db',
              found_in_note: "Not in 'Bottle' — this is the dataset with that code in 'bg-db'.",
              activity: { database: 'bg-db', code: 'gran', name: 'widget granulate' },
              exchanges: []
            }
          }, inspected)
        )
      )
    )
    expect(paths[0]).toBe(
      '/api/v1/model/activity?database=Bottle&code=gran&background_fallback=true&summary=true'
    )
    expect(out.found_in).toBe('bg-db')
    expect(out.found_in_note).toContain("'bg-db'")
    // The hotspot check matches on where the dataset really is, not on the model the call defaulted to.
    expect([...inspected]).toEqual([inspectedKey('bg-db', 'gran')])
  })

  it('keeps the review detail beside the fallback', async () => {
    const paths: string[] = []
    await TOOL_BY_NAME.get_process_details.run(
      { database: 'bg-db', code: 'gran', detail: 'review' },
      ctxWith(async (_m, path) => (paths.push(path), { activity: {}, exchanges: [] }))
    )
    expect(paths[0]).toBe(
      '/api/v1/model/activity?database=bg-db&code=gran&background_fallback=true&detail=review'
    )
  })
})

describe('get_process_details batch (V470 b)', () => {
  const notFound: ApiRaw = async (_m, path) =>
    /code=gran2?&/.test(path)
      ? { status: 200, body: { activity: { name: 'widget granulate' }, exchanges: [] } }
      : {
          status: 404,
          body: {
            error: { message: "Activity 'x' not found in 'Bottle'.", hint: 'Check the activity code.' }
          }
        }
  const session = () =>
    createToolSession({ apiRaw: notFound, headers: () => ({}), ui: async () => ({}), activeDb: 'Bottle' })

  it('fails as a call when every code failed, naming the key the tool does not have', async () => {
    // The observed call: the `database` key arrived with debris glued on, every code was looked up in the
    // model, and the batch still read "ok".
    const oc = await session().run(
      'get_process_details',
      JSON.stringify({ "database'__]_[r": 'bg-db', codes: ['aaa', 'bbb'] })
    )
    expect(oc.ok).toBe(false)
    const error = oc.ok ? '' : oc.error
    expect(error).toContain('None of the 2 codes could be read')
    expect(error).toContain('aaa: ')
    expect(error).toContain(`this tool has no "database'__]_[r"`)
  })

  it('keeps the answers of a partial failure and names the stray key in it', async () => {
    const oc = await session().run(
      'get_process_details',
      JSON.stringify({ databse: 'bg-db', codes: ['gran', 'bbb'] })
    )
    expect(oc.ok).toBe(true)
    const r = JSON.parse(oc.ok ? oc.result : '{}')
    expect(r.results).toHaveLength(2)
    expect(r.results[0].activity.name).toBe('widget granulate')
    expect(r.hint).toContain('1 of 2 read — 1 could not be: bbb.')
    expect(r.hint).toContain('This tool has no "databse"')
  })

  it('counts a partial failure in front of the answers, and the trace counts it too', async () => {
    // One code a character short among datasets of thousands of characters each: its entry carried the
    // reason, nothing in front said one was missing, and the call read "ok".
    const oc = await session().run('get_process_details', JSON.stringify({ codes: ['gran', 'bbb', 'gran2'] }))
    expect(oc.ok).toBe(true)
    const text = oc.ok ? oc.result : ''
    const r = JSON.parse(text)
    expect([r.total, r.read, r.failed]).toEqual([3, 2, 1])
    expect(r.not_read).toEqual(['bbb'])
    expect(r.hint).toContain('2 of 3 read — 1 could not be: bbb.')
    expect(r.hint).not.toContain('This tool has no')
    expect(r.results[1].error).toContain('not found')
    // In front: a reader that stops after the first dataset has already seen the count.
    expect(text.indexOf('"not_read"')).toBeLessThan(text.indexOf('"results"'))
    expect(oc.ok && oc.itemsFailed).toBe(1)
  })

  it('says nothing extra when all codes were read', async () => {
    const oc = await session().run('get_process_details', JSON.stringify({ codes: ['gran'] }))
    const r = JSON.parse(oc.ok ? oc.result : '{}')
    expect(r.hint).toBeUndefined()
    expect(r.not_read).toBeUndefined()
    expect([r.total, r.read, r.failed]).toEqual([1, 1, 0])
    expect(oc.ok && oc.itemsFailed).toBeUndefined()
  })
})

describe('list_activities consumers (V484)', () => {
  it('passes whole_database only when it was asked for', async () => {
    const paths: string[] = []
    const ctx = ctxWith(async (_m, path) => (paths.push(path), { count: 0, consumers: [] }))
    await TOOL_BY_NAME.list_activities.run({ consumes_database: 'bg-db', consumes_code: 'gran' }, ctx)
    await TOOL_BY_NAME.list_activities.run(
      { database: 'bg-db', consumes_database: 'bg-db', consumes_code: 'treat', whole_database: true },
      ctx
    )
    expect(paths[0]).toBe('/api/v1/model/consumers/Bottle?input_database=bg-db&input_code=gran')
    expect(paths[1]).toBe(
      '/api/v1/model/consumers/bg-db?input_database=bg-db&input_code=treat&whole_database=true'
    )
  })
})
