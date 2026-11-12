/**
 * Settings → AI → Models, the chat model's effort scale (V482, V486): the documented default under the
 * Default tick, and for a model with a chat floor no Default, nothing below the floor and the reason.
 */
import { describe, expect, it } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import { AiModelsPanel } from './AiModelsPanel'
import { renderWithPrism } from '../../test/render'
import { setAS } from '../../lib/appSettings'

const NOTE =
  'Luna models reliably only at high effort or above — at lower settings it can miss whole parts of a model.'
const MODELS = [
  {
    id: 'gpt-6.1-sol',
    provider: 'openai',
    label: 'GPT-6.1 Sol (OpenAI)',
    descriptor: 'default',
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium'
  },
  {
    id: 'gpt-6-luna',
    provider: 'openai',
    label: 'GPT-6 Luna (OpenAI)',
    descriptor: 'cheapest',
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'medium',
    minChatEffort: 'high',
    minChatEffortNote: NOTE
  }
]

const ticks = (): string[] =>
  Array.from(document.querySelectorAll('.effort-tick')).map((e) => e.textContent ?? '')

describe('AiModelsPanel effort scale', () => {
  it('shows Default (medium) for Sol, and High and up with the reason for Luna as the chat model', async () => {
    renderWithPrism(<AiModelsPanel />, { overrides: { ai: { models: async () => MODELS } } })
    act(() => setAS({ provider: 'openai', model: 'gpt-6.1-sol', reasoningEffort: {} }))
    await waitFor(() =>
      expect(ticks()).toEqual(['Default(medium)', 'Low', 'Medium', 'High', 'X-high', 'Max'])
    )
    expect(screen.queryByText(NOTE)).toBeNull()

    act(() => setAS({ model: 'gpt-6-luna' }))
    await waitFor(() => expect(ticks()).toEqual(['High', 'X-high', 'Max']))
    expect(screen.getByRole('slider', { name: 'Reasoning effort' })).toHaveAttribute('aria-valuetext', 'High')
    expect(screen.getByText(NOTE)).toBeInTheDocument()
    // The other roles still list Luna: the floor is the chat's alone.
    for (const role of ['Research model', 'Review model', 'Material assignment model'])
      expect(screen.getByRole('combobox', { name: role })).toHaveTextContent('GPT-6 Luna (OpenAI)')
  })
})
