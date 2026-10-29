import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { FlowRow } from './ActivityEditor'

/**
 * The comment bubble of an inspector flow row, pressed the way a pointer presses it.
 *
 * The bubble opened its field but could not close it: the press moved the focus to the bubble, the
 * field's blur closed the field, and the click that followed opened it again. Only a real press shows
 * that order — mousedown, blur, click — so these tests go through user-event rather than a bare click.
 */
const flow = (comment: string | null) => ({
  uid: 'x1',
  input: { database: 'fg', code: 'c1', name: 'heat, district', unit: 'megajoule', location: 'CH' },
  amount: 3,
  type: 'technosphere',
  direction: 'input' as const,
  formula: null,
  comment
})

function mount(comment: string | null, readOnly: boolean) {
  const onComment = vi.fn()
  const { container } = render(
    <FlowRow
      flow={flow(comment)}
      readOnly={readOnly}
      reference={false}
      noteColumn={readOnly}
      onAmount={vi.fn()}
      onFormula={vi.fn()}
      onComment={onComment}
      onRemove={vi.fn()}
    />
  )
  const bubble = (): HTMLButtonElement => container.querySelector('.flow-note-btn') as HTMLButtonElement
  return { container, bubble, onComment }
}

describe('the comment bubble on an editable flow', () => {
  it('closes the field on a second press and writes what was typed, once', async () => {
    const user = userEvent.setup()
    const { container, bubble, onComment } = mount(null, false)
    await user.click(bubble())
    expect(container.querySelector('textarea.note')).not.toBeNull()
    await user.type(container.querySelector('textarea.note') as HTMLTextAreaElement, 'Proxy: no CH dataset')
    await user.click(bubble())
    expect(container.querySelector('textarea.note')).toBeNull()
    expect(onComment).toHaveBeenCalledTimes(1)
    expect(onComment).toHaveBeenCalledWith('x1', 'Proxy: no CH dataset')
  })

  it('closes on a second press without writing when nothing changed', async () => {
    const user = userEvent.setup()
    const { container, bubble, onComment } = mount('Measured on site', false)
    await user.click(bubble())
    await user.click(bubble())
    expect(container.querySelector('textarea.note')).toBeNull()
    expect(onComment).not.toHaveBeenCalled()
  })

  it('writes nothing when the edit is abandoned with Escape', async () => {
    const user = userEvent.setup()
    const { container, bubble, onComment } = mount('Measured on site', false)
    await user.click(bubble())
    await user.type(container.querySelector('textarea.note') as HTMLTextAreaElement, ' — or not')
    await user.keyboard('{Escape}')
    expect(container.querySelector('textarea.note')).toBeNull()
    expect(onComment).not.toHaveBeenCalled()
  })
})

describe('the comment bubble on a read-only flow', () => {
  it('shows the source comment as text and hides it again', async () => {
    const user = userEvent.setup()
    const { container, bubble } = mount('Calculated value based on the producer survey.', true)
    await user.click(bubble())
    expect(container.querySelector('.flow-note-text')?.textContent).toBe(
      'Calculated value based on the producer survey.'
    )
    expect(container.querySelector('textarea')).toBeNull()
    await user.click(bubble())
    expect(container.querySelector('.flow-note-text')).toBeNull()
  })
})
