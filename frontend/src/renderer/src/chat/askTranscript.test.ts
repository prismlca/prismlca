import { describe, expect, it } from 'vitest'
import { splitAskTranscript } from './askTranscript'

/** The exact text ask_user appends to the assistant's answer (main/ai/tools/groups/canvas.ts). */
const ASKED =
  '\n\n> ❓ Which system boundary?\n> ➤ cradle-to-gate excluding use phase\n>\n' +
  '> ❓ Where is it made?\n> ➤ RER, Europe\n\n'

describe('the asked-and-answered block in an answer', () => {
  it('is cut out of the text around it, pair by pair', () => {
    expect(splitAskTranscript(`Let me ask first.${ASKED}I'm creating the processes now.`)).toEqual([
      { kind: 'text', text: 'Let me ask first.' },
      {
        kind: 'asked',
        pairs: [
          { question: 'Which system boundary?', answer: 'cradle-to-gate excluding use phase' },
          { question: 'Where is it made?', answer: 'RER, Europe' }
        ]
      },
      { kind: 'text', text: "I'm creating the processes now." }
    ])
  })

  it('stands alone when the answer opens with it, and keeps an unanswered question', () => {
    const text = '\n\n> ❓ Research the recipe?\n> ➤ (no answer)\n\n'
    expect(splitAskTranscript(text)).toEqual([
      { kind: 'asked', pairs: [{ question: 'Research the recipe?', answer: '(no answer)' }] }
    ])
  })

  it('leaves text without the pattern alone, quotes included', () => {
    const text = 'A note.\n\n> A quoted line\n> ❓ a question with no answer line\n\nEnd.'
    expect(splitAskTranscript(text)).toEqual([{ kind: 'text', text }])
    expect(splitAskTranscript('Plain answer.')).toEqual([{ kind: 'text', text: 'Plain answer.' }])
  })

  it('finds two separate exchanges in one answer', () => {
    const one = '\n\n> ❓ First?\n> ➤ yes\n\n'
    const two = '\n\n> ❓ Second?\n> ➤ no\n\n'
    const kinds = splitAskTranscript(`a${one}b${two}c`).map((s) => s.kind)
    expect(kinds).toEqual(['text', 'asked', 'text', 'asked', 'text'])
  })

  it('keeps an answer typed over several lines whole, as Markdown kept it in the quote', () => {
    const text =
      'First.\n\n> ❓ Which transport?\n> ➤ Truck\nbut leave out the last mile\n>\n> ❓ Where?\n> ➤ DE\n\nNext.'
    expect(splitAskTranscript(text)).toEqual([
      { kind: 'text', text: 'First.' },
      {
        kind: 'asked',
        pairs: [
          { question: 'Which transport?', answer: 'Truck\nbut leave out the last mile' },
          { question: 'Where?', answer: 'DE' }
        ]
      },
      { kind: 'text', text: 'Next.' }
    ])
  })

  it('leaves an example of the format in a code block, and a quote inside a paragraph, to Markdown', () => {
    const fenced = 'The tool writes:\n\n```\n\n> ❓ Question\n> ➤ Answer\n\n```\n\nThat is all.'
    expect(splitAskTranscript(fenced)).toEqual([{ kind: 'text', text: fenced }])
    const inline = 'As you said\n> ❓ Question\n> ➤ Answer'
    expect(splitAskTranscript(inline)).toEqual([{ kind: 'text', text: inline }])
  })

  it('keeps a typed answer line that begins with ">" as part of the answer', () => {
    const text = '\n\n> ❓ Recycled content?\n> ➤ Recycled content\n> 90 % required\n\nNext.'
    expect(splitAskTranscript(text)).toEqual([
      {
        kind: 'asked',
        pairs: [{ question: 'Recycled content?', answer: 'Recycled content\n> 90 % required' }]
      },
      { kind: 'text', text: 'Next.' }
    ])
  })

  it('closes a code block only with its own fence, so a shorter one inside does not end it', () => {
    const text = '````markdown\n```\n\n> ❓ Question\n> ➤ Answer\n\n```\n````\n\nAfter.'
    expect(splitAskTranscript(text)).toEqual([{ kind: 'text', text }])
    const tilde = '~~~\n```\n\n> ❓ Question\n> ➤ Answer\n\n~~~'
    expect(splitAskTranscript(tilde)).toEqual([{ kind: 'text', text: tilde }])
  })
})
