/**
 * The distances tool's own contract: what it hands the model, what it puts on the tool-call row,
 * what it logs as provenance, and that it refuses when it should not have been offered.
 */
import { describe, expect, it, vi } from 'vitest'
import { distancesTools } from './distances'
import type { ToolCtx } from '../context'

const tool = distancesTools[0]

const batch = {
  mode: 'road',
  geocoder: 'ors',
  results: [
    {
      from: { text: 'Heidelberg', resolved: 'Heidelberg, Germany', lat: 49.41, lon: 8.69 },
      to: { text: 'Hamburg', resolved: 'Hamburg, Germany', lat: 53.55, lon: 9.99 },
      km: 504,
      raw_km: 480,
      adjustment: 'routed distance × 1.05 (GLEC / ISO 14083: +5 % planned → actual)'
    },
    {
      from: { text: 'Atlantis' },
      to: { text: 'Hamburg' },
      error: 'from: openrouteservice found no place for "Atlantis".'
    }
  ],
  attribution:
    'Routing © openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors · Geocoding: openrouteservice (© OpenStreetMap contributors)',
  quota: {
    turn_used: 3,
    turn_limit: 30,
    day_geocode_used: 2,
    day_geocode_limit: 3000,
    day_route_used: 1,
    day_route_limit: 2000
  },
  skipped: [{ from: 'A', to: 'B', reason: 'per-turn limit of 30 API calls reached' }]
}

function ctx(over: Partial<ToolCtx> = {}): ToolCtx {
  return {
    api: vi.fn(async () => ({})),
    ui: vi.fn(),
    activeDb: 'Model A',
    distancesAvailable: true,
    distances: vi.fn(async () => batch),
    ...over
  }
}

describe('distances tool', () => {
  it('is one tool for all four modes with a required mode and pairs', () => {
    const p = tool.spec.function.parameters as { required: string[]; properties: Record<string, unknown> }
    expect(tool.spec.function.name).toBe('distances')
    expect(p.required).toEqual(['mode', 'pairs'])
    expect(Object.keys(p.properties)).toEqual(['mode', 'pairs'])
    expect(tool.spec.function.description).toMatch(/rail infrastructure/)
    expect(tool.spec.function.description).toMatch(/ONE WAY/)
  })

  it('returns the batch as the result and the attribution as the row notice', async () => {
    const c = ctx()
    const out = (await tool.run({ mode: 'road', pairs: [{ from: 'Heidelberg', to: 'Hamburg' }] }, c)) as {
      result: string
      notice: string
    }
    expect(c.distances).toHaveBeenCalledWith('road', [{ from: 'Heidelberg', to: 'Hamburg' }])
    const parsed = JSON.parse(out.result)
    expect(parsed.results[0].km).toBe(504)
    expect(parsed.skipped).toHaveLength(1)
    expect(parsed.attribution).toContain('OpenStreetMap contributors')
    expect(out.notice).toBe(batch.attribution)
  })

  it('logs every measured pair as provenance, with the attribution in the finding, and skips failed ones', async () => {
    const c = ctx()
    await tool.run({ mode: 'road', pairs: [] }, c)
    expect(c.api).toHaveBeenCalledTimes(1)
    const [method, path, body] = (c.api as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string, any]
    expect(method).toBe('POST')
    expect(path).toBe('/api/v1/provenance/research')
    expect(body.database).toBe('Model A')
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0].question).toBe('Road distance Heidelberg, Germany → Hamburg, Germany')
    expect(body.entries[0].findings[0]).toMatchObject({
      sources: ['https://openrouteservice.org/'],
      source_class: 'official',
      confidence: 'high'
    })
    expect(body.entries[0].findings[0].text).toMatch(/^504 km \(routed distance × 1.05/)
    expect(body.entries[0].findings[0].text).toContain('© OpenStreetMap contributors')
  })

  it('a failed provenance write never costs the result; no model open, no write at all', async () => {
    const failing = ctx({ api: vi.fn(async () => Promise.reject(new Error('backend down'))) })
    const out = (await tool.run({ mode: 'road', pairs: [] }, failing)) as { result: string }
    expect(JSON.parse(out.result).results[0].km).toBe(504)
    const noDb = ctx({ activeDb: null })
    await tool.run({ mode: 'road', pairs: [] }, noDb)
    expect(noDb.api).not.toHaveBeenCalled()
  })

  it('rail findings are logged as low confidence — an estimate, not a route', async () => {
    const c = ctx({ distances: vi.fn(async () => ({ ...batch, mode: 'rail', rail_caveat: 'x' })) })
    await tool.run({ mode: 'rail', pairs: [] }, c)
    const body = (c.api as ReturnType<typeof vi.fn>).mock.calls[0][2] as any
    expect(body.entries[0].findings[0].confidence).toBe('low')
    expect(body.entries[0].question).toMatch(/^Rail distance/)
  })

  it('each access leg is its own finding, crossing and all, so nothing is cut off', async () => {
    const air = {
      ...batch,
      mode: 'air',
      results: [
        {
          from: { text: 'Heidelberg', resolved: 'Heidelberg, Germany' },
          to: { text: 'Shanghai', resolved: 'Shanghai, China' },
          km: 8941.9,
          raw_km: 8846.9,
          adjustment: 'great-circle distance + 95 km for this flight leg',
          access: {
            from: { code: 'FRA', km: 105, crossings: 'present', crossing: { km: 200 } },
            to: { code: 'SHA', error: 'No lorry road within 2000 m of SHA' }
          }
        }
      ]
    }
    const c = ctx({ distances: vi.fn(async () => air) })
    await tool.run({ mode: 'air', pairs: [] }, c)
    const findings = ((c.api as ReturnType<typeof vi.fn>).mock.calls[0][2] as any).entries[0].findings
    expect(findings).toHaveLength(3)
    expect(findings[1].text).toMatch(/Road access Heidelberg, Germany → FRA: 105 km, plus 200 km on a ferry/)
    expect(findings[1].confidence).toBe('medium')
    expect(findings[2].text).toMatch(/SHA → Shanghai, China: not measured/)
    for (const f of findings) expect(f.text.length).toBeLessThanOrEqual(400)
    expect(findings[1].text).toContain('© OpenStreetMap contributors')
  })

  it('refuses in one sentence when it should not have been offered, and passes the service error through', async () => {
    expect(await tool.run({ mode: 'road', pairs: [] }, ctx({ distancesAvailable: false }))).toBe(
      JSON.stringify({ error: 'Distances are not available in this chat.' })
    )
    expect(await tool.run({ mode: 'road', pairs: [] }, ctx({ distances: undefined }))).toMatch(
      /not available/
    )
    const bad = ctx({
      distances: vi.fn(async () =>
        Promise.reject(new Error('Unknown mode "teleport". Expected one of: road | sea | air | rail.'))
      )
    })
    expect(await tool.run({ mode: 'teleport', pairs: [] }, bad)).toBe(
      JSON.stringify({ error: 'Unknown mode "teleport". Expected one of: road | sea | air | rail.' })
    )
  })
})
