import { describe, expect, it } from 'vitest'
import { NOTE_CHARS, clipNote, linksIn, settleLinks } from './researchNote'

/** `n` characters of whole sentences, each ending on a full stop. */
const prose = (n: number): string => {
  const sentence = 'The datasheet names the tube but no weight. '
  return sentence.repeat(Math.ceil(n / sentence.length)).slice(0, n)
}

describe('linksIn', () => {
  it('finds each address once, in order, without the punctuation of the sentence around it', () => {
    const text =
      'See https://a.example/sheet.pdf, then (https://b.example/p?x=1&y=2). Again: https://a.example/sheet.pdf.'
    expect(linksIn(text)).toEqual(['https://a.example/sheet.pdf', 'https://b.example/p?x=1&y=2'])
  })

  it('keeps a bracket that belongs to the address and drops one that closes the sentence', () => {
    expect(linksIn('(source: https://en.wikipedia.org/wiki/Steel_(alloy))')).toEqual([
      'https://en.wikipedia.org/wiki/Steel_(alloy)'
    ])
    expect(linksIn('the [datasheet](https://c.example/d.pdf) says')).toEqual(['https://c.example/d.pdf'])
    expect(linksIn('**https://c.example/d.pdf**')).toEqual(['https://c.example/d.pdf'])
  })

  it('takes nothing that is not an address', () => {
    expect(linksIn('capito-gmbh.com has it, http:// alone does not count, nor does https://.')).toEqual([])
  })
})

describe('clipNote', () => {
  it('hands a short note on unchanged, with see_also only when it names an address', () => {
    expect(clipNote('  no figure anywhere ')).toEqual({ note: 'no figure anywhere' })
    expect(clipNote('Mass is in https://a.example/sheet.pdf (page 3).')).toEqual({
      note: 'Mass is in https://a.example/sheet.pdf (page 3).',
      see_also: ['https://a.example/sheet.pdf']
    })
    expect(clipNote('   ')).toEqual({})
  })

  it('cuts a long note after a whole sentence and says how much is missing', () => {
    const full = prose(1500).trim()
    const { note, see_also } = clipNote(full)
    expect(see_also).toBeUndefined()
    const [kept, mark] = note!.split(' … ')
    expect(kept.length).toBeLessThanOrEqual(NOTE_CHARS)
    expect(kept.length).toBeGreaterThan(NOTE_CHARS - 50)
    expect(kept.endsWith('no weight.')).toBe(true)
    expect(full.startsWith(kept)).toBe(true)
    expect(mark).toBe(`[note cut here: ${full.length - kept.length} more characters not shown]`)
  })

  it('never cuts an address: the one behind the cut comes back whole in see_also', () => {
    const url = 'https://www.maker.example/downloads/datasheets/barrow-150.pdf'
    const full = `${prose(960)} Datasheet: ${url}`
    const { note, see_also } = clipNote(full)
    expect(see_also).toEqual([url])
    expect(note).not.toContain('https://')
    expect(note).toMatch(
      / … \[note cut here: \d+ more characters not shown; the links it names are in see_also\]$/
    )
  })

  it('falls back to a word boundary when no sentence ends in the second half, never inside a word', () => {
    // A parts list: no sentence end anywhere.
    const list = Array.from({ length: 400 }, (_, i) => `part${i} ${i}x,`).join(' ')
    const { note } = clipNote(list)
    const kept = note!.split(' … ')[0]
    expect(kept.length).toBeLessThanOrEqual(NOTE_CHARS)
    expect(kept.length).toBeGreaterThan(NOTE_CHARS - 20)
    expect(list.startsWith(kept)).toBe(true)
    expect(list[kept.length]).toBe(' ')
  })

  it('does not end the kept text inside an address that straddles the limit', () => {
    const url = `https://shop.example/p/${'a.b-'.repeat(30)}x.html`
    const full = `${prose(NOTE_CHARS - 60)}See ${url} for the listing. ${prose(400)}`
    const { note, see_also } = clipNote(full)
    expect(see_also).toEqual([url])
    expect(note!.split(' … ')[0].endsWith('See')).toBe(false)
    expect(note).not.toContain('https://shop.example/p/a.b-a')
  })

  it('leaves a note whole that is only slightly over: the cut would cost more than it saves', () => {
    const full = prose(NOTE_CHARS + 80).trimEnd()
    expect(clipNote(full)).toEqual({ note: full })
  })

  it('cuts one unbroken token at the limit without splitting a character', () => {
    const { note } = clipNote('x'.repeat(NOTE_CHARS - 1) + '😀'.repeat(200))
    expect(note!.split(' … ')[0]).toBe('x'.repeat(NOTE_CHARS - 1))
  })
})

