import { describe, expect, it } from 'vitest'
import { searchNote, withSearchNote } from './searchNote'

const atlas = { url: 'https://www.galaxus.ch/p/64601145', title: 'Avasco Atlas 175  176x90x40 cm' }

describe('the record of a reply’s web lookups', () => {
  it('names each search with what it looked for and the pages that came back', () => {
    const note = searchNote({
      searches: [
        { query: 'avasco Atlas Gewicht', results: [atlas, { url: 'https://hornbach.de/p/12008577' }] },
        { query: 'avasco Diksmuide', results: [], error: 'max_uses_exceeded' },
        { query: 'avasco Herkunft' }
      ],
      cited: [{ url: atlas.url, title: atlas.title, excerpt: '24000 g' }]
    })
    expect(note).toBe(
      '[Web search record kept by PrismLCA. In this reply you searched the web 3 times through the ' +
        'provider. Kept are what you searched for, the pages that came back and the passages your reply ' +
        'cited; the rest of the pages’ text is gone:\n' +
        '1. "avasco Atlas Gewicht" → Avasco Atlas 175 176x90x40 cm (https://www.galaxus.ch/p/64601145); ' +
        'https://hornbach.de/p/12008577\n' +
        '2. "avasco Diksmuide" → no pages (max_uses_exceeded)\n' +
        '3. "avasco Herkunft" → pages not reported by the provider\n' +
        'Cited in this reply:\n' +
        '- "24000 g" — Avasco Atlas 175 176x90x40 cm (https://www.galaxus.ch/p/64601145)]'
    )
  })

  it('says what the provider did not report when it only counts its lookups', () => {
    const note = searchNote({
      counts: { web_search_requests: 3, web_fetch_requests: 1 },
      cited: [{ url: 'https://a.org/x' }]
    })
    expect(note).toBe(
      '[Web search record kept by PrismLCA. In this reply the provider looked things up on the web for ' +
        'you (3 web searches, 1 page fetched). It reports neither what was searched for nor the pages that ' +
        'came back.\n' +
        'Cited in this reply:\n- https://a.org/x]'
    )
  })

  it('lists ten pages of a search and counts the rest, and cuts a long title', () => {
    const results = Array.from({ length: 13 }, (_, i) => ({
      url: `https://e.org/${i}`,
      title: 'T'.repeat(150)
    }))
    const note = searchNote({ searches: [{ query: 'q', results }] }) ?? ''
    expect(note).toContain('https://e.org/9)')
    expect(note).not.toContain('https://e.org/10')
    expect(note).toContain('; 3 more')
    expect(note).toContain(`${'T'.repeat(99)}… (https://e.org/0)`)
  })

  it('is nothing for a reply that looked nothing up', () => {
    expect(searchNote(undefined)).toBeNull()
    expect(searchNote({})).toBeNull()
    expect(searchNote({ counts: { web_search_requests: 0 }, searches: [], cited: [] })).toBeNull()
  })

  it('goes ahead of text, of a list of parts, and stands alone where there is no text', () => {
    const web = { searches: [{ query: 'q', results: [] }] }
    const note = searchNote(web)
    expect(withSearchNote('Answer.', web)).toBe(`${note}\n\nAnswer.`)
    expect(withSearchNote(null, web)).toBe(note)
    expect(withSearchNote([{ type: 'text', text: 'A' }], web)).toEqual([
      { type: 'text', text: `${note}\n\nA` }
    ])
    expect(withSearchNote([{ type: 'image_url', image_url: { url: 'x' } }], web)).toEqual([
      { type: 'text', text: note },
      { type: 'image_url', image_url: { url: 'x' } }
    ])
    expect(withSearchNote('Answer.', undefined)).toBe('Answer.')
  })

  it('reads the same whether the cache breakpoint sits on the message or has moved on', () => {
    // The agent turns a marked text into one part and back into a string; a second part for the record
    // would change the message, and with it the cached prefix, every time the breakpoint moves.
    const web = { searches: [{ query: 'q', results: [] }] }
    const marked = withSearchNote(
      [{ type: 'text', text: 'Answer.', cache_control: { type: 'ephemeral' } }],
      web
    ) as Array<Record<string, unknown>>
    expect(marked).toEqual([
      { type: 'text', text: withSearchNote('Answer.', web), cache_control: { type: 'ephemeral' } }
    ])
  })
})
