import { describe, expect, it, vi } from 'vitest'

/**
 * The reply reader writer.test.ts never reached: `parseRevision`, which turns a correction answer into
 * replacements or a whole chapter. Pinned before reportWriter.ts was cut into writer/*, so the move has
 * something to hold it.
 *
 * The client is mocked as in writer.test.ts, so importing the writer opens no connection.
 */
vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())

const { parseRevision } = await import('./reportWriter')

describe('parseRevision', () => {
  it('reads replacements out of a fence or a sentence around the JSON', () => {
    const fenced = '```json\n{"replacements": [{"old": "90 %", "new": "{{results.0.share}}"}]}\n```'
    expect(parseRevision(fenced)).toEqual({
      replacements: [{ old: '90 %', new: '{{results.0.share}}', all: false }]
    })
    const chatty = 'Here you go: {"replacements": [{"old": "a", "new": "b"}]} — that fixes it.'
    expect(parseRevision(chatty)).toEqual({ replacements: [{ old: 'a', new: 'b', all: false }] })
    // The cleanup runs first: a heading with a brace in it would otherwise start the "object".
    expect(parseRevision('## Fix for {draft}\n{"chapter": "Whole."}')).toEqual({ chapter: 'Whole.' })
  })

  it('gives up on a reply without a readable object', () => {
    expect(parseRevision('I could not fix this.')).toBeNull()
    expect(parseRevision('{"replacements": [{"old": "a", "new": }]}')).toBeNull()
    expect(parseRevision('} backwards {')).toBeNull()
    expect(parseRevision('')).toBeNull()
  })

  it('keeps only well-formed replacements, and none left is no answer', () => {
    const raw = JSON.stringify({
      replacements: [
        { old: 'a', new: 'b' },
        { old: 'c' },
        { old: 5, new: 'x' },
        { old: 'd', new: null },
        { old: 'e', new: '' }
      ]
    })
    expect(parseRevision(raw)).toEqual({
      replacements: [
        { old: 'a', new: 'b', all: false },
        { old: 'e', new: '', all: false }
      ]
    })
    expect(parseRevision('{"replacements": [{"old": 1, "new": 2}]}')).toBeNull()
    expect(parseRevision('{"replacements": []}')).toBeNull()
  })

  it('takes `all` only when it is literally true', () => {
    const raw = JSON.stringify({
      replacements: [
        { old: 'a', new: 'b', all: true },
        { old: 'c', new: 'd', all: 'true' },
        { old: 'e', new: 'f', all: 1 }
      ]
    })
    expect(parseRevision(raw)).toEqual({
      replacements: [
        { old: 'a', new: 'b', all: true },
        { old: 'c', new: 'd', all: false },
        { old: 'e', new: 'f', all: false }
      ]
    })
  })

  it('falls back to a whole chapter, but not to an empty one', () => {
    expect(parseRevision('{"chapter": "The new chapter."}')).toEqual({ chapter: 'The new chapter.' })
    // Returned as sent — only the emptiness check trims.
    expect(parseRevision('{"chapter": "  Padded.  "}')).toEqual({ chapter: '  Padded.  ' })
    expect(parseRevision('{"chapter": "   "}')).toBeNull()
    expect(parseRevision('{"chapter": 42}')).toBeNull()
    expect(parseRevision('{"something": "else"}')).toBeNull()
    // A replacements field that is not a list does not stand in the way of the chapter.
    expect(parseRevision('{"replacements": "none", "chapter": "Whole."}')).toEqual({ chapter: 'Whole.' })
  })

  it('lets a replacement list win over a chapter — even one that filtered down to nothing', () => {
    expect(parseRevision('{"replacements": [{"old": "a", "new": "b"}], "chapter": "Whole."}')).toEqual({
      replacements: [{ old: 'a', new: 'b', all: false }]
    })
    expect(parseRevision('{"replacements": [{"old": 1}], "chapter": "Whole."}')).toBeNull()
  })
})
