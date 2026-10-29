import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Settings, { type SettingsCategory } from './Settings'
import { renderWithPrism } from '../test/render'
import { setAS } from '../lib/appSettings'
import { DEFAULT_SETTINGS, setSettings } from '../lib/settings'
import {
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_RESEARCH_QUESTIONS,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_THROUGHPUT,
  DEFAULT_MODEL_ID,
  DEFAULT_WEB_LOOKUPS_PER_ANSWER,
  DEFAULT_WRITER_MAX_TOKENS,
  DEFAULT_ZDR_EXCEPT_ANTHROPIC,
  DEFAULT_ZDR_EXCEPT_GOOGLE,
  DEFAULT_ZDR_EXCEPT_OPENAI,
  DEFAULT_ZERO_DATA_RETENTION,
  MAX_WEB_LOOKUPS_PER_ANSWER
} from '../../../shared/aiDefaults'

/**
 * Every page of the Settings window, pinned before its panels moved into views/settings/ (October
 * 2026). Settings.dom.test.tsx holds the behaviour that has a story; this file holds the breadth: each
 * page renders its own content, each panel writes through, the footer offers the right Reset, and
 * "Reset AI settings" puts every AI setting back. The AI pages read the store instead
 * of holding copies, so a change from anywhere — Reset, a refused write, another writer — shows at once.
 */
const MODELS = [
  { id: 'anthropic/claude-sonnet-5.5', label: 'Sonnet 5 (Claude)', descriptor: 'balanced', selectable: true },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3 (Moonshot)', descriptor: 'open weight', selectable: true },
  {
    id: DEFAULT_MODEL_ID,
    provider: 'openai',
    label: 'GPT-6.1 Sol (OpenAI)',
    descriptor: 'default',
    selectable: true
  }
]
const TOOLS = [
  { name: 'search_background', label: 'Search background', hint: 'Finds datasets', group: 'Data' },
  { name: 'get_process_details', label: 'Process details', hint: '', group: 'Data' },
  { name: 'calculate', label: 'Calculate', hint: 'Runs LCIA', group: 'Results' }
]
const OVERRIDES = { ai: { models: async () => MODELS, tools: async () => TOOLS } }
const ROUTES = {
  'GET /api/v1/ai/skills': { skills: [] },
  'GET /api/v1/databases': [
    { name: 'ecoinvent-3.12-cutoff', kind: 'background' },
    { name: 'biosphere3', kind: 'biosphere' }
  ]
}

/** What each page shows that no other page does — the marker the matrix looks for. */
type Marker = ['heading' | 'combobox' | 'label' | 'text', string | RegExp]
const PAGES: { cat: SettingsCategory; rail: string; marker: Marker }[] = [
  { cat: 'display', rail: 'General', marker: ['heading', /Rounding/] },
  { cat: 'language', rail: 'Language', marker: ['heading', 'Spell checking'] },
  { cat: 'modelling', rail: 'Modelling', marker: ['heading', 'Units'] },
  { cat: 'reporting', rail: 'Reporting', marker: ['heading', 'Title page'] },
  { cat: 'transport-keys', rail: 'API provider', marker: ['heading', /Routing — openrouteservice/] },
  { cat: 'transport-adjustments', rail: 'DAF', marker: ['heading', /Distance adjustment factors/] },
  { cat: 'transport-limits', rail: 'Limits', marker: ['heading', /Daily limits/] },
  { cat: 'transport-costs', rail: 'Usage & costs', marker: ['heading', 'Distance API usage'] },
  { cat: 'ai-provider', rail: 'Provider', marker: ['label', /OpenRouter API key/i] },
  { cat: 'ai-models', rail: 'Models', marker: ['combobox', 'Chat model'] },
  { cat: 'ai-limits', rail: 'Limits', marker: ['label', /Cost limit per run/i] },
  { cat: 'ai-chat', rail: 'Chat', marker: ['heading', 'Voice input'] },
  { cat: 'ai-mcp', rail: 'MCP', marker: ['heading', 'External agents'] },
  { cat: 'ai-skills', rail: 'Skills', marker: ['heading', 'Skills'] },
  { cat: 'ai-tools', rail: 'Tools', marker: ['heading', 'Assistant tools'] },
  { cat: 'ai-costs', rail: 'Usage & costs', marker: ['heading', 'API costs'] },
  { cat: 'about', rail: 'About', marker: ['text', /^Version 0\.0\.0-test · Beta/] }
]
const find = ([kind, name]: Marker): Promise<HTMLElement> =>
  kind === 'label'
    ? screen.findByLabelText(name)
    : kind === 'text'
      ? screen.findByText(name)
      : screen.findByRole(kind, { name })
