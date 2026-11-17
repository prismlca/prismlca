import { describe, expect, it } from 'vitest'
import type { ToolCtx } from '../context'
import { TOOL_BY_NAME } from '..'
import { inspectedKey } from './hotspots'
import { openedDatasets, openedOrThrow } from './opened'

/**
 * A small app: a model `M` whose reference process buys from two markets of the background `ei`.
 * The steel market mixes two producers, the plastics market one. `asked` collects every question
 * about market suppliers, so a test can tell an answer from a question never put.
 */
function app(opts: { suppliersFail?: boolean } = {}): {
  ctx: ToolCtx
  asked: unknown[]
  dossier: () => string
} {
  const suppliers: Record<string, string[]> = {
    'mkt-steel': ['steel-rer', 'steel-row'],
    'mkt-pp': ['pp-prod']
  }
  const names: Record<string, string> = {
    'mkt-steel': 'market for steel, low-alloyed, hot rolled',
    'mkt-pp': 'market for polypropylene, granulate'
  }
  const tree = {
    db: 'M',
    c: 'fu',
    n: 'FU',
    shr: 1,
    ch: [
      { db: 'ei', c: 'mkt-steel', n: names['mkt-steel'], shr: 0.55, ch: [] },
      { db: 'ei', c: 'mkt-pp', n: names['mkt-pp'], shr: 0.4, ch: [] }
    ]
  }
  const asked: unknown[] = []
  let dossier = ''
  const ctx: ToolCtx = {
    api: (async (_m: string, path: string, body: any) => {
      if (path === '/api/v1/model/market-suppliers') {
        asked.push(body)
        if (opts.suppliersFail) throw new Error('backend exploded')
        return {
          markets: (body.datasets as Array<{ database: string; code: string }>)
            .filter((d) => suppliers[d.code])
            .map((d) => ({ ...d, suppliers: suppliers[d.code].map((code) => ({ database: 'ei', code })) }))
        }
      }
      if (path === '/api/v1/model/exchanges')
        return {
          exchange: {
            uid: `u-${body.input_code}`,
            type: 'technosphere',
            input: { database: body.input_database, code: body.input_code, name: names[body.input_code] }
          }
        }
      if (path === '/api/v1/calc/contribution') return { tree }
      if (path.startsWith('/api/v1/study')) return {}
      if (path.includes('/model/activities/ei/')) return { activity: { name: 'a dataset' }, exchanges: [] }
      return { ok: true }
    }) as ToolCtx['api'],
    ui: async () => ({}),
    activeDb: 'M',
    inspected: new Set<string>(),
    review: async (o) => {
      dossier = o.dossier
      return { text: 'ok', outcome: 'ok' as const, reasoning_chars: 0, attempts: 1, ms: 1 }
    }
  }
  return { ctx, asked, dossier: () => dossier }
}

const run = async (tool: string, args: unknown, ctx: ToolCtx): Promise<any> =>
  JSON.parse(String(await TOOL_BY_NAME[tool].run(args as never, ctx)))

const linkBoth = {
  activity_code: 'fu',
  action: 'add',
  exchanges: [
    { input_database: 'ei', input_code: 'mkt-steel', amount: 1.1 },
    { input_database: 'ei', input_code: 'mkt-pp', amount: 3.2 }
  ]
}

describe('a market counts as opened once a producer behind it was read', () => {
  it('does not remind about the market at link time, and still does about the other', async () => {
    const { ctx } = app()
    await run('get_process_details', { database: 'ei', code: 'steel-row' }, ctx)
    const out = await run('edit_exchange', linkBoth, ctx)
    expect(out.succeeded).toBe(2)
    expect(out.not_yet_opened.map((l: any) => l.code)).toEqual(['mkt-pp'])
    // The record stays what was read: the market is not written into it.
    expect([...ctx.inspected!]).toEqual([inspectedKey('ei', 'steel-row')])
  })

  it('leaves the market out of the list after a calculation', async () => {
    const { ctx } = app()
    await run('get_process_details', { database: 'ei', code: 'steel-rer' }, ctx)
    const out = await run('explain_result', { mode: 'tree', code: 'fu', method: ['m'] }, ctx)
    expect(out.not_yet_inspected.map((h: any) => h.code)).toEqual(['mkt-pp'])
    expect(out.inspect_these).toMatch(/^1 dataset/)
  })

  it('does not tell the reviewer that nobody looked at it', async () => {
    const { ctx, dossier } = app()
    await run('get_process_details', { database: 'ei', codes: ['steel-rer', 'pp-prod'] }, ctx)
    await run('review_model', { code: 'fu', method: ['m'] }, ctx)
    expect(dossier()).toContain('HOTSPOTS')
    expect(dossier()).not.toContain('DATASETS NOBODY LOOKED AT')
  })

  it('names in the dossier only the market whose producers were not read', async () => {
    const { ctx, dossier } = app()
    await run('get_process_details', { database: 'ei', code: 'steel-rer' }, ctx)
    await run('review_model', { code: 'fu', method: ['m'] }, ctx)
    const nobody = dossier().split('DATASETS NOBODY LOOKED AT')[1]
    expect(nobody).toContain('market for polypropylene, granulate [ei] 40 %')
    expect(nobody).not.toContain('steel')
  })
})

