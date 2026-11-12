/**
 * Settings → AI → Provider → the OpenRouter allowlist, as the user meets it: a switch that is on, a
 * list that opens on demand, completion from the provider names shipped with the app, and Reset.
 * Asserted on what is WRITTEN — every change goes straight through, there is no Save.
 */
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { renderWithPrism } from '../../test/render'
import { setAS } from '../../lib/appSettings'
import { KEY_CHANGED_EVENT } from '../../lib/ai'
import { DEFAULT_PROVIDER_ALLOWLIST, PROVIDER_ALLOWLIST_RESET } from '../../../../shared/providerAllowlist'
import { AiProviderPanel } from './AiProviderPanel'

const PROVIDERS = [
  { slug: 'deepinfra', name: 'DeepInfra', headquarters: 'US' },
  { slug: 'google-ai-studio', name: 'Google AI Studio', headquarters: 'US' },
  { slug: 'groq', name: 'Groq', headquarters: 'US' },
  { slug: 'novita', name: 'Novita', headquarters: 'US' }
]
/** With an OpenRouter key main answers with the listing; without one, with nothing. */
const WITH_KEY = { overrides: { ai: { openrouterProviders: async () => PROVIDERS } } }

afterEach(() => act(() => setAS({ provider: 'openrouter', ...PROVIDER_ALLOWLIST_RESET })))

