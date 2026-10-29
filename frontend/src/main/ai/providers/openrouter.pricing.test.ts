import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The price column of the settings table, and the one thing about it that is not obvious:
 * OpenRouter's `/models` is a LISTING, not the set of ids it serves. `qwen/qwen3.8-max` is an
 * alias of a dated snapshot — it answers chat completions and `/models/{id}/endpoints`, but the
 * listing only carries `…-max-0902`. It therefore sat in the table with an empty price while
 * working perfectly, which is what the per-id fallback exists to fix.
 *
 * The module caches in a module-level variable, so every case re-imports it fresh.
 */
const LISTING = {
  data: [
    { id: 'z-ai/glm-5.3', pricing: { prompt: '0.0000014', completion: '0.0000044' } },
    { id: 'not/ours', pricing: { prompt: '9', completion: '9' } }
  ]
}

const endpoints = (...prices: Array<[string, string]>): unknown => ({
  data: { endpoints: prices.map(([prompt, completion]) => ({ pricing: { prompt, completion } })) }
})

const ok = (body: unknown): Response => ({ ok: true, json: async () => body }) as Response

async function load(): Promise<typeof import('./openrouter')> {
  vi.resetModules()
  return import('./openrouter')
}

let calls: string[]

beforeEach(() => {
  calls = []
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchOpenRouterPricing', () => {
  it('asks the endpoints of an id the listing does not carry, and takes the cheapest', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      if (url.endsWith('/models')) return ok(LISTING)
      if (url.includes('qwen/qwen3.8-max'))
        return ok(endpoints(['0.000002', '0.000006'], ['0.000009', '0.00001']))
      return { ok: false } as Response
    })
    const { fetchOpenRouterPricing } = await load()
    const out = await fetchOpenRouterPricing(['z-ai/glm-5.3', 'qwen/qwen3.8-max'], 'k')

    // The listed one comes from the listing, in $/1M…
    expect(out['z-ai/glm-5.3']).toEqual({ input: 1.4, output: 4.4 })
    // …and the alias from its own endpoints, cheapest of the two.
    expect(out['qwen/qwen3.8-max']).toEqual({ input: 2, output: 6 })
    // One extra call, only for the id that was missing.
    expect(calls.filter((c) => c.includes('/endpoints'))).toHaveLength(1)
  })

  it('leaves an id with no endpoint without a price rather than inventing a zero', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      if (url.endsWith('/models')) return ok(LISTING)
      return ok({ data: { endpoints: [] } }) // a promo that ended: the model page lives, nothing serves it
    })
    const { fetchOpenRouterPricing } = await load()
    const out = await fetchOpenRouterPricing(['minimax/minimax-m3:free'], 'k')
    expect(out['minimax/minimax-m3:free']).toBeUndefined()
  })

  it('survives an endpoints call that fails, and still returns the listed prices', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/models')) return ok(LISTING)
      throw new Error('network')
    })
    const { fetchOpenRouterPricing } = await load()
    const out = await fetchOpenRouterPricing(['z-ai/glm-5.3', 'qwen/qwen3.8-max'], 'k')
    expect(out['z-ai/glm-5.3']).toEqual({ input: 1.4, output: 4.4 })
    expect(out['qwen/qwen3.8-max']).toBeUndefined()
  })
})

describe('the price cache and a catalogue that grows', () => {
  /**
   * The cache is keyed by nothing — it answers with whatever it fetched for whatever ids were
   * asked for then. That was harmless while the catalogue only changed at startup. It stopped
   * being harmless when a model could be added from the dialog: the new row showed "–" in the
   * price column for up to an hour. Seen in the running app, not in a test.
   */
  it('refetches when an id it has never priced is asked for', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/models')) {
        calls++
        return ok({
          data: [
            { id: 'z-ai/glm-5.3', pricing: { prompt: '0.0000014', completion: '0.0000044' } },
            { id: 'new/model', pricing: { prompt: '0.000001', completion: '0.000002' } }
          ]
        })
      }
      return { ok: false } as Response
    })
    const { fetchOpenRouterPricing } = await load()

    await fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    expect(calls).toBe(1)
    // Same id again: the cache answers.
    await fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    expect(calls).toBe(1)
    // A model the user just added: the cache cannot answer, so it must not pretend to.
    const out = await fetchOpenRouterPricing(['z-ai/glm-5.3', 'new/model'], 'k')
    expect(calls).toBe(2)
    expect(out['new/model']).toEqual({ input: 1, output: 2 })
  })

  it('can be dropped outright, for when the catalogue changed under it', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/models')) {
        calls++
        return ok(LISTING)
      }
      return { ok: false } as Response
    })
    const { fetchOpenRouterPricing, clearPriceCache } = await load()
    await fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    await fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    expect(calls).toBe(1)
    clearPriceCache()
    await fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    expect(calls).toBe(2)
  })
})