const query = ([kind, name]: Marker): HTMLElement | null =>
  kind === 'label'
    ? screen.queryByLabelText(name)
    : kind === 'text'
      ? screen.queryByText(name)
      : screen.queryByRole(kind, { name })

const footButtons = (): string[] =>
  within(document.querySelector('.sheet-foot') as HTMLElement)
    .getAllByRole('button')
    .map((b) => b.textContent ?? '')

const AI_DEFAULTS = {
  provider: 'openrouter' as const,
  model: DEFAULT_MODEL_ID,
  writerModel: '',
  researchModel: '',
  reviewModel: '',
  matchModel: '',
  maxRounds: DEFAULT_MAX_ROUNDS,
  maxCostUsd: DEFAULT_MAX_COST_USD,
  maxTokens: DEFAULT_MAX_TOKENS,
  writerMaxTokens: DEFAULT_WRITER_MAX_TOKENS,
  disabledTools: [],
  zeroDataRetention: DEFAULT_ZERO_DATA_RETENTION,
  focusTools: false,
  voiceEnabled: true,
  voiceLanguage: '',
  webSearchEnabled: true,
  webLookupsPerAnswer: DEFAULT_WEB_LOOKUPS_PER_ANSWER,
  eurostatEnabled: true,
  spellcheckLanguages: ['en-US'],
  newsAutoLoad: false,
  keepAwake: true,
  maxResearchQuestions: DEFAULT_MAX_RESEARCH_QUESTIONS,
  minThroughput: DEFAULT_MIN_THROUGHPUT,
  zdrExceptAnthropic: DEFAULT_ZDR_EXCEPT_ANTHROPIC,
  zdrExceptOpenai: DEFAULT_ZDR_EXCEPT_OPENAI,
  zdrExceptGoogle: DEFAULT_ZDR_EXCEPT_GOOGLE,
  chatApproval: 'irreversible' as const,
  reasoningEffort: {}
}

// The appSettings store is a module singleton: whatever a test changed would leak into the next one.
afterEach(() => {
  setAS(AI_DEFAULTS)
  setSettings(DEFAULT_SETTINGS)
})

describe('Settings → every page', () => {
  it.each(PAGES.map((p) => [p.cat, p]))('%s renders its own content and nothing else', async (_cat, page) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWithPrism(<Settings onClose={() => {}} initialCategory={page.cat} />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    expect(await find(page.marker)).toBeInTheDocument()
    const on = document.querySelector('.settings-cat.on')
    expect(on).toHaveTextContent(page.rail)
    // Once the page's own async content is in, no other page's marker may be — a panel rendered on
    // the wrong page, or two at once, fails here.
    for (const other of PAGES)
      if (other.cat !== page.cat) expect([other.cat, query(other.marker)]).toEqual([other.cat, null])
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('walks the whole rail in one window — each click swaps the panel', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} />, { routes: ROUTES, overrides: OVERRIDES })
    await user.click(screen.getByRole('button', { name: 'Transport distances' }))
    await user.click(screen.getByRole('button', { name: 'AI' }))
    const rail = (): HTMLElement[] =>
      screen.getAllByRole('button').filter((b) => b.classList.contains('settings-cat'))
    expect(rail().map((b) => b.textContent)).toEqual(PAGES.map((p) => p.rail))
    for (const [i, page] of PAGES.entries()) {
      await user.click(rail()[i])
      expect(await find(page.marker)).toBeInTheDocument()
      expect(rail()[i]).toHaveClass('on')
    }
  })

  it('offers each page the Reset that belongs to it, and Close everywhere', async () => {
    const expected: Record<SettingsCategory, string[]> = {
      display: ['Reset', 'Close'],
      language: ['Close'],
      modelling: ['Reset', 'Close'],
      reporting: ['Close'],
      'transport-keys': ['Reset', 'Close'],
      'transport-adjustments': ['Reset', 'Close'],
      'transport-limits': ['Reset', 'Close'],
      'transport-costs': ['Reset', 'Close'],
      'ai-provider': ['Close'],
      'ai-models': ['Reset AI settings', 'Close'],
      'ai-limits': ['Reset AI settings', 'Close'],
      'ai-chat': ['Reset AI settings', 'Close'],
      'ai-mcp': ['Close'],
      'ai-skills': ['Close'],
      'ai-tools': ['Reset AI settings', 'Close'],
      'ai-costs': ['Close'],
      about: ['Close']
    }
    for (const page of PAGES) {
      const { unmount } = renderWithPrism(<Settings onClose={() => {}} initialCategory={page.cat} />, {
        routes: ROUTES,
        overrides: OVERRIDES
      })
      await find(page.marker)
      expect([page.cat, ...footButtons()]).toEqual([page.cat, ...expected[page.cat]])
      unmount()
    }
  })
})

