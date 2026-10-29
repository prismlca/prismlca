import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Settings from './Settings'
import ParamRuleEditor from '../components/ParamRule'
import { renderWithPrism } from '../test/render'

/**
 * Escape abandons the edit — in the two other fields that commit on blur.
 *
 * All three had the same defect (found 24.08.2026 while building the model rename): the Escape handler
 * puts the old value back and blurs the field, the browser fires focusout synchronously, and the commit
 * running on it still sees the abandoned text. The parameter table wrote the number
 * (`views/paramEdit.dom.test.tsx`); here it was a **provider key** and a validation rule, which is why
 * these two are worth their own test rather than a note in a comment.
 */
describe('Escape in the provider-key field', () => {
  it('does not store the key it just cleared', async () => {
    const user = userEvent.setup()
    const setKey = vi.fn(async () => ({ ok: true }))
    renderWithPrism(<Settings onClose={() => {}} />, {
      routes: { 'GET /api/v1/ai/skills': { skills: [] } },
      overrides: { ai: { setKey } }
    })

    await user.click(screen.getByRole('button', { name: 'AI' })) // the group starts folded
    await user.click(screen.getByRole('button', { name: 'Provider' }))
    const field = await screen.findByLabelText(/OpenRouter API key/i)
    await user.type(field, 'sk-or-v1-secret{Escape}')

    expect(setKey).not.toHaveBeenCalled()
    expect((field as HTMLInputElement).value).toBe('')
  })
})

describe('Escape in the rule-values field', () => {
  it('does not write the list it just abandoned', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithPrism(<ParamRuleEditor rule={{ kind: 'list', values: [1, 2] }} onChange={onChange} />)

    const field = await screen.findByPlaceholderText('0.25; 0.5; 0.75')
    await user.clear(field)
    await user.type(field, '7; 8; 9{Escape}')

    expect(onChange).not.toHaveBeenCalled()
  })

  it('writes the list on Enter', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithPrism(<ParamRuleEditor rule={{ kind: 'list', values: [1, 2] }} onChange={onChange} />)

    const field = await screen.findByPlaceholderText('0.25; 0.5; 0.75')
    await user.clear(field)
    await user.type(field, '7; 8{Enter}')

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ kind: 'list', values: [7, 8] }))
  })
})
