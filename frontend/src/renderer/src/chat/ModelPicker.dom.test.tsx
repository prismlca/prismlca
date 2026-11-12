/**
 * The composer's model picker and the reasoning effort with it (V482, V486): "Default (medium)" where the
 * vendor documents the default, and for a model with a chat floor only the levels from it up, no Default,
 * the reason beside it — plus the one-time sentence after an upgrade raised a stored level.
 */
import { describe, expect, it } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ModelPicker from './ModelPicker'
import { renderWithPrism } from '../test/render'
import { setAS } from '../lib/appSettings'

const NOTE =
  'Luna models reliably only at high effort or above — at lower settings it can miss whole parts of a model.'
const MODELS = [
  {
    id: 'openai/gpt-6.1-sol',
    label: 'GPT-6.1 Sol (OpenAI)',
    descriptor: 'default',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium'
  },
  {
    id: 'openai/gpt-6-luna',
    label: 'GPT-6 Luna (OpenAI)',
    descriptor: 'cheapest',
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    minChatEffort: 'high',
    minChatEffortNote: NOTE
  }
]
const OVERRIDES = { ai: { models: async () => MODELS } }

const button = (): HTMLElement => screen.getByRole('button', { name: /^Chat model:/ })

describe('ModelPicker effort', () => {
  it('names the documented default, and for Luna offers only High and up with the reason', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<ModelPicker />, { overrides: OVERRIDES })
    act(() => setAS({ model: 'openai/gpt-6.1-sol', reasoningEffort: {} }))
    await waitFor(() => expect(button()).toHaveTextContent('GPT-6.1 Sol (OpenAI): Default (medium)'))

    // A stored medium from before the floor: shown — and sent — as High.
    act(() => setAS({ model: 'openai/gpt-6-luna', reasoningEffort: { 'openai/gpt-6-luna': 'medium' } }))
    await waitFor(() => expect(button()).toHaveTextContent('GPT-6 Luna (OpenAI): High'))
    await user.click(button())
    expect(screen.getByText(NOTE)).toBeInTheDocument()
    // Hovering the row opens the flyout (a click on top of the hover would toggle it shut again).
    await user.hover(screen.getByRole('menuitem', { name: /Effort/ }))
    const names = Array.from(document.querySelectorAll('.effort-dial-name')).map((e) => e.textContent)
    expect(names).toEqual(['High', 'X-high', 'Max'])
    await user.click(screen.getByText('Max'))
    expect(prism.settings.reasoningEffort).toEqual({ 'openai/gpt-6-luna': 'max' })
  })

  it('says a raised level once, and clears it when acknowledged', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<ModelPicker />, { overrides: OVERRIDES })
    act(() =>
      setAS({
        model: 'openai/gpt-6-luna',
        chatEffortNotice: `GPT-6 Luna (OpenAI) now chats at High. ${NOTE}`
      })
    )
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('now chats at High')
    await user.click(screen.getByRole('button', { name: 'OK' }))
    expect(prism.settings.chatEffortNotice).toBe('')
    expect(screen.queryByRole('status')).toBeNull()
  })
})
