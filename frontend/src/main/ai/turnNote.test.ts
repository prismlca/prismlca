import { describe, expect, it } from 'vitest'
import { noteEcho, turnNote } from './turnNote'

/** Streams `text` through one guard in pieces of `size` characters and returns what it let through. */
function stream(text: string, size: number): { shown: string; dropped: number } {
  const echo = noteEcho()
  let shown = ''
  for (let i = 0; i < text.length; i += size) shown += echo.pass(text.slice(i, i + size))
  shown += echo.end()
  return { shown, dropped: echo.dropped }
}

/** Every piece size from one character up to the whole text: the outcome must not depend on it. */
function everySplit(text: string): Array<{ shown: string; dropped: number }> {
  return Array.from({ length: text.length }, (_, i) => stream(text, i + 1))
}

describe('turnNote', () => {
  it('names the study language and the day, and asks a new chat for its title', () => {
    expect(turnNote('de', false, '2026-11-18')).toBe('[Study language: German]\n[Today: 2026-11-18]')
    expect(turnNote(undefined, false, '2026-11-18')).toBe(
      '[No study language recorded yet]\n[Today: 2026-11-18]'
    )
    expect(turnNote('xx', true, '2026-11-18')).toMatch(
      /^\[Study language: xx\]\n\[Today: 2026-11-18\]\nThis is a NEW chat: .*set_chat_title/
    )
  })
})

describe('noteEcho', () => {
  it('drops a copied note at the head of the reply, however the stream is cut', () => {
    // As GPT-6 Luna wrote it: the language line, a blank line, then the answer.
    for (const r of everySplit('[Study language: English]\n\nThe three largest inputs are:\n\n1. LAS'))
      expect(r).toEqual({ shown: 'The three largest inputs are:\n\n1. LAS', dropped: 1 })
  })

  it('drops every line of a copied note, the date and the no-language form included', () => {
    for (const r of everySplit('\n[No study language recorded yet]\n[Today: 2026-11-18]\n\n## Result\nDone.'))
      expect(r).toEqual({ shown: '## Result\nDone.', dropped: 2 })
  })

  it('drops a note the model updated itself, which the app never wrote in that form', () => {
    // The turn said no language was recorded; the model recorded English and announced it as a note.
    expect(stream('[Study language: English]\n\nThe latest Eurostat data are for 2024.', 3).shown).toBe(
      'The latest Eurostat data are for 2024.'
    )
  })

  it('drops a reply that is nothing but the note', () => {
    for (const r of everySplit('[Study language: German]')) expect(r).toEqual({ shown: '', dropped: 1 })
  })

  it('lets a reply that opens with a bracket of its own pass unchanged', () => {
    for (const text of [
      '[1] ecoinvent 3.12, cut-off.',
      "[Today's figure](https://example.org) is lower.",
      '[Study language: English] is what the metadata says.',
      '[Stu',
      '\n\nThe answer, with its leading blank lines.'
    ])
      for (const r of everySplit(text)) expect(r).toEqual({ shown: text, dropped: 0 })
  })

  it('guards only the opening: a note quoted further down stays', () => {
    const text = 'The turn note read:\n[Study language: German]\nso the answer is German.'
    for (const r of everySplit(text)) expect(r).toEqual({ shown: text, dropped: 0 })
  })

  it('drops no more lines than the note has, so a model stuck on the line still meets the repetition cut-off', () => {
    const line = '[Study language: English]\n'
    for (const r of [stream(line.repeat(30), 7), stream(line.repeat(30), line.length * 30)])
      expect(r).toEqual({ shown: line.repeat(28), dropped: 2 })
    // After two dropped lines the reply starts at its first character, even when that is a third copy.
    for (const r of everySplit(`${line}${line}\n\n${line}`)) expect(r).toEqual({ shown: line, dropped: 2 })
  })

  it('gives up holding back once a line is longer than any note', () => {
    const echo = noteEcho()
    expect(echo.pass('[Study language: ')).toBe('')
    const long = 'x'.repeat(60)
    expect(echo.pass(long)).toBe(`[Study language: ${long}`)
    expect(echo.pass('\nrest')).toBe('\nrest')
  })
})
