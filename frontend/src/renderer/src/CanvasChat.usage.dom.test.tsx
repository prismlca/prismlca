import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CanvasChat, { ToolTraceList } from './CanvasChat'
import { renderWithPrism } from './test/render'
import { DEFAULT_MODEL_ID } from '../../shared/aiDefaults'

/**
 * The usage line in the chat head and the seconds counter of a running call — the two pieces of the
 * chat's display that no other test reached before they moved into chat/ (CanvasChat phase 1, October
 * 2026). Its own file because the model catalogue is cached per module registry (see
 * CanvasChat.model.dom.test.tsx), and the context meter needs a row with a window.
 */
const ui = {
  jumpToProcess: vi.fn(),
  autoLayout: vi.fn(),
  screenshotRect: () => null,
  calculateInCanvas: vi.fn(),
  setupResults: vi.fn(),
  getCanvas: vi.fn(),
  clearCanvas: vi.fn(),
  removeFromCanvas: vi.fn(),
  refresh: vi.fn()
}
const CATALOGUE = [
  { id: DEFAULT_MODEL_ID, provider: 'openrouter', label: 'Default', descriptor: '', contextTokens: 200_000 }
]

/** Mount on a stored chat and open the panel — the head with the usage line shows only expanded. */
const mount = async (messages: Array<Record<string, unknown>>): Promise<void> => {
  const { prism } = renderWithPrism(<CanvasChat activeDb="m" ui={ui} />, {
    routes: {
      'GET /api/v1/ai/chats/m': {
        chats: [{ id: 'c1', title: 'Bottle', created: '', updated: '', message_count: messages.length }]
      },
      'GET /api/v1/ai/chats/m/c1': { id: 'c1', title: 'Bottle', messages },
      'GET /api/v1/ai/skills': { skills: [] },
      'GET /api/v1/study': { compared_with: [] },
      'GET /api/v1/databases': [],
      'GET /api/v1/databases/folders': { folders: [], of: {} }
    },
    overrides: { ai: { models: async () => CATALOGUE } }
  })
  await waitFor(() => expect(prism.calls.some((c) => c.path === '/api/v1/ai/chats/m/c1')).toBe(true))
  await userEvent.setup().click(screen.getByPlaceholderText(/Ask or instruct the assistant/))
}

describe('the usage line in the chat head', () => {
  it('adds up the turns, puts the cache hit beside In, and reads the context level off the newest turn', async () => {
    await mount([
      { role: 'user', content: 'Model a PET bottle' },
      {
        role: 'assistant',
        content: 'Done.',
        prompt_tokens: 6_000,
        cached_tokens: 2_000,
        completion_tokens: 400,
        context_tokens: 20_000
      },
      { role: 'user', content: 'And the cap?' },
      {
        role: 'assistant',
        content: 'Added.',
        prompt_tokens: 4_000,
        cached_tokens: 3_000,
        completion_tokens: 500,
        context_tokens: 30_000
      }
    ])
    const line = await screen.findByText(/^In: /)
    await waitFor(() => expect(line).toHaveTextContent('In: 10k · Cache hit: 50% · Out: 900 · Context: 15%'))
    expect(line).toHaveAttribute(
      'title',
      'Tokens over the whole chat, helpers included. In contains the cached share; Out includes reasoning. Context: 30k of 200k tokens after the last turn.'
    )
  })

  it('says nothing for a chat from before usage was recorded — "In: 0" would be a measurement', async () => {
    await mount([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi.' }
    ])
    expect(await screen.findByText('Hi.')).toBeInTheDocument()
    expect(screen.queryByText(/^In: /)).toBeNull()
  })
})

describe('a running call', () => {
  afterEach(() => vi.useRealTimers())

  it('counts its seconds, and switches to minutes after one', () => {
    vi.useFakeTimers()
    render(
      <ToolTraceList
        traces={[{ name: 'calculate', args: '{}' }]}
        labels={{ calculate: 'Calculate' }}
        running
      />
    )
    expect(screen.getByText('running…')).toBeInTheDocument()
    expect(screen.getByText('0 s')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(61_000))
    expect(screen.getByText('1:01 min')).toBeInTheDocument()
  })

  it('shows no counter once the call has an outcome', () => {
    render(
      <ToolTraceList
        traces={[{ name: 'calculate', args: '{}', status: 'ok', ms: 2400 }]}
        labels={{}}
        running
      />
    )
    expect(screen.queryByText('running…')).toBeNull()
    expect(screen.getByText('2.4 s')).toBeInTheDocument()
  })
})
