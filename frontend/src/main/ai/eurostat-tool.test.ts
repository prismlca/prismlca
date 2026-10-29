/**
 * Off means invisible, same as distances: with the Eurostat feature off for a
 * chat, the model is neither offered `eurostat_eol` nor told about it in the system prompt — and the
 * web-research bullet then takes end-of-life rates back, so the model still has a way to them.
 */
import { describe, expect, it, vi } from 'vitest'
import { toolSpecs } from './tools/focus'
import { PARALLEL_SAFE_TOOLS, TOOL_BY_NAME, TOOLS } from './tools/registry'
import { MAX_EUROSTAT_BATCH_CHARS, MAX_EUROSTAT_QUERIES } from './tools/groups/eurostat'
import { buildSystemPrompt } from './systemPrompt'
import type { ToolCtx } from './tools/context'

const names = (specs: ReturnType<typeof toolSpecs>): string[] => specs.map((s) => s.function.name)

describe('eurostat_eol: offered only when available', () => {
  it('is in the registry, parallel-safe, and offered by default', () => {
    expect(TOOLS.some((t) => t.spec.function.name === 'eurostat_eol')).toBe(true)
    expect(PARALLEL_SAFE_TOOLS.has('eurostat_eol')).toBe(true)
    expect(names(toolSpecs(true))).toContain('eurostat_eol')
    const spec = TOOL_BY_NAME.eurostat_eol.spec.function
    const props = spec.parameters.properties as Record<string, { enum?: string[] }>
    expect(props.dataset.enum).toEqual(['env_wasoper', 'env_wastrt', 'env_waspac', 'env_wasmun'])
    expect(spec.parameters.required).toEqual([])
  })

  it('drops the spec entirely when the feature is off for the chat, and only that one', () => {
    const specs = toolSpecs(true, undefined, undefined, undefined, true, false)
    expect(names(specs)).not.toContain('eurostat_eol')
    expect(names(specs)).toContain('distances')
    expect(specs.length).toBe(toolSpecs(true).length - 1)
  })

  it('the system prompt mentions the tool only when it is offered', () => {
    const base = { activeDb: 'Model A', skills: [] }
    const on = buildSystemPrompt({ ...base, eurostat: true, research: true })
    const off = buildSystemPrompt({ ...base, eurostat: false, research: true })
    const unsaid = buildSystemPrompt(base)
    expect(on).toContain('`eurostat_eol`')
    expect(on).toMatch(/flags_and_status\.warning/)
    expect(on).toMatch(/sorting/)
    expect(off).not.toContain('`eurostat_eol`')
    // Off, neither the tool nor its rule is in the prompt. The switch that turns it on is: the user's
    // "+" menu is named so the model can point at it instead of saying it cannot help.
    expect(off).not.toMatch(/End-of-life statistics \(EU\)/)
    expect(off).toContain('left of the chat input')
    expect(unsaid).not.toContain('`eurostat_eol`')
    // The web bullet only sends EoL rates to the web when Eurostat is not there to answer them.
    expect(on).not.toMatch(/end-of-life split rates/)
    expect(off).toMatch(/end-of-life split rates/)
    expect(off).toMatch(/recycling quotas/)
  })

  it('refuses a stale call when the feature is off, and relays errors as a result', async () => {
    const tool = TOOL_BY_NAME.eurostat_eol
    const off = { eurostatAvailable: false, api: vi.fn(), ui: vi.fn(), activeDb: null } as unknown as ToolCtx
    expect(JSON.parse((await tool.run({ dataset: 'env_wasoper' }, off)) as string)).toEqual({
      error: 'Eurostat statistics are not available in this chat.'
    })
    const failing = {
      eurostatAvailable: true,
      eurostat: async () => {
        throw new Error('Unknown dataset "x".')
      },
      api: vi.fn(),
      ui: vi.fn(),
      activeDb: null
    } as unknown as ToolCtx
    expect(JSON.parse((await tool.run({ dataset: 'x' }, failing)) as string)).toEqual({
      error: 'Unknown dataset "x".'
    })
  })

  it('shows the attribution on the tool row and logs provenance against the open model', async () => {
    const tool = TOOL_BY_NAME.eurostat_eol
    const api = vi.fn(async () => ({}))
    const out = {
      dataset: 'env_wasoper',
      scope: 'DE',
      year: 2022,
      values: { rows: [['DE', 'RCV_R', 'PC', 40, 'p']], count: 1 },
      flags_and_status: { warning: '1 of 1 values are NOT final', flagged_values: 1, total_values: 1 },
      dataset_metadata: {
        table: 'https://ec.europa.eu/eurostat/databrowser/view/env_wasoper/default/table',
        api_query: 'https://ec.europa.eu/eurostat/api/…',
        attribution: 'Source: Eurostat (© European Union)',
        last_update: null
      }
    }
    const ctx = {
      eurostatAvailable: true,
      eurostat: async () => out,
      api,
      ui: vi.fn(),
      activeDb: 'Model A'
    } as unknown as ToolCtx
    const res = (await tool.run({ dataset: 'env_wasoper', country: 'DE' }, ctx)) as {
      result: string
      notice: string
    }
    expect(res.notice).toMatch(/Eurostat/)
    expect(JSON.parse(res.result).year).toBe(2022)
    expect(api).toHaveBeenCalledWith(
      'POST',
      '/api/v1/provenance/research',
      expect.objectContaining({
        database: 'Model A',
        entries: [
          expect.objectContaining({
            question: expect.stringContaining('env_wasoper DE 2022'),
            findings: [expect.objectContaining({ source_class: 'official', confidence: 'medium' })]
          })
        ]
      })
    )
  })
})

