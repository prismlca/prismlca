import { describe, expect, it } from 'vitest'
import { RoundLookups, WEB_LOOKUPS_ROW } from './webLookups'

describe('one round’s web lookups', () => {
  it('adds the passes of a round up into one record and one trace row, then starts empty', () => {
    const r = new RoundLookups()
    // A paused reply that was continued reports each pass.
    r.count({ web_search_requests: 2 })
    r.count({ web_search_requests: 1, web_fetch_requests: 0 })
    r.searched([{ query: 'a', results: [{ url: 'https://a.org' }] }])
    r.searched([{ query: 'b', results: [] }])
    r.cite([
      { url: 'https://a.org', title: 'A', excerpt: '  2.15   kg ' },
      { url: 'https://a.org', title: 'A again' },
      { url: 'https://b.org', uncited: true }
    ])
    const done = r.take()
    expect(done?.record).toEqual({
      counts: { web_search_requests: 3 },
      searches: [
        { query: 'a', results: [{ url: 'https://a.org' }] },
        { query: 'b', results: [] }
      ],
      // A page the search only returned is no citation.
      cited: [{ url: 'https://a.org', title: 'A', excerpt: '2.15 kg' }]
    })
    expect(done?.row).toMatchObject({
      name: WEB_LOOKUPS_ROW,
      status: 'ok',
      searches: done?.record.searches,
      cited: done?.record.cited
    })
    expect(done?.row.preview).toContain('3 web searches — run by the provider inside this reply')
    expect(r.take()).toBeNull()
  })

  it('names searches the provider did not count, and a reply that only cites earlier results', () => {
    const r = new RoundLookups()
    r.searched([{ query: 'q' }])
    expect(r.take()?.row.preview).toBe('1 web search — run by the provider inside this reply.')
    r.cite([{ url: 'https://a.org' }])
    const cited = r.take()
    expect(cited?.row.preview).toMatch(/No lookup in this reply/)
    expect(cited?.record).toEqual({ cited: [{ url: 'https://a.org' }] })
  })

  it('is nothing when the provider looked nothing up and the reply cites nothing', () => {
    const r = new RoundLookups()
    r.count({ web_search_requests: 0 })
    r.cite([{ url: 'https://b.org', uncited: true }])
    expect(r.take()).toBeNull()
  })
})
