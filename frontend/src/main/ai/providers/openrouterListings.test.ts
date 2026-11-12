import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The price column of the settings table, priced the way routing may serve the request: the cheapest
 * endpoint the provider allowlist admits and — for a model whose requests carry `zdr` — one that retains
 * nothing. The listing's own figure belonged to any host at all; with an allowlist it could be a host
 * the request never reaches.
 *
 * The module caches in module-level variables, so every case re-imports it (and the routing state it
 * reads) fresh.
 */
type Ep = { tag: string; prompt: string; completion: string; service_tier?: string }
const ep = (tag: string, prompt: string, completion: string, service_tier?: string): Ep => ({
  tag,
  prompt,
  completion,
  service_tier
})

/** $/1M from a per-token string, as the module computes it — compared approximately. */
const price = (input: number, output: number): unknown => ({
  input: expect.closeTo(input, 6),
  output: expect.closeTo(output, 6)
})

const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as Response

async function load(): Promise<typeof import('./openrouter') & typeof import('./openrouterListings')> {
  vi.resetModules()
  const routing = await import('./openrouter')
  const listings = await import('./openrouterListings')
  return { ...routing, ...listings }
}

/** A fetch answering per model from `byModel`, the ZDR listing from `zdr`; it records every URL. */
function serve(byModel: Record<string, Ep[]>, zdr: Array<[string, string]> = []): string[] {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url)
    if (url.endsWith('/endpoints/zdr')) return ok({ data: zdr.map(([model_id, tag]) => ({ model_id, tag })) })
    const m = /\/models\/(.+)\/endpoints$/.exec(url)
    const eps = m ? byModel[decodeURIComponent(m[1])] : undefined
    if (!eps) return { ok: false, status: 404 } as Response
    return ok({
      data: {
        endpoints: eps.map((e) => ({
          tag: e.tag,
          service_tier: e.service_tier,
          pricing: { prompt: e.prompt, completion: e.completion }
        }))
      }
    })
  })
  return calls
}

const GLM = [
  ep('wafer/us', '0.00000007', '0.0000014'),
  ep('deepinfra/fp4', '0.00000056', '0.0000025'),
  ep('novita/fp8', '0.00000063', '0.00000198')
]

afterEach(() => vi.unstubAllGlobals())

