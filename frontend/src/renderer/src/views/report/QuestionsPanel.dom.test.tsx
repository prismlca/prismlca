import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import QuestionsPanel from './QuestionsPanel'
import type { ReportSection } from '../../lib/report/model'

/**
 * The writers' questions: the options are the buttons, the proposal is what the chapter was written
 * with for now — said once as a line, not repeated as a longer button — and a free answer goes too.
 */
const section = { id: 'g', kind: 'goal_scope', title: '' } as unknown as ReportSection
const question = {
  id: 'q-1',
  question: 'Which distance is the baseline?',
  why: 'The scope says 300 km, the parameter 1200 km.',
  proposal: 'Confirm 300 km as the baseline and treat 1200 km as the scenario.',
  options: ['300 km', '1200 km']
}

describe('the questions panel', () => {
  it('shows nothing when there is nothing to ask', () => {
    const { container } = render(<QuestionsPanel questions={[]} onAnswer={vi.fn()} />)
    expect(container.textContent).toBe('')
  })

  it('offers the options as buttons and the proposal as a line', async () => {
    const onAnswer = vi.fn(async () => true)
    render(<QuestionsPanel questions={[{ section, question }]} onAnswer={onAnswer} />)
    expect(screen.getByText(/Suggested: Confirm 300 km/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Confirm 300 km/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '300 km' }))
    expect(onAnswer).toHaveBeenCalledWith(section, question, '300 km')
  })

  it('takes an answer in the author’s own words', () => {
    const onAnswer = vi.fn(async () => true)
    render(<QuestionsPanel questions={[{ section, question }]} onAnswer={onAnswer} />)
    fireEvent.change(screen.getByLabelText('Your own answer'), { target: { value: '650 km by rail' } })
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    expect(onAnswer).toHaveBeenCalledWith(section, question, '650 km by rail')
  })

  it('falls back to the proposal as the one button when the reader named no options', () => {
    const onAnswer = vi.fn(async () => true)
    render(
      <QuestionsPanel questions={[{ section, question: { ...question, options: [] } }]} onAnswer={onAnswer} />
    )
    fireEvent.click(screen.getByRole('button', { name: /Confirm 300 km/ }))
    expect(onAnswer).toHaveBeenCalledWith(section, expect.objectContaining({ id: 'q-1' }), question.proposal)
  })
})
