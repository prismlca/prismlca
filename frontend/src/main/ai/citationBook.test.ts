/**
 * The evidence book: one entry per cited page, and what a leg wrote as its source matched against it.
 */
import { describe, expect, it } from 'vitest'
import { CitationBook, isProviderLink, urlKey } from './citationBook'

describe('evidence from the engine', () => {
  it('keys URLs so scheme, www, fragment and trailing punctuation do not make a different page', () => {
    expect(urlKey('https://www.Example.org/a/b/#top')).toBe('example.org/a/b')
    expect(urlKey('http://example.org/a/b).')).toBe('example.org/a/b')
    expect(urlKey('example.org/a/b')).toBe('example.org/a/b')
  })

  it('collects citations once per page, keeps the first excerpt and finds the pages behind sources', () => {
    const book = new CitationBook()
    book.add([{ url: 'https://a.de/p', title: 'A', excerpt: '  mass:   2 kg  ' }])
    book.add([{ url: 'http://www.a.de/p/', excerpt: 'later' }, { url: 'https://b.de/q' }])
    book.add([{ url: 'https://b.de/q', excerpt: 'B says 3 kg' }])
    expect(book.size).toBe(2)
    expect(book.has('https://A.de/p#x')).toBe(true)
    expect(book.has('https://c.de')).toBe(false)
    expect(book.evidenceFor(['https://b.de/q', 'https://a.de/p', 'https://c.de', 'https://b.de/q'])).toEqual([
      { url: 'https://b.de/q', excerpt: 'B says 3 kg' },
      { url: 'https://a.de/p', title: 'A', excerpt: 'mass: 2 kg' }
    ])
  })

  it('caps an excerpt so a whole page never rides along', () => {
    const book = new CitationBook()
    book.add([{ url: 'https://a.de', excerpt: 'x'.repeat(5000) }])
    expect(book.evidenceFor(['https://a.de'])[0].excerpt).toHaveLength(400)
  })

  it('knows a provider’s link to a page as that page — the model quotes the link (Google)', () => {
    const book = new CitationBook()
    const link1 = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ1'
    const link2 = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ2'
    book.add([{ url: 'https://plasticseurope.org/pet', title: 'plasticseurope.org', via: [link1, link2] }])
    expect(book.has(link2)).toBe(true)
    expect(book.canonical(link1)).toBe('https://plasticseurope.org/pet')
    expect(book.canonical('https://other.org/x')).toBe('https://other.org/x')
    expect(book.evidenceFor([link1])).toEqual([
      { url: 'https://plasticseurope.org/pet', title: 'plasticseurope.org' }
    ])
    expect(book.size).toBe(1)
  })

  it('tells a provider’s citation link from a page, so a dead one is not kept as a source', () => {
    expect(isProviderLink('https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZ9')).toBe(true)
    expect(isProviderLink('https://bottledwater.org/report.pdf')).toBe(false)
    expect(isProviderLink('not a url')).toBe(false)
  })
})