describe('fetchOpenRouterPricing', () => {
  it('prices only what the allowlist admits — not the cheapest host anywhere', async () => {
    serve({ 'z-ai/glm-5.3': GLM })
    const m = await load()
    m.setZeroDataRetention(false)
    m.setProviderAllowlist(['deepinfra', 'novita'])
    expect((await m.fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k'))['z-ai/glm-5.3']).toEqual(price(0.63, 1.98))
  })

  it('takes the cheapest endpoint overall when nothing restricts the routing', async () => {
    serve({ 'z-ai/glm-5.3': GLM })
    const m = await load()
    m.setZeroDataRetention(false)
    m.setProviderAllowlist(null)
    const p = (await m.fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k'))['z-ai/glm-5.3']
    expect(p.input).toBeCloseTo(0.07)
    expect(p.output).toBeCloseTo(1.4)
  })

  it('keeps to zero-retention endpoints where the request carries `zdr`, and not for an exempted vendor', async () => {
    serve(
      {
        'z-ai/glm-5.3': GLM,
        'anthropic/claude-fable-5.2': [ep('anthropic', '0.000005', '0.000025')]
      },
      [['z-ai/glm-5.3', 'novita/fp8']]
    )
    const m = await load()
    m.setZeroDataRetention(true, { anthropic: true, openai: true, google: true })
    m.setProviderAllowlist(null)
    const out = await m.fetchOpenRouterPricing(['z-ai/glm-5.3', 'anthropic/claude-fable-5.2'], 'k')
    expect(out['z-ai/glm-5.3']).toEqual(price(0.63, 1.98))
    // Fable has no zero-retention endpoint; its vendor is exempt, so its request carries no `zdr`.
    expect(out['anthropic/claude-fable-5.2']).toEqual(price(5, 25))
  })

  it('leaves out flex endpoints, which routing only uses for the :floor variant', async () => {
    serve({
      'deepseek/deepseek-v4.1-flash': [
        ep('deepinfra/fp8/flex', '0.000000112', '0.000000336', 'flex'),
        ep('deepinfra/fp8', '0.00000014', '0.00000042')
      ]
    })
    const m = await load()
    m.setZeroDataRetention(false)
    m.setProviderAllowlist(['deepinfra'])
    const p = (await m.fetchOpenRouterPricing(['deepseek/deepseek-v4.1-flash'], 'k'))[
      'deepseek/deepseek-v4.1-flash'
    ]
    expect(p.input).toBeCloseTo(0.14)
  })

  it('matches a variant slug on the list to that variant only', async () => {
    serve({
      'z-ai/glm-5.3': [
        ep('deepinfra/fp4', '0.00000056', '0.0000025'),
        ep('deepinfra/fp8', '0.0000004', '0.000002')
      ]
    })
    const m = await load()
    m.setZeroDataRetention(false)
    m.setProviderAllowlist(['deepinfra/fp4'])
    expect((await m.fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k'))['z-ai/glm-5.3'].input).toBeCloseTo(0.56)
  })

  it('shows no price when no permitted endpoint serves the model, or the model has no page', async () => {
    serve({ 'z-ai/glm-5.3': GLM })
    const m = await load()
    m.setZeroDataRetention(false)
    m.setProviderAllowlist(['fireworks'])
    const out = await m.fetchOpenRouterPricing(['z-ai/glm-5.3', 'minimax/minimax-m3:free'], 'k')
    expect(out['z-ai/glm-5.3']).toBeUndefined()
    expect(out['minimax/minimax-m3:free']).toBeUndefined()
  })
})

describe('the price cache', () => {
  it('answers again for the same ids and settings, and asks again after either changed', async () => {
    const calls = serve({ 'z-ai/glm-5.3': GLM, 'new/model': [ep('deepinfra', '0.000001', '0.000002')] })
    const m = await load()
    m.setZeroDataRetention(false)
    m.setProviderAllowlist(['deepinfra', 'novita'])
    const lookups = (): number => calls.filter((c) => c.includes('/models/')).length
    await m.fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    expect(lookups()).toBe(1)
    await m.fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    expect(lookups()).toBe(1)
    // A model just added through the dialog: the cache cannot answer for it.
    const added = await m.fetchOpenRouterPricing(['z-ai/glm-5.3', 'new/model'], 'k')
    expect(added['new/model']).toEqual(price(1, 2))
    expect(lookups()).toBe(3)
    // The allowlist edited on the Provider page: the prices were for the old list.
    m.setProviderAllowlist(['deepinfra'])
    const narrowed = await m.fetchOpenRouterPricing(['z-ai/glm-5.3', 'new/model'], 'k')
    expect(narrowed['z-ai/glm-5.3'].input).toBeCloseTo(0.56)
    expect(lookups()).toBe(5)
  })

  it('remembers a model without a price as asked, instead of asking for it on every read', async () => {
    const calls = serve({})
    const m = await load()
    m.setProviderAllowlist(null)
    await m.fetchOpenRouterPricing(['gone/model'], 'k')
    await m.fetchOpenRouterPricing(['gone/model'], 'k')
    expect(calls.filter((c) => c.includes('/models/'))).toHaveLength(1)
  })

  it('asks again soon, not in an hour, when a lookup failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      let fail = true
      vi.stubGlobal('fetch', async () => {
        if (fail) throw new Error('network')
        return ok({
          data: { endpoints: [{ tag: 'deepinfra', pricing: { prompt: '0.000001', completion: '0.000002' } }] }
        })
      })
      const m = await load()
      m.setZeroDataRetention(false)
      m.setProviderAllowlist(null)
      expect(await m.fetchOpenRouterPricing(['a/b'], 'k')).toEqual({})
      fail = false
      // Within the minute the empty answer stands; after it, the lookup is made again.
      expect(await m.fetchOpenRouterPricing(['a/b'], 'k')).toEqual({})
      vi.setSystemTime(Date.now() + 61_000)
      expect(await m.fetchOpenRouterPricing(['a/b'], 'k')).toEqual({ 'a/b': price(1, 2) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('can be dropped outright, for when the catalogue changed under it', async () => {
    const calls = serve({ 'z-ai/glm-5.3': GLM })
    const m = await load()
    m.setProviderAllowlist(null)
    await m.fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    await m.fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    m.clearPriceCache()
    await m.fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    expect(calls.filter((c) => c.includes('/models/'))).toHaveLength(2)
  })
})

describe('what a lookup that went wrong may show', () => {
  it('gives a model whose requests carry `zdr` no price while the ZDR listing is missing', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/endpoints/zdr')) return { ok: false, status: 503 } as Response
      return ok({
        data: {
          endpoints: GLM.map((e) => ({ tag: e.tag, pricing: { prompt: e.prompt, completion: e.completion } }))
        }
      })
    })
    const m = await load()
    m.setZeroDataRetention(true, { anthropic: true, openai: true, google: true })
    m.setProviderAllowlist(null)
    const out = await m.fetchOpenRouterPricing(['z-ai/glm-5.3', 'anthropic/claude-sonnet-5.5'], 'k')
    // Not the cheapest host anywhere — that one may keep data and never see this request.
    expect(out['z-ai/glm-5.3']).toBeUndefined()
    // An exempted vendor needs no ZDR listing and is priced as usual.
    expect(out['anthropic/claude-sonnet-5.5']).toBeDefined()
  })

  it('stops waiting at the deadline and answers with what came back', async () => {
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url.includes('fast'))
        return Promise.resolve(
          ok({
            data: {
              endpoints: [{ tag: 'deepinfra', pricing: { prompt: '0.000001', completion: '0.000002' } }]
            }
          })
        )
      // A stalled lookup: it ends only when it is aborted.
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      )
    })
    const m = await load()
    m.setZeroDataRetention(false)
    m.setProviderAllowlist(null)
    m.setPricingDeadlineForTests(50)
    try {
      const started = Date.now()
      const out = await m.fetchOpenRouterPricing(['a/fast', 'a/slow'], 'k')
      expect(Date.now() - started).toBeLessThan(2000)
      expect(out['a/fast']).toEqual(price(1, 2))
      expect(out['a/slow']).toBeUndefined()
    } finally {
      m.setPricingDeadlineForTests()
    }
  })

  it('keeps its cache above the lookup cap, instead of asking for everything on every read', async () => {
    const calls = serve({})
    const m = await load()
    m.setZeroDataRetention(false)
    m.setProviderAllowlist(null)
    const ids = Array.from({ length: 61 }, (_, i) => `v/m${i}`)
    await m.fetchOpenRouterPricing(ids, 'k')
    const first = calls.length
    expect(first).toBe(60)
    await m.fetchOpenRouterPricing(ids, 'k')
    expect(calls.length).toBe(first)
  })

  it('prices under the settings it started with, even when they change while it waits', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/endpoints/zdr'))
        return ok({ data: [{ model_id: 'z-ai/glm-5.3', tag: 'novita/fp8' }] })
      await gate
      return ok({
        data: {
          endpoints: GLM.map((e) => ({ tag: e.tag, pricing: { prompt: e.prompt, completion: e.completion } }))
        }
      })
    })
    const m = await load()
    m.setZeroDataRetention(true)
    m.setProviderAllowlist(null)
    const pending = m.fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k')
    await Promise.resolve()
    m.setZeroDataRetention(false) // switched off while the lookup waits
    release()
    // The answer belongs to the strict setting it was asked under: the zero-retention host's price.
    expect((await pending)['z-ai/glm-5.3']).toEqual(price(0.63, 1.98))
    // Under the new setting the cache does not answer with it; the cheapest host anywhere is asked for.
    expect((await m.fetchOpenRouterPricing(['z-ai/glm-5.3'], 'k'))['z-ai/glm-5.3'].input).toBeCloseTo(0.07)
  })
})

describe('fetchOpenRouterProviders', () => {
  it('names the hosts in our spelling where we have one, and keeps OpenRouter’s otherwise', async () => {
    vi.stubGlobal('fetch', async () =>
      ok({
        data: [
          { slug: 'google-vertex', name: 'Google', headquarters: 'US' },
          { slug: 'groq', name: 'Groq', headquarters: 'US' },
          { slug: 7, name: 'broken' }
        ]
      })
    )
    const m = await load()
    expect(await m.fetchOpenRouterProviders('k')).toEqual([
      { slug: 'google-vertex', name: 'Google Vertex', headquarters: 'US' },
      { slug: 'groq', name: 'Groq', headquarters: 'US' }
    ])
  })
})
