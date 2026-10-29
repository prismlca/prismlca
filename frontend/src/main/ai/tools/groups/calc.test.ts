/**
 * The calc tools' contract towards the model: what a comparison is annotated with, that the hotspot
 * matrix goes out as ONE request carrying every method, and what a bare compare call is refused for.
 */
import { describe, expect, it, vi } from 'vitest'
import { annotateComparison, calcTools } from './calc'
import type { ToolCtx } from '../context'

const tool = (name: string) => calcTools.find((t) => t.spec.function.name === name)!

const text = (out: unknown): any => JSON.parse(out as string)

function ctx(api: ToolCtx['api']): ToolCtx {
  return { api, ui: vi.fn(), activeDb: 'Model A' } as unknown as ToolCtx
}

const matrix = {
  methods: [
    { key: 'gwp', method: ['x', 'gwp'], unit: 'kg' },
    { key: 'water', method: ['x', 'w'], unit: 'm3' }
  ],
  subjects: [
    { label: 'baseline', scores: { gwp: 10, water: 2 } },
    { label: 'variant', scores: { gwp: 8, water: 3 } },
    { label: 'other', scores: { gwp: 12, water: 1 } }
  ]
}

describe('annotateComparison', () => {
  it('gives every subject its delta to the first and names the lowest per indicator', () => {
    const r = annotateComparison(JSON.parse(JSON.stringify(matrix)))
    expect(r.reference).toBe('baseline')
    expect(r.subjects[1].vs_first.gwp.delta_pct).toBe(-20)
    expect(r.subjects[2].vs_first.water.delta_pct).toBe(-50)
    expect(r.subjects[1].vs_first.gwp.ratio).toBeUndefined()
    expect(r.lowest_per_indicator).toEqual({ gwp: 'variant', water: 'other' })
    expect(r.reading).toMatch(/difference to "baseline"/)
  })

  it('adds the ratio on request and drops the ranking for part/whole rows', () => {
    const r = annotateComparison(JSON.parse(JSON.stringify(matrix)), {
      normalize_to_first: true,
      show_ranking: false
    })
    expect(r.subjects[1].vs_first.gwp.ratio).toBe(0.8)
    expect(r.lowest_per_indicator).toBeUndefined()
    expect(r.reading).not.toMatch(/lowest_per_indicator/)
  })

  it('leaves a single subject alone', () => {
    const one = { methods: matrix.methods, subjects: [matrix.subjects[0]] }
    expect(annotateComparison(one)).toEqual(one)
  })
})

describe('compare', () => {
  it('refuses a call with neither methods nor a family, and strips its own options from the request', async () => {
    const api = vi.fn<ToolCtx['api']>(async () => matrix)
    const refused = text(await tool('compare').run({ subjects: [{ database: 'd', code: 'c' }] }, ctx(api)))
    expect(refused.error).toMatch(/methods.*method_family/)
    expect(api).not.toHaveBeenCalled()

    await tool('compare').run(
      { subjects: [{ database: 'd', code: 'c' }], method_family: 'EF v3.1', normalize_to_first: true },
      ctx(api)
    )
    const body = api.mock.calls[0][2] as Record<string, unknown>
    expect(body.method_family).toBe('EF v3.1')
    expect(body).not.toHaveProperty('normalize_to_first')
  })
})

describe('explain_result mode="matrix"', () => {
  it('sends every method in ONE request to the matrix endpoint', async () => {
    const api = vi.fn<ToolCtx['api']>(async () => ({
      meta: { cutoff: 0.01, n_included: 3, n_shown: 3, methods: [] },
      rows: [],
      rest: []
    }))
    const out = text(
      await tool('explain_result').run(
        {
          mode: 'matrix',
          database: 'd',
          code: 'c',
          methods: [
            ['x', 'gwp'],
            ['x', 'w']
          ],
          cutoff: 0.02
        },
        ctx(api)
      )
    )
    expect(api).toHaveBeenCalledTimes(1)
    const [, path, body] = api.mock.calls[0] as unknown as [string, string, Record<string, unknown>]
    expect(path).toBe('/api/v1/calc/contribution-matrix')
    expect(body.methods).toEqual([
      ['x', 'gwp'],
      ['x', 'w']
    ])
    expect(body.cutoff).toBe(0.02)
    expect(body.top_n).toBe(30)
    expect(out.reading).toMatch(/OWN impact/)
  })

  it('refuses a matrix without methods before calling anything', async () => {
    const api = vi.fn<ToolCtx['api']>(async () => ({}))
    const out = text(await tool('explain_result').run({ mode: 'matrix', database: 'd', code: 'c' }, ctx(api)))
    expect(out.error).toMatch(/needs "methods"/)
    expect(api).not.toHaveBeenCalled()
  })
})

describe('calculate', () => {
  it('passes direct_split and method_family through', async () => {
    const api = vi.fn<ToolCtx['api']>(async () => ({ results: [] }))
    await tool('calculate').run(
      { database: 'd', code: 'c', method_family: 'IPCC 2021', direct_split: true },
      ctx(api)
    )
    const body = api.mock.calls[0][2] as Record<string, unknown>
    expect(body.method_family).toBe('IPCC 2021')
    expect(body.direct_split).toBe(true)
  })
})
