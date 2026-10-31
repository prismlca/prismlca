import { describe, expect, it } from 'vitest'
import { anchorOf, flaggedSentences, sentenceAround, withinFlagged } from './sentences'

const lit = (n: string) => ({ kind: 'literal_number', names: [n], detail: `The number ${n} is written out.` })

describe('the sentence a finding stands in', () => {
  it('reads the anchor from the finding: a typed figure, or the path a finding names', () => {
    expect(anchorOf(lit('42'))).toEqual({ number: '42' })
    expect(anchorOf({ kind: 'literal_number', detail: 'The figure 5 % is written out.' })).toEqual({
      number: '5'
    })
    expect(anchorOf({ kind: 'duplicated_unit', detail: 'x', path: 'sum(a, b)' } as never)).toEqual({
      token: 'sum(a, b)'
    })
    expect(anchorOf({ kind: 'value_judgement', detail: 'x' })).toBeNull()
  })

  it('does not end a sentence inside a placeholder, a decimal or an abbreviation', () => {
    const text =
      'Erst kommt die Nutzung. Sie trägt {{results.0.score}} kg, d. h. rund 4.2 Mal z. B. mehr als 42 Gramm. Danach der Rest.'
    const at = text.indexOf('42 Gramm')
    const { start, end } = sentenceAround(text, at)
    expect(text.slice(start, end)).toBe(
      'Sie trägt {{results.0.score}} kg, d. h. rund 4.2 Mal z. B. mehr als 42 Gramm.'
    )
  })

  it('finds a typed figure on its own, not inside a longer number or a placeholder path', () => {
    const text =
      'Die Flasche wiegt 1042 g. Bei {{parameters.42.amount}} kg sind es 42 Stück.\nNeuer Absatz mit 42.'
    const { sentences, unplaced } = flaggedSentences(text, [lit('42')])
    expect(unplaced).toEqual([])
    expect(sentences.map((s) => s.sentence)).toEqual([
      'Bei {{parameters.42.amount}} kg sind es 42 Stück.',
      'Neuer Absatz mit 42.'
    ])
  })

  it('reports a finding it cannot place, and accepts only replacements inside the flagged sentences', () => {
    const { sentences, unplaced } = flaggedSentences('Nothing typed here.', [lit('42')])
    expect(sentences).toEqual([])
    expect(unplaced).toHaveLength(1)
    const flagged = [{ sentence: 'Use matters 42 times more.', details: [] }]
    expect(withinFlagged([{ old: 'matters 42 times' }], flagged)).toBe(true)
    expect(withinFlagged([{ old: 'Transport carries' }], flagged)).toBe(false)
  })
})
