import { describe, expect, it, vi } from 'vitest'
import { canvasTools } from './canvas'

/**
 * What the agent reads back from ask_user. A typed answer must arrive marked as the user's own words
 * on the question it answers — not on the whole form — so the agent acts on the sentence instead of
 * matching it to the nearest option it offered.
 */
const askUser = canvasTools.find((t) => t.spec.function.name === 'ask_user')!

async function ask(args: Record<string, unknown>, reply: unknown): Promise<any> {
  const ui = vi.fn(async () => reply)
  const out = (await askUser.run(args, { ui } as never)) as { result: string }
  return JSON.parse(out.result)
}

const FORM = {
  questions: [
    { question: 'Functional unit?', options: [{ label: '1 m²' }, { label: '1 l' }] },
    { question: 'End of life?', options: [{ label: 'Incineration' }, { label: 'Landfill' }] }
  ]
}

describe('ask_user result', () => {
  it('marks only the question the user typed an answer for', async () => {
    const r = await ask(FORM, { answers: [['1 m²'], ['Recycling as in the EPD']], freeText: [false, true] })
    expect(r.answers).toEqual([
      { question: 'Functional unit?', answer: ['1 m²'] },
      { question: 'End of life?', answer: ['Recycling as in the EPD'], free_text: true }
    ])
    expect(r.free_text).toBeUndefined()
  })

  it('marks a lone question answered in the user own words', async () => {
    const r = await ask(
      { question: 'Electricity mix?', options: [{ label: 'DE' }, { label: 'RER' }] },
      { answers: [['Supplier green power']], freeText: [true] }
    )
    expect(r).toEqual({ question: 'Electricity mix?', answer: ['Supplier green power'], free_text: true })
  })

  it('keeps one typed reply for the whole form marked on the whole result', async () => {
    // A sentence typed into the chat input while the card waits answers the whole form.
    const r = await ask(FORM, { answers: [['per m², burn it']], freeText: true })
    expect(r.free_text).toBe(true)
    expect(r.answers[0]).toEqual({ question: 'Functional unit?', answer: ['per m², burn it'] })
  })

  it('carries no flag for a picked option', async () => {
    const r = await ask(FORM, { answers: [['1 l'], ['Landfill']], freeText: [false, false] })
    expect(JSON.stringify(r)).not.toContain('free_text')
  })
})
