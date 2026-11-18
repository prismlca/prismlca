/**
 * Settings → AI → Models, the review model: the default is named rather than described, and the page says
 * so when the review goes to the model that builds the study — also when the defaults do that (under
 * OpenAI and Anthropic the review default is the chat default).
 */
import { describe, expect, it } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import { AiModelsPanel } from './AiModelsPanel'
import { renderWithPrism } from '../../test/render'
import { setAS } from '../../lib/appSettings'

const MODELS = [
  { id: 'gpt-6.1-sol', provider: 'openai', label: 'GPT-6.1 Sol (OpenAI)', descriptor: 'default' },
  { id: 'gpt-6-luna', provider: 'openai', label: 'GPT-6 Luna (OpenAI)', descriptor: 'cheapest' },
  { id: 'gemini-3.8-flash', provider: 'google', label: 'Gemini 3.8 Flash (Google)', descriptor: 'default' },
  { id: 'gemini-4-argon', provider: 'google', label: 'Gemini 4 Argon (Google)', descriptor: 'strongest' }
]

const SELF = /This is the same model that builds the study\. It will review its own work/

describe('AiModelsPanel review model', () => {
  it('names the default reviewer and says when the review goes to the chat model', async () => {
    renderWithPrism(<AiModelsPanel />, { overrides: { ai: { models: async () => MODELS } } })
    // OpenAI, nothing chosen: chat and review both default to Sol — a self-review, said on the page.
    act(() => setAS({ provider: 'openai', model: '', reviewModel: '' }))
    const review = await screen.findByRole('combobox', { name: 'Review model' })
    await waitFor(() => expect(review).toHaveDisplayValue('Default (GPT-6.1 Sol (OpenAI))'))
    expect(screen.getByText(SELF)).toBeInTheDocument()

    // Another reviewer: a second opinion, nothing to say.
    act(() => setAS({ reviewModel: 'gpt-6-luna' }))
    await waitFor(() => expect(screen.queryByText(SELF)).toBeNull())

    // The chat moved to the reviewer's model: a self-review again.
    act(() => setAS({ model: 'gpt-6-luna' }))
    await waitFor(() => expect(screen.getByText(SELF)).toBeInTheDocument())
  })

  it('stays quiet under Google, where the default reviewer is another model than the chat default', async () => {
    renderWithPrism(<AiModelsPanel />, { overrides: { ai: { models: async () => MODELS } } })
    act(() => setAS({ provider: 'google', model: '', reviewModel: '' }))
    const review = await screen.findByRole('combobox', { name: 'Review model' })
    await waitFor(() => expect(review).toHaveDisplayValue('Default (Gemini 4 Argon (Google))'))
    expect(screen.queryByText(SELF)).toBeNull()
  })
})