describe('Settings → Reset AI settings puts the AI pages back to their defaults', () => {
  it('puts a changed round limit back on the Limits page', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-limits" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    const rounds = screen.getByLabelText('Max tool rounds') as HTMLInputElement
    rounds.focus()
    fireEvent.change(rounds, { target: { value: '7' } })
    expect(prism.settings.maxRounds).toBe(7)
    expect(rounds.value).toBe('7')

    // The click leaves the field, which ends the edit (NumberInput) before Reset writes the default.
    await user.click(screen.getByRole('button', { name: 'Reset AI settings' }))
    await waitFor(() => expect(prism.settings.maxRounds).toBe(DEFAULT_MAX_ROUNDS))
    // The page reads the store, so the default shows in the same field — no remount.
    expect((screen.getByLabelText('Max tool rounds') as HTMLInputElement).value).toBe(
      String(DEFAULT_MAX_ROUNDS)
    )
  })

  it('puts a changed chat model back on the Models page', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-models" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    const chat = await screen.findByRole('combobox', { name: 'Chat model' })
    await user.selectOptions(chat, 'moonshotai/kimi-k3')
    expect(prism.settings.model).toBe('moonshotai/kimi-k3')

    await user.click(screen.getByRole('button', { name: 'Reset AI settings' }))
    await waitFor(() => expect(prism.settings.model).toBe(DEFAULT_MODEL_ID))
    const now = await screen.findByRole('combobox', { name: 'Chat model' })
    expect(now).not.toHaveValue('moonshotai/kimi-k3')
  })

  it('switches voice input and web search back on on the Chat page', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-chat" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    await user.click(screen.getByRole('checkbox', { name: 'Offer voice input in the chat' }))
    await user.click(screen.getByRole('checkbox', { name: 'Offer web search in the chat' }))
    expect(prism.settings.voiceEnabled).toBe(false)
    expect(prism.settings.webSearchEnabled).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Reset AI settings' }))
    await waitFor(() => expect(prism.settings.voiceEnabled).toBe(true))
    expect(screen.getByRole('checkbox', { name: 'Offer voice input in the chat' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Offer web search in the chat' })).toBeChecked()
  })

  it('re-enables a disabled tool on the Tools page', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-tools" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    const box = await screen.findByRole('checkbox', { name: /Calculate/ })
    await user.click(box)
    expect(prism.settings.disabledTools).toEqual(['calculate'])

    await user.click(screen.getByRole('button', { name: 'Reset AI settings' }))
    await waitFor(() => expect(prism.settings.disabledTools).toEqual([]))
    expect(await screen.findByRole('checkbox', { name: /Calculate/ })).toBeChecked()
  })

  it('also resets the switches that came later — approval, ZDR exceptions, speed, research width, Eurostat, effort', async () => {
    const user = userEvent.setup()
    // The values must be in the store BEFORE the page mounts, so the bridge has to exist first.
    renderWithPrism(<div />).unmount()
    setAS({
      chatApproval: 'never',
      zdrExceptAnthropic: false,
      zdrExceptOpenai: false,
      zdrExceptGoogle: false,
      minThroughput: 55,
      maxResearchQuestions: 2,
      eurostatEnabled: false,
      reasoningEffort: { [DEFAULT_MODEL_ID]: 'high' }
    })
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-limits" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    expect(screen.getByRole('checkbox', { name: /Ask me before/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Except Google (Gemini)' })).not.toBeChecked()
    expect(screen.getByLabelText('Parallel research questions')).toHaveValue(2)

    await user.click(screen.getByRole('button', { name: 'Reset AI settings' }))
    await waitFor(() => expect(prism.settings.chatApproval).toBe('irreversible'))
    expect(prism.settings).toMatchObject({
      zdrExceptAnthropic: DEFAULT_ZDR_EXCEPT_ANTHROPIC,
      zdrExceptOpenai: DEFAULT_ZDR_EXCEPT_OPENAI,
      zdrExceptGoogle: DEFAULT_ZDR_EXCEPT_GOOGLE,
      minThroughput: DEFAULT_MIN_THROUGHPUT,
      maxResearchQuestions: DEFAULT_MAX_RESEARCH_QUESTIONS,
      eurostatEnabled: true,
      reasoningEffort: {}
    })
    // …and the page shows it.
    expect(screen.getByRole('checkbox', { name: /Ask me before/ })).toBeChecked()
    for (const name of ['Except Anthropic (Claude)', 'Except OpenAI (GPT)', 'Except Google (Gemini)'])
      expect(screen.getByRole('checkbox', { name })).toHaveProperty('checked', DEFAULT_ZDR_EXCEPT_GOOGLE)
    expect(screen.getByLabelText('Parallel research questions')).toHaveValue(DEFAULT_MAX_RESEARCH_QUESTIONS)
    expect(screen.getByLabelText(/Preferred provider speed/)).toHaveValue(DEFAULT_MIN_THROUGHPUT)
  })

  it('stores the OpenRouter default under OpenAI too, and the picker falls back to its Default row', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-models" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    setAS({ provider: 'openai' })
    const chat = await screen.findByRole('combobox', { name: 'Chat model' })
    await waitFor(() => expect(chat).toHaveTextContent('GPT-6.1 Sol'))
    await user.click(screen.getByRole('button', { name: 'Reset AI settings' }))
    await waitFor(() => expect(prism.settings.model).toBe(DEFAULT_MODEL_ID))
    expect(prism.settings.provider).toBe('openai') // the provider is not an AI setting Reset touches
    expect(await screen.findByRole('combobox', { name: 'Chat model' })).toHaveTextContent('GPT-6.1 Sol')
  })

  it('clears the pre-July browser keys so a stale copy cannot be seeded back', async () => {
    const user = userEvent.setup()
    localStorage.setItem('prism.ai.maxRounds', '3')
    localStorage.setItem('prism.ai.disabledTools', '["calculate"]')
    localStorage.setItem('prism.unrelated', 'kept')
    renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-limits" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    await user.click(screen.getByRole('button', { name: 'Reset AI settings' }))
    expect(localStorage.getItem('prism.ai.maxRounds')).toBeNull()
    expect(localStorage.getItem('prism.ai.disabledTools')).toBeNull()
    expect(localStorage.getItem('prism.unrelated')).toBe('kept')
  })
})

