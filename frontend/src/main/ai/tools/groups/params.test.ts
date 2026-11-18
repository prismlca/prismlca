/**
 * compare_scenarios' contract towards the model when several indicators are asked at once: one request
 * carrying every method, a partial answer asked for, and each method at its own place in the batch. And
 * when none is asked: a refusal that names the tool to find one, since there is no default indicator.
 */
import { describe, expect, it, vi } from 'vitest'
import { paramsTools } from './params'
import type { ToolCtx } from '../context'

const tool = (name: string) => paramsTools.find((t) => t.spec.function.name === name)!

const text = (out: unknown): any => JSON.parse(out as string)

function ctx(api: ToolCtx['api']): ToolCtx {
  return { api, ui: vi.fn(), activeDb: 'Model A' } as unknown as ToolCtx
}

describe('compare_scenarios with several methods', () => {
  it('scores the methods that resolve and names a misspelt one at its own place', async () => {
    const wrong = ['EF v3.1', 'acidification', 'guessed']
    const installed = ['EF v3.1', 'climate change', 'global warming potential (GWP100)']
    const block = (method: string[], score: number) => ({
      method,
      baseline_score: score,
      results: [{ scenario: '(baseline)', score }]
    })
    const api = vi.fn<ToolCtx['api']>(async () => ({
      results: [block(installed, 2), block(['x', 'water'], 1)],
      not_computed: [
        {
          method: wrong,
          code: 'method_not_found',
          error: "LCIA method ['EF v3.1', 'acidification', 'guessed'] not found.",
          hint: 'Closest: EF v3.1 · acidification · accumulated exceedance (AE)'
        }
      ]
    }))
    const out = text(
      await tool('compare_scenarios').run(
        {
          code: 'p',
          scenario_ids: ['s1'],
          methods: [['ef 3.1 climate change gwp100'], wrong, ['x', 'water']]
        },
        ctx(api)
      )
    )
    expect(api).toHaveBeenCalledTimes(1)
    expect((api.mock.calls[0][2] as Record<string, unknown>).partial).toBe(true)
    expect(out.total).toBe(3)
    expect(out.failed).toBe(1)
    // In the order asked: the scored block under its installed name, the miss with its way out, the next block.
    expect(out.results[0].result.method).toEqual(installed)
    expect(out.results[1]).toMatchObject({ i: 1, ok: false, item: wrong })
    expect(out.results[1].error).toMatch(/not found\. Closest: EF v3\.1 · acidification/)
    expect(out.results[2].result.method).toEqual(['x', 'water'])
    expect(out.error).toBeUndefined()
  })

  it('keeps the order when the same wrong method is asked twice around a valid one', async () => {
    const wrong = ['x', 'nope']
    const miss = { method: wrong, code: 'method_not_found', error: 'not found.', hint: '' }
    const api = vi.fn<ToolCtx['api']>(async () => ({
      results: [{ method: ['x', 'gwp'], results: [] }],
      not_computed: [miss, miss]
    }))
    const out = text(
      await tool('compare_scenarios').run(
        { code: 'p', scenario_ids: ['s1'], methods: [wrong, ['x', 'gwp'], wrong] },
        ctx(api)
      )
    )
    expect(out.results.map((r: any) => r.ok)).toEqual([false, true, false])
    expect(out.results[1].result.method).toEqual(['x', 'gwp'])
    expect(out.results[0].error).toBe('not found.')
  })
})

describe('compare_scenarios without an indicator', () => {
  // There is no default indicator: the call is refused before it reaches the backend, whose own refusal
  // points at an HTTP route the model cannot call.
  it.each([{}, { method: [] }, { method: '  ' }, { methods: [] }, { method: null, methods: [] }])(
    'refuses %j and points at list_methods',
    async (args) => {
      const api = vi.fn<ToolCtx['api']>(async () => ({}))
      const out = text(
        await tool('compare_scenarios').run({ code: 'p', scenario_ids: ['s1'], ...args }, ctx(api))
      )
      expect(api).not.toHaveBeenCalled()
      expect(out.error).toMatch(/No indicator given/)
      expect(out.error).toMatch(/list_methods/)
    }
  )

  it('still sends one method when only "method" is given', async () => {
    const api = vi.fn<ToolCtx['api']>(async () => ({ method: ['x', 'gwp'], results: [] }))
    await tool('compare_scenarios').run(
      { code: 'p', scenario_ids: ['s1'], method: 'x · gwp', methods: [] },
      ctx(api)
    )
    expect(api).toHaveBeenCalledTimes(1)
    expect((api.mock.calls[0][2] as Record<string, unknown>).method).toBe('x · gwp')
  })
})