describe('eurostat_eol: several lookups in one call', () => {
  const out = (scope: string, chars = 0): Record<string, unknown> => ({
    dataset: 'env_wasoper',
    scope,
    year: 2022,
    values: { rows: [[scope, 'RCV_R', 'PC', 40, '']], count: 1 },
    flags_and_status: { warning: null, flagged_values: 0, total_values: 1 },
    dataset_metadata: {
      table: 't',
      api_query: 'q',
      attribution: 'Source: Eurostat (© European Union)',
      last_update: null
    },
    // Padding to make an answer "large" for the size cap.
    pad: 'x'.repeat(chars)
  })
  const ctxWith = (eurostat: (a: unknown) => Promise<unknown>, api = vi.fn(async () => ({}))): ToolCtx =>
    ({ eurostatAvailable: true, eurostat, api, ui: vi.fn(), activeDb: 'Model A' }) as unknown as ToolCtx

  it('answers per item in order, with the batch shape, and a failing item does not cost the others', async () => {
    const tool = TOOL_BY_NAME.eurostat_eol
    const api = vi.fn(async () => ({}))
    const ctx = ctxWith(async (a) => {
      const c = (a as { country: string }).country
      if (c === 'XX') throw new Error('Eurostat has no reporting country "XX"')
      return out(c)
    }, api)
    const res = (await tool.run(
      {
        queries: [
          { dataset: 'env_wasoper', country: 'DE' },
          { dataset: 'env_wasoper', country: 'XX' },
          { dataset: 'env_wasoper', country: 'FR' }
        ]
      },
      ctx
    )) as { result: string; notice: string }
    const r = JSON.parse(res.result)
    expect(r).toMatchObject({ total: 3, succeeded: 2, failed: 1 })
    expect(r.results[0]).toMatchObject({ i: 0, ok: true, result: { scope: 'DE' } })
    expect(r.results[1]).toMatchObject({ i: 1, ok: false, item: { country: 'XX' } })
    expect(r.results[1].error).toMatch(/no reporting country/)
    expect(r.results[2]).toMatchObject({ i: 2, ok: true, result: { scope: 'FR' } })
    expect(r.hint).toMatch(/failed/)
    expect(res.notice).toMatch(/Eurostat/)
    // One provenance POST for the whole call, one entry per answered item.
    expect(api).toHaveBeenCalledTimes(1)
    expect((api.mock.calls[0] as unknown[])[2]).toMatchObject({
      entries: [expect.anything(), expect.anything()]
    })
  })

  it('stops adding answers at the size cap and names the rest as not included, in order', async () => {
    const tool = TOOL_BY_NAME.eurostat_eol
    const big = MAX_EUROSTAT_BATCH_CHARS / 2 - 500
    const ctx = ctxWith(async (a) => out((a as { country?: string }).country ?? 'all', big))
    const res = (await tool.run(
      {
        queries: [
          { dataset: 'env_wasoper' },
          { dataset: 'env_wasoper' },
          { dataset: 'env_wasoper' },
          { dataset: 'env_wasoper', country: 'DE' }
        ]
      },
      ctx
    )) as { result: string }
    const r = JSON.parse(res.result)
    expect(r.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true, false, false])
    expect(r.results[2].error).toMatch(/Not included/)
    expect(r.results[2].error).toMatch(/cached/)
    // The small one after the cut is still not included: order is the contract, not size.
    expect(r.results[3].error).toMatch(/Not included/)
    expect(res.result.length).toBeLessThan(MAX_EUROSTAT_BATCH_CHARS + 2_000)
  })

  it('runs at most ten items and says which were not run', async () => {
    const tool = TOOL_BY_NAME.eurostat_eol
    const seen: string[] = []
    const ctx = ctxWith(async (a) => {
      seen.push((a as { country: string }).country)
      return out((a as { country: string }).country)
    })
    const queries = Array.from({ length: 12 }, (_, i) => ({ dataset: 'env_wasoper', country: `C${i}` }))
    const r = JSON.parse(((await tool.run({ queries }, ctx)) as { result: string }).result)
    expect(seen).toHaveLength(MAX_EUROSTAT_QUERIES)
    expect(r.total).toBe(12)
    expect(r.results[10]).toMatchObject({ ok: false, item: { country: 'C10' } })
    expect(r.results[10].error).toMatch(/at most 10/)
  })

  it('a single lookup keeps the single shape, and no dataset at all is refused', async () => {
    const tool = TOOL_BY_NAME.eurostat_eol
    const ctx = ctxWith(async () => out('DE'))
    const single = (await tool.run({ dataset: 'env_wasoper', country: 'DE' }, ctx)) as { result: string }
    expect(JSON.parse(single.result).scope).toBe('DE')
    expect(JSON.parse((await tool.run({}, ctx)) as string).error).toMatch(/dataset is required/)
  })
})