describe('Settings → the AI pages show the store, not a copy of it', () => {
  it('shows a change made elsewhere while the page is open — Limits, Models, Chat, Tools', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-limits" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    act(() => setAS({ maxRounds: 42, chatApproval: 'never', zdrExceptGoogle: false, minThroughput: 35 }))
    expect(screen.getByLabelText('Max tool rounds')).toHaveValue(42)
    expect(screen.getByRole('checkbox', { name: /Ask me before/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Except Google (Gemini)' })).not.toBeChecked()
    expect(screen.getByLabelText(/Preferred provider speed/)).toHaveValue(35)

    await user.click(screen.getByRole('button', { name: 'Models' }))
    const chat = await screen.findByRole('combobox', { name: 'Chat model' })
    await waitFor(() => expect(chat).toHaveTextContent('Kimi K3'))
    act(() => setAS({ model: 'moonshotai/kimi-k3' }))
    expect(chat).toHaveValue('moonshotai/kimi-k3')

    await user.click(screen.getByRole('button', { name: 'Chat' }))
    act(() => setAS({ voiceEnabled: false, webLookupsPerAnswer: 3 }))
    expect(screen.getByRole('checkbox', { name: 'Offer voice input in the chat' })).not.toBeChecked()
    expect(screen.getByLabelText('Web lookups per reply')).toHaveValue(3)

    await user.click(screen.getByRole('button', { name: 'Tools' }))
    const calc = await screen.findByRole('checkbox', { name: /Calculate/ })
    act(() => setAS({ disabledTools: ['calculate'] }))
    expect(calc).not.toBeChecked()
  })

  it('shows main’s value again after a refused write, and keeps a write still in flight', async () => {
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-limits" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    // Main handles writes in the order they arrive: the cost write is APPLIED at once, only its answer
    // waits; the rounds write is refused outright.
    const bridge = (window as unknown as { prism: { appSettings: Record<string, unknown> } }).prism
      .appSettings
    const set = bridge.set as (patch: Record<string, unknown>) => Promise<unknown>
    let release = (): void => {}
    bridge.set = (patch: Record<string, unknown>) => {
      if ('maxRounds' in patch) return Promise.reject(new Error('disk full'))
      const answer = set(patch)
      return new Promise((r) => (release = () => r(answer)))
    }
    const cost = screen.getByLabelText(/Cost limit per run/) as HTMLInputElement
    cost.focus()
    fireEvent.change(cost, { target: { value: '7.5' } })
    const rounds = screen.getByLabelText('Max tool rounds') as HTMLInputElement
    rounds.focus()
    fireEvent.change(rounds, { target: { value: '9' } })

    expect(await screen.findByText(/could not be saved: disk full/)).toBeInTheDocument()
    // While the field has focus it keeps what was typed (NumberInput); leaving it shows main's value.
    fireEvent.blur(rounds)
    await waitFor(() => expect(rounds).toHaveValue(DEFAULT_MAX_ROUNDS)) // main never took the 9
    expect(cost).toHaveValue(7.5)
    await act(async () => release())
    expect(cost).toHaveValue(7.5)
    expect(prism.settings.maxCostUsd).toBe(7.5)
    expect(prism.settings.maxRounds).toBe(DEFAULT_MAX_ROUNDS)
  })

  it('lets the lookup field stand empty while typing, fills the default on blur, and Reset wins', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-chat" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    const cap = screen.getByLabelText('Web lookups per reply') as HTMLInputElement
    fireEvent.change(cap, { target: { value: '12' } })
    expect(prism.settings.webLookupsPerAnswer).toBe(12)
    fireEvent.change(cap, { target: { value: '' } })
    expect(cap.value).toBe('') // still typing: nothing written yet
    expect(prism.settings.webLookupsPerAnswer).toBe(12)
    fireEvent.blur(cap)
    expect(cap).toHaveValue(DEFAULT_WEB_LOOKUPS_PER_ANSWER)
    // Again, now that the stored value already IS the default: the blur must still hand the field back.
    fireEvent.change(cap, { target: { value: '' } })
    fireEvent.blur(cap)
    expect(cap).toHaveValue(DEFAULT_WEB_LOOKUPS_PER_ANSWER)

    fireEvent.change(cap, { target: { value: '20' } })
    fireEvent.change(cap, { target: { value: '' } })
    await user.click(screen.getByRole('button', { name: 'Reset AI settings' }))
    await waitFor(() => expect(prism.settings.webLookupsPerAnswer).toBe(DEFAULT_WEB_LOOKUPS_PER_ANSWER))
    expect(screen.getByLabelText('Web lookups per reply')).toHaveValue(DEFAULT_WEB_LOOKUPS_PER_ANSWER)
  })
})

describe('Settings → AI pages as three components', () => {
  it('loads the catalogue on Models only, again after a round trip via Limits, and never rewrites the stored model meanwhile', async () => {
    const user = userEvent.setup()
    const pending: Array<(m: typeof MODELS) => void> = []
    const models = vi.fn(() => new Promise<typeof MODELS>((r) => pending.push(r)))
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-limits" />, {
      routes: ROUTES,
      overrides: { ai: { models, tools: async () => TOOLS } }
    })
    await user.click(screen.getByRole('button', { name: 'Provider' }))
    expect(models).not.toHaveBeenCalled() // Provider and Limits do not need the catalogue

    await user.click(screen.getByRole('button', { name: 'Models' }))
    expect(models).toHaveBeenCalledTimes(1)
    await act(async () => pending[0](MODELS))
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Chat model' }),
      'moonshotai/kimi-k3'
    )

    await user.click(screen.getByRole('button', { name: 'Limits' }))
    await user.click(screen.getByRole('button', { name: 'Models' }))
    expect(models).toHaveBeenCalledTimes(2) // a fresh page: the catalogue is asked for again
    // While it is on its way the picker has nothing to offer, but the stored choice stays as it is.
    expect(prism.settings.model).toBe('moonshotai/kimi-k3')
    await act(async () => pending[1](MODELS))
    expect(await screen.findByRole('combobox', { name: 'Chat model' })).toHaveValue('moonshotai/kimi-k3')
    expect(screen.getByRole('cell', { name: /Kimi K3/ })).toBeInTheDocument() // the table row is back
    expect(prism.settings.model).toBe('moonshotai/kimi-k3')
  })
})