describe('the OpenRouter provider allowlist', () => {
  it('is on by default under OpenRouter, and the provider page no longer explains itself', () => {
    renderWithPrism(<AiProviderPanel />)
    expect(screen.getByRole('switch', { name: /Only use providers from the allowlist/ })).toBeChecked()
    expect(
      screen.getByText(new RegExp(`only to the ${DEFAULT_PROVIDER_ALLOWLIST.length} providers`))
    ).toBeInTheDocument()
    expect(screen.queryByText(/Where every model request goes/)).toBeNull()
  })

  it('sits directly under the provider cards, above the key', () => {
    renderWithPrism(<AiProviderPanel />)
    const sw = screen.getByRole('switch', { name: /allowlist/ })
    const key = screen.getByLabelText(/OpenRouter API key/i)
    expect(sw.compareDocumentPosition(key) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('is not offered for a direct provider', async () => {
    renderWithPrism(<AiProviderPanel />)
    await userEvent.click(screen.getByRole('radio', { name: /OpenAI/ }))
    expect(screen.queryByRole('switch', { name: /allowlist/ })).toBeNull()
  })

  it('switches off and on again, written through', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<AiProviderPanel />)
    await user.click(screen.getByRole('switch', { name: /allowlist/ }))
    expect(prism.settings.providerAllowlistOn).toBe(false)
    expect(screen.getByRole('switch', { name: /allowlist/ })).not.toBeChecked()
    await user.click(screen.getByRole('switch', { name: /allowlist/ }))
    expect(prism.settings.providerAllowlistOn).toBe(true)
  })

  it('keeps Reset beside Add in the editor, live only once something differs from our default', async () => {
    const user = userEvent.setup()
    renderWithPrism(<AiProviderPanel />)
    expect(screen.queryByRole('button', { name: 'Reset defaults' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Edit list' }))
    expect(screen.getByRole('button', { name: 'Reset defaults' })).toBeDisabled()
    await user.click(screen.getByRole('switch', { name: /allowlist/ }))
    expect(screen.getByRole('button', { name: 'Reset defaults' })).toBeEnabled()
  })

  it('removes a host and adds one from the completion, storing only the difference', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<AiProviderPanel />, WITH_KEY)
    await user.click(screen.getByRole('button', { name: 'Edit list' }))
    await user.click(screen.getByRole('button', { name: 'Remove Novita' }))
    expect(prism.settings.providerAllowlistRemoved).toEqual(['novita'])
    expect(screen.queryByRole('button', { name: 'Remove Novita' })).toBeNull()

    await user.type(screen.getByRole('combobox', { name: 'Add a provider' }), 'gro')
    await user.click(screen.getByRole('option', { name: /^Groq/ }))
    expect(prism.settings.providerAllowlistAdded).toEqual(['groq'])
    expect(screen.getByRole('button', { name: 'Remove Groq' })).toBeInTheDocument()
  })

  it('takes a provider name typed in full the same way as one picked from the list', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<AiProviderPanel />, WITH_KEY)
    await user.click(screen.getByRole('button', { name: 'Edit list' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Add a provider…')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Remove Google AI Studio' }))
    expect(prism.settings.providerAllowlistRemoved).toEqual(['google-ai-studio'])
    await user.type(screen.getByRole('combobox', { name: 'Add a provider' }), 'google ai studio')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(prism.settings.providerAllowlistRemoved).toEqual([])
    expect(screen.queryByText(/is not a provider slug/)).toBeNull()
  })

  it('takes a slug OpenRouter does not list, and asks to check the spelling', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<AiProviderPanel />, WITH_KEY)
    await user.click(screen.getByRole('button', { name: 'Edit list' }))
    await waitFor(() => expect(screen.getByPlaceholderText('Add a provider…')).toBeInTheDocument())
    await user.type(screen.getByRole('combobox', { name: 'Add a provider' }), 'brandnewhost')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(prism.settings.providerAllowlistAdded).toEqual(['brandnewhost'])
    expect(screen.getByText(/OpenRouter lists no provider “brandnewhost”/)).toBeInTheDocument()
  })

  it('offers no completion without an OpenRouter key, says why, and still takes a slug', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<AiProviderPanel />)
    await user.click(screen.getByRole('button', { name: 'Edit list' }))
    // Our own names for the default hosts: the list reads well without the listing.
    expect(screen.getByRole('button', { name: 'Remove Google Vertex' })).toBeInTheDocument()
    expect(
      screen.getByText(/Suggestions come from OpenRouter once an OpenRouter key is set/)
    ).toBeInTheDocument()
    await user.type(screen.getByRole('combobox', { name: 'Add a provider' }), 'gro')
    expect(screen.queryByRole('option')).toBeNull()
    await user.clear(screen.getByRole('combobox', { name: 'Add a provider' }))
    await user.type(screen.getByRole('combobox', { name: 'Add a provider' }), 'groq')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(prism.settings.providerAllowlistAdded).toEqual(['groq'])
    // Without the listing a typo cannot be told from a new host: no spelling warning is invented.
    expect(screen.queryByText(/OpenRouter lists no provider/)).toBeNull()
  })

  it('refuses what is not a slug at all', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<AiProviderPanel />)
    await user.click(screen.getByRole('button', { name: 'Edit list' }))
    await user.type(screen.getByRole('combobox', { name: 'Add a provider' }), 'no such/../host')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText(/is not a provider slug/)).toBeInTheDocument()
    expect(prism.settings.providerAllowlistAdded ?? []).toEqual([])
  })

  it('picks up a key entered while the list is open, and drops the suggestions when it is removed', async () => {
    const user = userEvent.setup()
    let keyed = false
    renderWithPrism(<AiProviderPanel />, {
      overrides: { ai: { openrouterProviders: async () => (keyed ? PROVIDERS : []) } }
    })
    await user.click(screen.getByRole('button', { name: 'Edit list' }))
    expect(
      screen.getByText(/Suggestions come from OpenRouter once an OpenRouter key is set/)
    ).toBeInTheDocument()
    keyed = true
    act(() => window.dispatchEvent(new Event(KEY_CHANGED_EVENT)))
    await waitFor(() => expect(screen.getByPlaceholderText('Add a provider…')).toBeInTheDocument())
    keyed = false
    act(() => window.dispatchEvent(new Event(KEY_CHANGED_EVENT)))
    await waitFor(() =>
      expect(
        screen.getByText(/Suggestions come from OpenRouter once an OpenRouter key is set/)
      ).toBeInTheDocument()
    )
  })

  it('warns when the list is empty while the switch is on', () => {
    renderWithPrism(<AiProviderPanel />)
    act(() => setAS({ providerAllowlistRemoved: [...DEFAULT_PROVIDER_ALLOWLIST] }))
    expect(screen.getByText(/The list is empty, so every OpenRouter request will fail/)).toBeInTheDocument()
  })

  it('resets the switch and the list in one click', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<AiProviderPanel />)
    await user.click(screen.getByRole('switch', { name: /allowlist/ }))
    await user.click(screen.getByRole('button', { name: 'Edit list' }))
    await user.click(screen.getByRole('button', { name: 'Remove Novita' }))
    await user.click(screen.getByRole('button', { name: 'Reset defaults' }))
    await waitFor(() => expect(prism.settings.providerAllowlistOn).toBe(true))
    expect(prism.settings.providerAllowlistRemoved).toEqual([])
    expect(prism.settings.providerAllowlistAdded).toEqual([])
    expect(screen.getByRole('button', { name: 'Remove Novita' })).toBeInTheDocument()
  })
})