describe('a market whose producers were not read is still unopened', () => {
  it('is reminded about at link time, after a calculation and in the dossier', async () => {
    const { ctx, dossier } = app()
    // Something was read, but nothing either market buys from.
    await run('get_process_details', { database: 'ei', code: 'lorry' }, ctx)
    const linked = await run('edit_exchange', linkBoth, ctx)
    expect(linked.not_yet_opened.map((l: any) => l.code)).toEqual(['mkt-steel', 'mkt-pp'])
    const explained = await run('explain_result', { mode: 'tree', code: 'fu', method: ['m'] }, ctx)
    expect(explained.not_yet_inspected.map((h: any) => h.code)).toEqual(['mkt-steel', 'mkt-pp'])
    await run('review_model', { code: 'fu', method: ['m'] }, ctx)
    expect(dossier()).toContain('DATASETS NOBODY LOOKED AT')
    expect(dossier()).toContain('market for steel, low-alloyed, hot rolled [ei] 55 %')
  })

  it('is reminded about when the suppliers cannot be asked for', async () => {
    const { ctx, asked } = app({ suppliersFail: true })
    await run('get_process_details', { database: 'ei', code: 'steel-rer' }, ctx)
    const out = await run('edit_exchange', linkBoth, ctx)
    expect(asked).toHaveLength(1)
    expect(out.not_yet_opened.map((l: any) => l.code)).toEqual(['mkt-steel', 'mkt-pp'])
    const explained = await run('explain_result', { mode: 'tree', code: 'fu', method: ['m'] }, ctx)
    expect(explained.not_yet_inspected.map((h: any) => h.code)).toEqual(['mkt-steel', 'mkt-pp'])
  })
})

describe('the reviewer is told nobody looked only when that can be measured', () => {
  it('leaves the section out and names the gap when the suppliers cannot be asked for', async () => {
    const { ctx, dossier } = app({ suppliersFail: true })
    // The steel producer was read; without the suppliers the app cannot know that this covers the market.
    await run('get_process_details', { database: 'ei', code: 'steel-rer' }, ctx)
    const out = await run('review_model', { code: 'fu', method: ['m'] }, ctx)
    expect(dossier()).not.toContain('DATASETS NOBODY LOOKED AT')
    expect(dossier()).toContain('GAPS IN THIS DOSSIER')
    expect(out.gaps.join(' ')).toContain('datasets nobody looked at: could not be collected')
  })

  it('still says so without asking when nothing at all was read', async () => {
    const { ctx, asked, dossier } = app({ suppliersFail: true })
    await run('review_model', { code: 'fu', method: ['m'] }, ctx)
    expect(asked).toEqual([])
    expect(dossier()).toContain('DATASETS NOBODY LOOKED AT')
  })
})

describe('openedDatasets', () => {
  const steel = { database: 'ei', code: 'mkt-steel' }

  it('asks only about what was not read itself, and not at all while nothing was read', async () => {
    const { ctx, asked } = app()
    expect(await openedDatasets(ctx, [steel])).toBe(ctx.inspected)
    expect(asked).toEqual([])
    ctx.inspected!.add(inspectedKey('ei', 'mkt-steel'))
    expect(await openedDatasets(ctx, [steel])).toBe(ctx.inspected)
    expect(asked).toEqual([])
    const opened = await openedDatasets(ctx, [steel, { database: 'ei', code: 'mkt-pp' }])
    expect(asked).toEqual([{ datasets: [{ database: 'ei', code: 'mkt-pp' }] }])
    expect(opened!.has(inspectedKey('ei', 'mkt-pp'))).toBe(false)
  })

  it('falls back to the record when the app cannot answer, and openedOrThrow says so', async () => {
    const { ctx } = app({ suppliersFail: true })
    ctx.inspected!.add(inspectedKey('ei', 'steel-rer'))
    expect(await openedDatasets(ctx, [steel])).toBe(ctx.inspected)
    await expect(openedOrThrow(ctx, [steel])).rejects.toThrow('backend exploded')
    ctx.api = (async () => ({ ok: true })) as ToolCtx['api']
    await expect(openedOrThrow(ctx, [steel])).rejects.toThrow('could not be read')
  })

  it('is undefined for a run that keeps no record', async () => {
    const { ctx } = app()
    ctx.inspected = undefined
    expect(await openedDatasets(ctx, [steel])).toBeUndefined()
  })
})