describe('Settings → AI → Chat', () => {
  it('writes the spoken language, the lookup cap (clamped) and the Eurostat switch through', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-chat" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    const lang = screen.getByLabelText('Spoken language') as HTMLSelectElement
    const other = Array.from(lang.options).find((o) => o.value !== lang.value)!.value
    await user.selectOptions(lang, other)
    expect(prism.settings.voiceLanguage).toBe(other)

    const cap = screen.getByLabelText('Web lookups per reply')
    fireEvent.change(cap, { target: { value: '999' } })
    expect(prism.settings.webLookupsPerAnswer).toBe(MAX_WEB_LOOKUPS_PER_ANSWER)
    expect(cap).toHaveValue(MAX_WEB_LOOKUPS_PER_ANSWER)

    await user.click(
      screen.getByRole('checkbox', { name: 'Offer Eurostat waste statistics to the assistant' })
    )
    expect(prism.settings.eurostatEnabled).toBe(false)
  })

  it('hides the language and the lookup cap while their switch is off', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-chat" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    await user.click(screen.getByRole('checkbox', { name: 'Offer voice input in the chat' }))
    expect(screen.queryByLabelText('Spoken language')).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: 'Offer web search in the chat' }))
    expect(screen.queryByLabelText('Web lookups per reply')).toBeNull()
  })
})

