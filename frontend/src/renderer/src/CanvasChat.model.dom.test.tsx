import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CanvasChat from './CanvasChat'
import { renderWithPrism } from './test/render'
import { DEFAULT_MODEL_ID } from '../../shared/aiDefaults'

/**
 * The model picker in the composer's control row.
 *
 * It lives in its own file on purpose: the catalogue behind it is fetched once per session and kept
 * in module scope, so a test that wants a catalogue of its own has to be the first mount in its
 * module registry — which is per FILE in vitest, not per test.
 *
 * What the picker owes the user: the answering model is readable without emptying the input box (it
 * used to hang in the placeholder), it is changeable from where it is read, and the provider is NOT
 * changeable there — that decision comes with a key and a catalogue of its own and stays in Settings.
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
  { id: DEFAULT_MODEL_ID, provider: 'openrouter', label: 'Cheap', descriptor: 'the everyday one' },
  { id: 'lab/strong', provider: 'openrouter', label: 'Strong', descriptor: 'the expensive one' },
  { id: 'openai/o-direct', provider: 'openai', label: 'Direct', descriptor: 'the other provider' },
  { id: 'lab/whisper', provider: 'openrouter', label: 'Whisper', descriptor: 'speech', selectable: false }
]

const mount = (): ReturnType<typeof renderWithPrism> =>
  renderWithPrism(<CanvasChat activeDb="m" ui={ui} />, {
    routes: { 'GET /api/v1/ai/chats/m': { chats: [] } },
    overrides: { ai: { models: async () => CATALOGUE } }
  })

describe('the model picker beside the mic', () => {
  it('names the answering model in the control row, and leaves the placeholder to say what to type', async () => {
    const { container } = mount()
    // The default id resolves to its catalogue label — the row shows a name, not a slug.
    expect(await screen.findByText('Cheap')).toBeInTheDocument()
    expect(container.querySelector('.chat-bar-model')).not.toBeNull()
    expect(screen.getByPlaceholderText(/Ask or instruct the assistant/)).toHaveAttribute(
      'placeholder',
      'Ask or instruct the assistant…'
    )
  })

  it('offers the active provider’s selectable models only, and writes the pick through', async () => {
    const user = userEvent.setup()
    const { prism } = mount()
    await user.click(await screen.findByRole('button', { name: /Chat model/ }))

    expect(screen.getByRole('menuitemradio', { name: /Strong/ })).toBeInTheDocument()
    // The other provider's model would be stored but unusable with the active key; the STT model is
    // not a chat model at all. Neither is offered.
    expect(screen.queryByRole('menuitemradio', { name: /Direct/ })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: /Whisper/ })).toBeNull()

    await user.click(screen.getByRole('menuitemradio', { name: /Strong/ }))
    // Write-through, the same setting Settings → AI → Models writes: no Save button anywhere.
    expect(prism.settings.model).toBe('lab/strong')
    expect(await screen.findByText('Strong')).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'Chat model' })).toBeNull()
  })
})