describe('settleLinks', () => {
  const asIs = (url: string): string | null => url

  it('leaves an entry without addresses alone and keeps a handful in the order of the note', () => {
    expect(settleLinks({ note: 'no figure anywhere' }, asIs)).toEqual({ note: 'no figure anywhere' })
    const entry = clipNote('First https://a.example/1 then https://b.example/2.')
    expect(settleLinks(entry, asIs)).toEqual(entry)
  })

  it('hands on a bounded number of pages, those the cut removed first, and counts the rest', () => {
    const early = Array.from({ length: 6 }, (_, i) => `https://early.example/${i}`)
    const late = Array.from({ length: 6 }, (_, i) => `https://late.example/${i}`)
    const entry = clipNote(`Seen: ${early.join(' ')}. ${prose(900)} Not opened: ${late.join(' ')}`)
    expect(entry.see_also).toEqual([...early, ...late])
    const settled = settleLinks(entry, asIs)
    expect(settled.see_also).toEqual([...late, early[0], early[1]])
    expect(settled.see_also_omitted).toBe(4)
    expect(settled.note).toBe(entry.note)
  })

  // The limits count pages, not what the leg wrote: eight links to one page are one page, and the
  // ninth address — the datasheet behind the cut — must not lose its place to them.
  it('resolves before it limits, so several links to one page do not crowd out another page', () => {
    const aliases = Array.from({ length: 8 }, (_, i) => `https://redirect.example/token-${i}`)
    const sheet = 'https://maker.example/sheet.pdf'
    const entry = clipNote(`Listing: ${aliases.join(' ')}. ${prose(900)} Datasheet: ${sheet}`)
    const settled = settleLinks(entry, (u) =>
      u.startsWith('https://redirect.example/') ? 'https://shop.example/p' : u
    )
    expect(settled.see_also).toEqual(['https://shop.example/p', sheet])
    expect(settled.see_also_omitted).toBeUndefined()
  })

  it('keeps a long address whole, and a long link that stands for a short one', () => {
    const signed = `https://files.example/sheet.pdf?sig=${'a1'.repeat(400)}`
    const alias = `https://redirect.example/${'t0'.repeat(700)}`
    const entry = clipNote(`${prose(900)} Signed copy: ${signed} and via the search: ${alias}`)
    const settled = settleLinks(entry, (u) => (u === alias ? 'https://maker.example/sheet.pdf' : u))
    expect(settled.see_also).toEqual([signed, 'https://maker.example/sheet.pdf'])
  })

  it('leaves out an address that alone would fill the room, and says so', () => {
    const giant = `https://files.example/x?blob=${'z'.repeat(2500)}`
    const settled = settleLinks(clipNote(`See ${giant} and https://b.example/2 for it.`), asIs)
    expect(settled.see_also).toEqual(['https://b.example/2'])
    expect(settled.see_also_omitted).toBe(1)
  })

  it('takes the pointer to see_also out of a cut note when no address leads to a page', () => {
    const entry = clipNote(`${prose(900)} Only at https://redirect.example/dead`)
    expect(entry.note).toMatch(/not shown; the links it names are in see_also\]$/)
    const settled = settleLinks({ component: 'frame', ...entry }, () => null)
    expect(settled.see_also).toBeUndefined()
    expect(settled.note).toMatch(/\d+ more characters not shown\]$/)
    expect(settled.component).toBe('frame')
  })
})
