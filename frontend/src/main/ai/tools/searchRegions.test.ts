import { describe, expect, it, vi } from 'vitest'
import type { ToolCtx } from './context'
import { readTools } from './groups/read'

const tool = readTools.find((t) => t.spec.function.name === 'search_background')!

/**
 * A backend that answers the four calls the search makes: the study, the regions of the database, their
 * names, and the search itself. Invented regions and datasets.
 */
function backend(geography: string, terms: (query: string) => string[] = () => ['voltage']) {
  const api = vi.fn<ToolCtx['api']>(async (_method, path, body) => {
    if (path.startsWith('/api/v1/study')) return { geography }
    if (path.startsWith('/api/v1/search/geographies/')) return ['BE', 'DE', 'FR', 'RER', 'PE']
    if (path === '/api/v1/search/geography-names') return { names: { RER: 'Europe' } }
    const query = String((body as { query: string }).query)
    return { query, count: 8, content_terms: terms(query), hits: [] }
  })
  const ctx = {
    api,
    ui: vi.fn(),
    activeDb: 'Shelf',
    backgroundDbs: ['eco'],
    searched: new Map()
  } as unknown as ToolCtx
  const searches = () =>
    api.mock.calls
      .filter((c) => c[1] === '/api/v1/search/activities')
      .map((c) => c[2] as Record<string, unknown>)
  const run = async (args: Record<string, unknown>) => JSON.parse(String(await tool.run(args, ctx)))
  return { api, ctx, searches, run }
}

describe('search_background: the study region shows a folded hit', () => {
  it('sends the regions the study names when the query names none', async () => {
    const b = backend('Hergestellt in Belgien, verkauft und entsorgt in Deutschland')
    await b.run({ query: 'market for electricity medium voltage' })
    expect(b.searches()[0].prefer_geographies).toEqual(['BE', 'DE'])
    expect(b.searches()[0]).not.toHaveProperty('geographies')
  })

  it('leaves a region the query asks for alone', async () => {
    const b = backend('sold in Germany')
    await b.run({
      filtered_queries: [{ query: 'tap water', geographies: ['FR'] }, { query: 'electricity' }]
    })
    const [water, power] = b.searches()
    expect(water.geographies).toEqual(['FR'])
    expect(water).not.toHaveProperty('prefer_geographies')
    expect(power.prefer_geographies).toEqual(['DE'])
  })

  it('reads the study and the regions once per call, and sends nothing without a geography', async () => {
    const b = backend('sold in Germany')
    await b.run({ queries: ['steel', 'glass', 'paper'] })
    const reads = b.api.mock.calls.map((c) => c[1]).filter((p) => p !== '/api/v1/search/activities')
    expect(reads.filter((p) => p.startsWith('/api/v1/study'))).toHaveLength(1)
    expect(reads.filter((p) => p.startsWith('/api/v1/search/geographies/'))).toHaveLength(1)

    const empty = backend('')
    await empty.run({ query: 'steel' })
    expect(empty.searches()[0]).not.toHaveProperty('prefer_geographies')
  })
})

describe('search_background: a repeat that only adds a place', () => {
  it('asks whether the added place was meant as a region and names the geographies argument', async () => {
    const b = backend('')
    await b.run({ query: 'market for electricity medium voltage' })
    const again = await b.run({ query: 'market for electricity medium voltage DE' })
    expect(again.already_searched.places_in_query).toEqual(['DE'])
    expect(again.already_searched.note).toContain('"geographies": ["DE"]')
    expect(again.warnings.join('\n')).toContain("does not choose a dataset's region")
  })

  it('only asks whether a code that is also a word was meant as a region', async () => {
    // "PE" is Peru in the database and polyethylene in the query: the note must not claim it was a place.
    const b = backend('', () => ['film', 'plastic'])
    await b.run({ query: 'plastic film' })
    const again = await b.run({ query: 'plastic film PE' })
    expect(again.already_searched.places_in_query).toEqual(['PE'])
    expect(again.already_searched.note).toContain('If what your query adds (PE) is meant as a region:')
    expect(again.already_searched.note).not.toMatch(/not searched|same datasets/)
  })

  it('stays the plain repeat note when the query adds no place', async () => {
    const b = backend('')
    await b.run({ query: 'market for electricity medium voltage DE' })
    // The place was there both times: nothing new to say about it.
    const same = await b.run({ query: 'electricity medium voltage DE' })
    expect(same.already_searched).toBeDefined()
    expect(same.already_searched).not.toHaveProperty('places_in_query')
    const generic = await b.run({ query: 'market for electricity, medium voltage, at grid' })
    expect(generic.already_searched).not.toHaveProperty('places_in_query')
  })
})
