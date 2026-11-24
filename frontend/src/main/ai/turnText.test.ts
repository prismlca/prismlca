import { describe, expect, it } from 'vitest'
import { TurnText } from './turnText'

describe('the text outside the closing answer', () => {
  it('is the record before the answer and the notes after it, never a piece of the answer', () => {
    const turn = new TurnText(() => {})
    turn.add('**Which country?** — You answered: Norway')
    turn.markAnswerStart()
    turn.add('No')
    turn.markAnswerEnd()
    turn.add('\n\n_The answer was cut off at the model’s output limit._')
    expect(turn.aside).toBe(
      '**Which country?** — You answered: Norway\n\n_The answer was cut off at the model’s output limit._'
    )
  })

  it('starts over at the next answer, and is the record alone while a round is still running', () => {
    const turn = new TurnText(() => {})
    turn.add('Reading the paper.')
    turn.markAnswerEnd()
    turn.markAnswerStart()
    turn.add('27 000 kg/m².')
    expect(turn.aside).toBe('Reading the paper.')
    turn.markAnswerEnd()
    expect(turn.aside).toBe('Reading the paper.')
  })
})
