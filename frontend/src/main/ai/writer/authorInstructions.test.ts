import { describe, expect, it } from 'vitest'
import { writerUser } from './messages'
import { answerPrompt } from './dialogue'
import type { WriteBrief } from '../reportWriter'

const ASKED = 'Write for a product manager: three short paragraphs in plain language.'

const brief = (extra: string): WriteBrief =>
  ({
    kind: 'conclusions',
    title: 'Conclusions',
    language: 'English',
    prompt: `Write the conclusions of the study.${extra ? `\n\nAdditional instructions from the author:\n${extra}` : ''}`,
    author_instructions: extra,
    placeholders: ['results.0.score'],
    facts: { results: [{ score: 1 }] }
  }) as unknown as WriteBrief

/**
 * The author's additions travelled inside the assignment, ahead of the placeholders, the other chapters
 * and the facts — and "three short paragraphs for a product manager" came back as four long ones and a
 * numbered list. They are repeated after all of that now, and the reader's corrections are held to them.
 */
describe("the author's own instructions", () => {
  it('come last in the assignment, after the facts, with their precedence said', () => {
    const text = writerUser(brief(ASKED))
    const repeated = text.lastIndexOf(ASKED)
    expect(repeated).toBeGreaterThan(text.indexOf('Facts and numbers (JSON):'))
    expect(text).toMatch(/last word on audience, length, form and emphasis/)
    expect(text).toMatch(/change nothing in the rules of your system message/)
  })

  it('are not invented where the author gave none', () => {
    expect(writerUser(brief(''))).not.toMatch(/last word on audience/)
  })

  it('hold a correction to them', () => {
    const point = { n: 1, quote: 'q', problem: 'p', status: 'open' } as never
    expect(answerPrompt([point], ASKED)).toContain(ASKED)
    expect(answerPrompt([point])).not.toMatch(/author's instructions/)
  })
})
