import { describe, expect, it } from 'vitest'
import { searchesSection } from './reviewSearches'

describe('the dossier’s web searches', () => {
  it('lists each search with the pages that came back, and the passages the replies cited', () => {
    const text = searchesSection([
      {
        counts: { web_search_requests: 2 },
        searches: [
          {
            query: 'avasco Atlas Gewicht',
            results: [{ url: 'https://www.galaxus.ch/p/64601145', title: 'Avasco Steckregal Atlas 175' }]
          },
          { query: 'avasco Diksmuide', results: [], error: 'max_uses_exceeded' }
        ],
        cited: [{ url: 'https://www.galaxus.ch/p/64601145', title: 'Atlas 175', excerpt: 'Weight 24000 g' }]
      },
      { counts: { web_search_requests: 1 }, cited: [{ url: 'https://a.org/x' }] }
    ])
    expect(text).toMatch(/^WEB SEARCHES IN THIS CHAT/)
    expect(text).toContain(
      '- "avasco Atlas Gewicht" → Avasco Steckregal Atlas 175 (https://www.galaxus.ch/p/64601145)'
    )
    expect(text).toContain('- "avasco Diksmuide" → no pages (max_uses_exceeded)')
    // A reply whose provider only counted its lookups still says that it looked something up.
    expect(text).toContain('Further lookups whose search texts the provider does not report: 1 web search.')
    expect(text).toContain('- "Weight 24000 g" — Atlas 175 (https://www.galaxus.ch/p/64601145)')
    expect(text).toContain('PAGES THE REPLIES CITED: https://a.org/x')
  })

  it('names fewer pages per search before it cuts the section', () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.org/some/long/path/${i}`,
      title: `A product page with a fairly long title number ${i}`
    }))
    const text = searchesSection([
      { searches: Array.from({ length: 8 }, (_, i) => ({ query: `q${i}`, results })) }
    ])
    expect(text.length).toBeLessThanOrEqual(6_000)
    expect(text).toContain('more')
    expect(text).toContain('"q7"')
  })

  it('is empty for a chat that looked nothing up', () => {
    expect(searchesSection([])).toBe('')
    expect(searchesSection([{ counts: { web_search_requests: 0 } }])).toBe('')
  })
})