describe('Settings → AI → Tools', () => {
  it('groups the catalogue and stores a switched-off tool by its technical name', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-tools" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    await screen.findByText('Search background')
    const groups = Array.from(document.querySelectorAll('.ai-tool-group-h')).map((g) => g.textContent)
    expect(groups).toEqual(['Data', 'Results'])
    expect(screen.getByText('(search_background)')).toBeInTheDocument()
    expect(screen.getByTitle('Finds datasets')).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /Process details/ }))
    await user.click(screen.getByRole('checkbox', { name: /Search background/ }))
    expect(prism.settings.disabledTools).toEqual(['get_process_details', 'search_background'])
    await user.click(screen.getByRole('checkbox', { name: /Process details/ }))
    expect(prism.settings.disabledTools).toEqual(['search_background'])
  })
})

describe('Settings → AI → Skills', () => {
  function skillRoutes(): { routes: Record<string, unknown>; skills: Record<string, unknown>[] } {
    const skills: Record<string, unknown>[] = [
      {
        id: 'b1',
        name: 'LCA basics',
        description: 'Ships with the app',
        content: '# Basics\n\nText',
        enabled: true,
        builtin: true
      },
      { id: 'u1', name: 'My rules', description: 'House style', content: 'Use **kg**', enabled: true }
    ]
    const routes = {
      ...ROUTES,
      'GET /api/v1/ai/skills': () => ({ skills: skills.map((s) => ({ ...s })) }),
      'POST /api/v1/ai/skills': (body: Record<string, unknown>) => {
        const s = { id: `n${skills.length}`, enabled: true, ...body }
        skills.push(s)
        return s
      },
      'POST /api/v1/ai/skills/:id/delete': (_b: unknown, path: string) => {
        const id = path.split('/').at(-2)
        skills.splice(
          skills.findIndex((s) => s.id === id),
          1
        )
        return {}
      },
      'POST /api/v1/ai/skills/:id': (body: Record<string, unknown>, path: string) => {
        const s = skills.find((x) => x.id === path.split('/').at(-1))!
        Object.assign(s, body)
        return s
      }
    }
    return { routes, skills }
  }

  it('lists skills, keeps a built-in one undeletable, and toggles and deletes a user skill', async () => {
    const user = userEvent.setup()
    const { routes, skills } = skillRoutes()
    renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-skills" />, {
      routes,
      overrides: OVERRIDES
    })
    expect(await screen.findByText('My rules')).toBeInTheDocument()
    expect(screen.getAllByTitle('Delete skill')).toHaveLength(1) // the built-in one has none
    expect(screen.getByText('built-in')).toBeInTheDocument()

    const toggles = screen.getAllByTitle('Offer to the assistant').map((l) => l.querySelector('input')!)
    await user.click(toggles[1])
    await waitFor(() => expect(skills[1].enabled).toBe(false))

    await user.click(screen.getByTitle('Delete skill'))
    await waitFor(() => expect(screen.queryByText('My rules')).toBeNull())
    expect(skills.map((s) => s.id)).toEqual(['b1'])
  })

  it('adds a skill from a Markdown file, naming it after the file', async () => {
    const user = userEvent.setup()
    const { routes, skills } = skillRoutes()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-skills" />, {
      routes,
      overrides: OVERRIDES
    })
    await screen.findByText('My rules')
    const add = screen.getByRole('button', { name: 'Add' })
    expect(add).toBeDisabled()
    const file = new File(['# Packaging\n\nAlways weigh it.'], 'packaging.md', { type: 'text/markdown' })
    await user.upload(document.querySelector('.ai-skill-file input') as HTMLInputElement, file)
    await waitFor(() => expect(screen.getByPlaceholderText('Name')).toHaveValue('packaging'))
    expect(screen.getByText('packaging.md')).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText('What / when to use it for?'), 'Bottles')
    await user.click(add)

    expect(await screen.findByText('Bottles')).toBeInTheDocument()
    const post = prism.calls.find((c) => c.method === 'POST' && c.path === '/api/v1/ai/skills')
    expect(post?.body).toEqual({
      name: 'packaging',
      description: 'Bottles',
      content: '# Packaging\n\nAlways weigh it.'
    })
    expect(skills).toHaveLength(3)
    expect(screen.getByPlaceholderText('Name')).toHaveValue('') // the form empties after adding
  })

  it('shows the full instructions in a viewer that Escape closes without closing Settings', async () => {
    const user = userEvent.setup()
    const { routes } = skillRoutes()
    const onClose = vi.fn()
    renderWithPrism(<Settings onClose={onClose} initialCategory="ai-skills" />, {
      routes,
      overrides: OVERRIDES
    })
    await user.click(await screen.findByText('LCA basics'))
    expect(await screen.findByRole('heading', { name: 'Basics' })).toBeInTheDocument() // rendered Markdown
    expect(document.querySelector('.skill-view')).not.toBeNull()

    await user.keyboard('{Escape}')
    expect(document.querySelector('.skill-view')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Settings → General, Language, Modelling', () => {
  it('writes rounding digits through, clamped to 1–12, and Reset restores the defaults', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="display" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    const edges = screen.getByLabelText('Numbers on the arrows (canvas)') as HTMLInputElement
    edges.focus()
    fireEvent.change(edges, { target: { value: '40' } })
    fireEvent.blur(edges) // the clamp shows once the field is left; while typing, what was typed stays
    await waitFor(() => expect(edges).toHaveValue(12))
    const params = screen.getByLabelText('Parameters') as HTMLInputElement
    params.focus()
    fireEvent.change(params, { target: { value: '2' } })
    fireEvent.blur(params)
    await waitFor(() => expect(params).toHaveValue(2))
    expect(JSON.stringify(prism.settings.display)).toContain('12')
    // Results has digits of its own; they no longer ride on Inputs / Outputs.
    const results = screen.getByLabelText('Results') as HTMLInputElement
    results.focus()
    fireEvent.change(results, { target: { value: '3' } })
    fireEvent.blur(results)
    await waitFor(() =>
      expect((prism.settings.display as { round: { results: number; io: number } }).round).toMatchObject({
        results: 3,
        io: DEFAULT_SETTINGS.round.io
      })
    )

    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(edges).toHaveValue(DEFAULT_SETTINGS.round.edges))
    expect(screen.getByLabelText('Parameters')).toHaveValue(DEFAULT_SETTINGS.round.parameters)
    expect(screen.getByLabelText('Results')).toHaveValue(DEFAULT_SETTINGS.round.results)
  })

  it('ticks a spell-check language on and off', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="language" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    const boxes = screen.getAllByRole('checkbox')
    const off = boxes.find((b) => !(b as HTMLInputElement).checked)!
    await user.click(off)
    await waitFor(() => expect((prism.settings.spellcheckLanguages as string[]).length).toBeGreaterThan(1))
    expect(off).toBeChecked()
    await user.click(off)
    await waitFor(() => expect(prism.settings.spellcheckLanguages).toEqual(['en-US']))
  })

  it('switches free-text units through, and Reset takes them back', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} initialCategory="modelling" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    const box = screen.getByRole('checkbox', { name: 'Allow free-text units' })
    expect(box).not.toBeChecked()
    await user.click(box)
    await waitFor(() => expect(box).toBeChecked())
    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(box).not.toBeChecked())
  })
})
