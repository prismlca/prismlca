import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Settings from './Settings'
import { renderWithPrism } from '../test/render'
import { setAS } from '../lib/appSettings'

/**
 * The first mounted-component test in the project — it exists to prove the harness as much as the
 * feature, so it deliberately asserts on what the user sees and on what was WRITTEN, not on markup.
 *
 * The rule under test is a house rule with real consequences: there are no Save buttons anywhere in
 * PrismLCA, every option applies the moment it changes. A regression there loses a setting silently,
 * which is the failure mode nobody notices until the next run costs money.
 */
const ROUTES = {
  'GET /api/v1/ai/skills': { skills: [] },
  'GET /api/v1/databases': [
    { name: 'ecoinvent-3.12-cutoff', kind: 'background' },
    { name: 'bafu-2026-v1', kind: 'background' },
    { name: 'biosphere3', kind: 'biosphere' },
    { name: 'My processes', kind: 'library' }
  ]
}

/** Enough of the catalogue to pick from. The real shape comes from main/ai/models.ts + live pricing. */
const MODELS = [
  {
    id: 'anthropic/claude-sonnet-5.5',
    label: 'Sonnet 5 (Claude)',
    descriptor: 'balanced (default)',
    selectable: true
  },
  {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3 (Moonshot)',
    descriptor: 'strongest open weight',
    selectable: true
  },
  {
    id: 'gpt-6.1-sol',
    provider: 'openai',
    label: 'GPT-6.1 Sol (OpenAI)',
    descriptor: 'balanced (default)',
    selectable: true,
    pricing: { input: 2, cachedInput: 0.2, output: 12 },
    pricingSource: 'list'
  }
]
const OVERRIDES = { ai: { models: async () => MODELS } }

describe('Settings → AI', () => {
  // The appSettings store is a module singleton — a provider left on 'openai' would leak into the
  // next test's default expectations.
  afterEach(() => setAS({ provider: 'openrouter' }))

  it('writes a model change straight through, with no Save button anywhere', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })

    await user.click(screen.getByRole('button', { name: 'AI' })) // the group starts folded
    await user.click(screen.getByRole('button', { name: 'Models' }))
    const select = await screen.findByRole('combobox', { name: 'Chat model' })
    await user.selectOptions(select, 'moonshotai/kimi-k3')

    expect(prism.settings.model).toBe('moonshotai/kimi-k3')
    expect(screen.queryByRole('button', { name: /^Save/i })).toBeNull()
  })

  it('opens on the page it was asked for — the chat links straight into Skills', async () => {
    renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-skills" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    expect(await screen.findByRole('heading', { name: 'Skills' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skills' })).toHaveClass('on')
  })

  it('lands in the add-a-skill form when asked to — that form is below the list, off-screen', async () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-skills" focus="add-skill" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    const name = await screen.findByPlaceholderText('Name')
    await waitFor(() => expect(name).toHaveFocus())
    expect(scrolled).toHaveBeenCalled()
  })

  it('separates who answers, which models work, and how far a run may go — three pages', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} />, { routes: ROUTES, overrides: OVERRIDES })

    // Provider carries the provider choice and its key…
    await user.click(screen.getByRole('button', { name: 'AI' })) // the group starts folded
    await user.click(screen.getByRole('button', { name: 'Provider' }))
    expect(screen.getByLabelText(/OpenRouter API key/i)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Chat model' })).toBeNull()

    // …Models carries the model choices…
    await user.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByRole('combobox', { name: 'Chat model' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/OpenRouter API key/i)).toBeNull()
    expect(screen.queryByLabelText(/Cost limit per run/i)).toBeNull()

    // …and Limits carries how far a run may go.
    await user.click(screen.getByRole('button', { name: 'Limits' }))
    expect(screen.getByLabelText(/Cost limit per run/i)).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Chat model' })).toBeNull()
  })

  it('switches the provider write-through, re-binds the key block, and filters the pickers', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })

    // OpenRouter is the default: its key field on the Provider page, only its models under Models.
    await user.click(screen.getByRole('button', { name: 'AI' })) // the group starts folded
    await user.click(screen.getByRole('button', { name: 'Models' }))
    const chat = await screen.findByRole('combobox', { name: 'Chat model' })
    expect(chat).toHaveTextContent('Sonnet 5')
    expect(chat).not.toHaveTextContent('GPT-5.6')

    await user.click(screen.getByRole('button', { name: 'Provider' }))
    expect(await screen.findByLabelText(/OpenRouter API key/i)).toBeInTheDocument()
    // The provider choice is two cards now, not a dropdown — click the OpenAI tile.
    expect(screen.getByRole('radio', { name: /OpenRouter/ })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: /OpenAI/ }))
    // Write-through — no Save button — and the key block re-binds to the other provider.
    expect(prism.settings.provider).toBe('openai')
    expect(await screen.findByLabelText(/OpenAI API key/i)).toBeInTheDocument()

    // The Models page follows: only OpenAI models are offered…
    await user.click(screen.getByRole('button', { name: 'Models' }))
    const chatNow = await screen.findByRole('combobox', { name: 'Chat model' })
    expect(chatNow).toHaveTextContent('GPT-6.1 Sol')
    expect(chatNow).not.toHaveTextContent('Sonnet 5')
    // …and the stored Sonnet-5 choice is NOT rewritten — the setting survives, and the picker falls
    // back to the row that names the model actually in force. The paragraph that used to spell this
    // out under every one of the six pickers is gone: the row says it already.
    expect(prism.settings.model).toBe('anthropic/claude-sonnet-5.5')
    expect(chatNow).toHaveTextContent(/Default \(GPT-6\.1 Sol/)
    expect((chatNow as HTMLSelectElement).value).toBe('')
    expect(screen.queryByText(/belongs to the other provider/i)).toBeNull()
  })

  it('splits the cost table by provider with tabs that touch only the table', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} />, {
      routes: ROUTES,
      overrides: {
        ai: {
          models: async () => MODELS,
          usage: async () => ({
            '2026-08': {
              'anthropic/claude-sonnet-5.5': { cost: 1.5, prompt: 10, cached: 0, calls: 2 },
              'gpt-6-luna': { cost: 0.2, prompt: 5, cached: 0, calls: 1 }
            }
          })
        }
      }
    })

    await user.click(screen.getByRole('button', { name: 'AI' })) // the group starts folded
    await user.click(screen.getByRole('button', { name: 'Usage & costs' }))
    // Tabs default to the active provider (OpenRouter here) and show only its rows…
    expect(await screen.findByText('Sonnet 5 (Claude)')).toBeInTheDocument()
    expect(screen.queryByText(/gpt-6-luna/i)).toBeNull()
    // …while the tiles above stay whole-app totals ($1.70 across both providers — the month tile
    // and the all-time tile agree, hence two matches).
    expect(screen.getAllByText('$1.70').length).toBeGreaterThanOrEqual(2)

    await user.click(screen.getByRole('button', { name: 'OpenAI' }))
    expect(await screen.findByText('gpt-6-luna')).toBeInTheDocument()
    expect(screen.queryByText('Sonnet 5 (Claude)')).toBeNull()
    expect(screen.getAllByText('$1.70').length).toBeGreaterThanOrEqual(2)
  })

  it('shows what an import cost, beside the other categories', async () => {
    // The tiles are generated from whatever categories the ledger holds, so a new one appears by
    // itself — this pins that, because "it is tracked" is worth nothing if nobody can see it.
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} />, {
      routes: ROUTES,
      overrides: {
        ai: {
          models: async () => MODELS,
          usage: async () => ({
            '2026-09': {
              'anthropic/claude-sonnet-5.5': {
                cost: 1.0,
                prompt: 100,
                cached: 0,
                calls: 3,
                categories: {
                  modelling: { cost: 0.6, prompt: 60, cached: 0, calls: 2 },
                  import: { cost: 0.4, prompt: 40, cached: 0, calls: 1 }
                }
              }
            }
          })
        }
      }
    })

    await user.click(screen.getByRole('button', { name: 'AI' })) // the group starts folded
    await user.click(screen.getByRole('button', { name: 'Usage & costs' }))
    expect(await screen.findByText('import')).toBeInTheDocument()
    expect(screen.getByText('modelling')).toBeInTheDocument()
    // The tile carries the money, not just the word.
    const tile = screen.getByText('import').closest('.cost-stat')
    expect(tile?.textContent).toMatch(/0\.4/)
  })

  it('renders the OpenRouter routing knobs inert under OpenAI, without losing their values', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    setAS({ provider: 'openai' })

    await user.click(screen.getByRole('button', { name: 'AI' })) // the group starts folded
    await user.click(screen.getByRole('button', { name: 'Limits' }))
    const zdrBox = screen.getByLabelText(/zero data retention/i)
    expect(zdrBox).toBeDisabled()
    expect(screen.getByLabelText(/Preferred provider speed/i)).toBeDisabled()
    // The honest sentence, not a silent no-op: the switch has no effect on the OpenAI API.
    expect(screen.getByText(/no per-request equivalent/i)).toBeInTheDocument()
    // The stored decision itself is untouched — it applies again on switch-back.
    expect(prism.settings.zeroDataRetention).toBe(true)
  })

  it('clamps a reply budget the way main would, rather than trusting the field', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })

    await user.click(screen.getByRole('button', { name: 'AI' })) // the group starts folded
    await user.click(screen.getByRole('button', { name: 'Limits' }))
    const tokens = screen.getByLabelText(/Max tokens per reply/i)
    await user.clear(tokens)
    await user.type(tokens, '999999')
    await user.tab()

    // 250k is the documented ceiling in shared/aiDefaults.ts — the fixture applies the same clamp
    // main does, so this asserts the contract rather than a copy of it.
    expect(prism.settings.maxTokens).toBe(250_000)
  })
  it('says where each provider’s prices come from, and dates the hand-kept ones', async () => {
    // The two columns look identical and are not: OpenRouter's are whatever OpenRouter charges
    // today, OpenAI's are typed in by us because OpenAI publishes no pricing API and returns no cost
    // with a response. A number whose origin is invisible reads as equally firm either way, so the
    // header carries an asterisk and the note under the table answers it.
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} />, { routes: ROUTES, overrides: OVERRIDES })

    await user.click(screen.getByRole('button', { name: 'AI' })) // the group starts folded
    await user.click(screen.getByRole('button', { name: 'Models' }))
    expect(screen.getByText(/Live from OpenRouter's API/i)).toBeInTheDocument()
    expect(screen.queryByText(/Kept by hand/i)).toBeNull()

    setAS({ provider: 'openai' })
    await user.click(screen.getByRole('button', { name: 'Provider' }))
    await user.click(screen.getByRole('button', { name: 'Models' }))
    // English, whatever the machine's locale is: the sentence around it is English like every other
    // string in this product, and the machine's locale wrote "30. August 2026" into the middle of it.
    expect(screen.getByText(/Kept by hand — OpenAI has no pricing API/i)).toBeInTheDocument()
    // The date sits in its own <b>, so it is matched on its own.
    expect(screen.getByText(/^\d{1,2} [A-Z][a-z]+ \d{4}$/)).toBeInTheDocument()
    expect(screen.queryByText(/Live from OpenRouter/i)).toBeNull()
  })
})

describe('Settings → Modelling', () => {
  afterEach(() => setAS({ preferredBackground: '' }))

  it('offers the installed backgrounds as the preferred one and writes the choice through', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    await user.click(screen.getByRole('button', { name: 'Modelling' }))
    const select = await screen.findByRole('combobox', { name: /Preferred background database/i })
    // Only backgrounds — neither the biosphere nor the user's own library is a background to prefer.
    await screen.findByRole('option', { name: 'Prefer bafu-2026-v1' })
    expect(screen.getByRole('option', { name: 'Prefer ecoinvent-3.12-cutoff' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /biosphere3|My processes/ })).toBeNull()
    await user.selectOptions(select, 'bafu-2026-v1')
    await waitFor(() => expect(prism.settings.preferredBackground).toBe('bafu-2026-v1'))
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
  })
})

describe('a model the user added themselves', () => {
  /**
   * Two promises to a person editing `models.json` by hand: the row says where it came from, and
   * a refused entry says so instead of vanishing. The ratings stay empty by decision —
   * OpenRouter does publish Artificial Analysis figures per model, but they are its own join and
   * were wrong for one of the twelve models in our catalogue when measured.
   */
  const OWN = [
    ...MODELS,
    {
      id: 'vendor/mine',
      // Deliberately NOT "added by you": with that as the descriptor, the suffix assertion below
      // passed even when the suffix was removed.
      label: 'My Model',
      descriptor: 'fast and cheap',
      selectable: true,
      userAdded: true as const,
      intelligence: null,
      agentic: null
    }
  ]

  const open = async (overrides: Record<string, unknown>): Promise<void> => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} />, { routes: ROUTES, overrides })
    await user.click(screen.getByRole('button', { name: 'AI' }))
    await user.click(screen.getByRole('button', { name: 'Models' }))
  }

  it('marks the row, explains the mark, and leaves both ratings empty', async () => {
    await open({ ai: { models: async () => OWN } })

    const mark = await screen.findByLabelText('Added by you')
    expect(mark.closest('tr')?.textContent).toMatch(/My Model/)
    // A native title rather than a hover panel: the table scrolls, and a panel opening downward
    // from the last row would be clipped by .ai-table-wrap.
    expect(mark.getAttribute('title')).toMatch(/Not checked or rated by PrismLCA/)
    // Every other row carries no such mark.
    expect(screen.getAllByLabelText('Added by you')).toHaveLength(1)

    // The rating cells of that row: two dashes, no borrowed numbers.
    const cells = [...(mark.closest('tr')?.querySelectorAll('td.num') ?? [])].map((c) => c.textContent)
    expect(cells.slice(-2)).toEqual(['–', '–'])
  })

  it('carries the provenance in the option text, which is all a closed select shows', async () => {
    await open({ ai: { models: async () => OWN } })
    const select = await screen.findByRole('combobox', { name: 'Chat model' })
    const own = [...select.querySelectorAll('option')].find((o) => o.value === 'vendor/mine')
    expect(own?.textContent).toMatch(/added by you/)
    const builtin = [...select.querySelectorAll('option')].find((o) => o.value === 'moonshotai/kimi-k3')
    expect(builtin?.textContent).not.toMatch(/added by you/)
  })

  it('says when an entry was refused instead of letting it vanish', async () => {
    await open({
      ai: {
        models: async () => MODELS,
        modelIssues: async () => [
          'models.json: "bad id" is not a valid OpenRouter id (vendor/model) — skipped.'
        ]
      }
    })
    expect(await screen.findByText(/1 entry was\s+not loaded/)).toBeInTheDocument()
    expect(screen.getByText(/is not a valid OpenRouter id/)).toBeInTheDocument()
  })
})

describe('the consequence of adding a model yourself', () => {
  /**
   * The mark says where a row came from; this note says what that means. The point it has to
   * carry: PrismLCA's zero-data-retention switch sends `data_collection: 'deny'`, which is a request
   * about training and not a promise that a provider keeps nothing.
   */
  const withOwn = (id: string): Record<string, unknown> => ({
    ai: {
      models: async () => [
        ...MODELS,
        { id, label: 'My Model', descriptor: 'fast', selectable: true, userAdded: true as const }
      ]
    }
  })

  const openModels = async (overrides: Record<string, unknown>): Promise<void> => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} />, { routes: ROUTES, overrides })
    await user.click(screen.getByRole('button', { name: 'AI' }))
    await user.click(screen.getByRole('button', { name: 'Models' }))
  }

  it('says PrismLCA has not checked it, and what governs it instead', async () => {
    await openModels(withOwn('vendor/mine'))
    expect(await screen.findByText(/PrismLCA has not checked/)).toBeInTheDocument()
    // Not a warning about licensed data: the privacy rule is what actually
    // decides where a prompt may go, and with it on that covers training AND retention.
    expect(screen.getByText(/do not collect your data/)).toBeInTheDocument()
    expect(screen.getByText(/only to endpoints that keep nothing/)).toBeInTheDocument()
    expect(screen.queryByText(/licensed/i)).toBeNull()
  })

  it('changes its answer when the privacy rule is switched off', async () => {
    // setAS needs the prism bridge, which renderWithPrism installs — so a throwaway render first.
    renderWithPrism(<Settings onClose={() => {}} />, {
      routes: ROUTES,
      overrides: withOwn('vendor/mine')
    }).unmount()
    setAS({ zeroDataRetention: false })
    await openModels(withOwn('vendor/mine'))
    expect(await screen.findByText(/nothing restricts which provider serves them/)).toBeInTheDocument()
    setAS({ zeroDataRetention: true })
  })

  it('stays quiet when every model is one of PrismLCA own', async () => {
    await openModels({ ai: { models: async () => MODELS } })
    await screen.findByRole('combobox', { name: 'Chat model' })
    expect(screen.queryByText(/PrismLCA does not check them/)).toBeNull()
  })
})

describe('Settings → Display → Start page', () => {
  afterEach(() => setAS({ newsAutoLoad: false }))

  it('switches news autoload write-through, and Reset turns it off again', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="display" />, {
      routes: ROUTES,
      overrides: OVERRIDES
    })
    const box = screen.getByRole('checkbox', { name: 'Load news from prismlca.com at every start' })
    expect(box).not.toBeChecked()
    await user.click(box)
    await waitFor(() => expect(prism.settings.newsAutoLoad).toBe(true))
    expect(box).toBeChecked()

    await user.click(screen.getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(prism.settings.newsAutoLoad).toBe(false))
    expect(box).not.toBeChecked()
  })
})

describe('Settings → About', () => {
  it('is the last page, shows the version and disables the check in a dev build', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} />, { routes: ROUTES })
    const rail = screen.getAllByRole('button').filter((b) => b.classList.contains('settings-cat'))
    expect(rail.at(-1)).toHaveTextContent('About')

    await user.click(screen.getByRole('button', { name: 'About' }))
    // Beta, the commit and the build kind beside the version.
    expect(await screen.findByText('Version 0.0.0-test · Beta (abc1234, dev)')).toBeInTheDocument()
    // Release notes only for a release build; a dev build has none to link to.
    expect(screen.queryByRole('button', { name: 'Release notes' })).toBeNull()
    expect(screen.getByText(/never checks for updates on its own/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeDisabled()
    expect(screen.getByText('Update checks work in the installed app only.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Save/i })).toBeNull()
    // Licence, notices, privacy and the source link live here too.
    expect(screen.getByRole('button', { name: 'AGPL-3.0' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Third-party notices' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Privacy notice' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'github.com/prismlca/prismlca' })).toBeInTheDocument()
  })

  it('copies the version block a bug report needs, and links a release build to its notes', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderWithPrism(<Settings onClose={() => {}} initialCategory="about" />, {
      routes: ROUTES,
      overrides: {
        bridge: {
          buildInfo: async () => ({
            version: '0.9.0',
            commit: 'a1b2c3d',
            kind: 'release',
            electron: '44.9.1',
            os: 'win32 x64 10.0.26100'
          }),
          info: async () => ({ app_version: '0.9.0' })
        }
      }
    })
    expect(await screen.findByText(/^Version 0\.9\.0 · Beta \(a1b2c3d\)/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Release notes' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Copy version info' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0][0]).toBe(
      'PrismLCA 0.9.0 (beta, release build, commit a1b2c3d)\nBackend 0.9.0\nElectron 44.9.1\nOS win32 x64 10.0.26100'
    )
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('checks only on the click, downloads only on the second, and follows the pushed progress', async () => {
    const user = userEvent.setup()
    let push: (s: unknown) => void = () => {}
    const updates = {
      state: vi.fn(async () => ({ phase: 'idle', current: '1.2.0' })),
      check: vi.fn(async () => ({ phase: 'available', current: '1.2.0', version: '1.3.0' })),
      download: vi.fn(async () => ({ phase: 'downloading', current: '1.2.0', version: '1.3.0', percent: 0 })),
      install: vi.fn(async () => ({ phase: 'downloaded', current: '1.2.0', version: '1.3.0' })),
      onEvent: (fn: (s: unknown) => void) => {
        push = fn
        return () => {}
      }
    }
    renderWithPrism(<Settings onClose={() => {}} initialCategory="about" />, {
      routes: ROUTES,
      overrides: { updates }
    })
    const check = await screen.findByRole('button', { name: 'Check for updates' })
    await waitFor(() => expect(check).toBeEnabled())
    expect(updates.check).not.toHaveBeenCalled()

    await user.click(check)
    expect(await screen.findByText('Version 1.3.0 is available.')).toBeInTheDocument()
    expect(updates.download).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Download' }))
    expect(updates.download).toHaveBeenCalledTimes(1)
    act(() => push({ phase: 'downloading', current: '1.2.0', version: '1.3.0', percent: 42 }))
    expect(await screen.findByText('Downloading… 42 %')).toBeInTheDocument()

    act(() => push({ phase: 'downloaded', current: '1.2.0', version: '1.3.0' }))
    expect(await screen.findByText('Version 1.3.0 is ready to install.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard download' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restart and install' }))
    expect(updates.install).toHaveBeenCalledTimes(1)
  })

  it('shows the latest-version line and a failure as an error hint', async () => {
    const user = userEvent.setup()
    const check = vi
      .fn()
      .mockResolvedValueOnce({ phase: 'up-to-date', current: '1.2.0', checkedAt: 1 })
      .mockResolvedValueOnce({
        phase: 'error',
        current: '1.2.0',
        message: 'No release of PrismLCA has been published on GitHub yet.'
      })
    renderWithPrism(<Settings onClose={() => {}} initialCategory="about" />, {
      routes: ROUTES,
      overrides: {
        updates: {
          state: async () => ({ phase: 'idle', current: '1.2.0' }),
          check,
          onEvent: () => () => {}
        }
      }
    })
    const button = await screen.findByRole('button', { name: 'Check for updates' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    expect(await screen.findByText('You are on the latest version (1.2.0).')).toBeInTheDocument()
    await user.click(button)
    const err = await screen.findByText('No release of PrismLCA has been published on GitHub yet.')
    expect(err).toHaveClass('settings-hint', 'bad')
  })

  // The states the install path adds (V-2 to V-4).
  const renderAbout = (state: unknown, extra: Record<string, unknown> = {}): void => {
    renderWithPrism(<Settings onClose={() => {}} initialCategory="about" />, {
      routes: ROUTES,
      overrides: {
        updates: { state: async () => state, check: vi.fn(), onEvent: () => () => {}, ...extra }
      }
    })
  }

  it('offers a deb installation the release page instead of a download', async () => {
    renderAbout({ phase: 'available', current: '1.2.0', version: '1.3.0', manualOnly: true })
    expect(await screen.findByText('Version 1.3.0 is available.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
    expect(screen.getByRole('button', { name: 'release page' })).toBeInTheDocument()
  })

  it('says why an install did not go ahead while work was running', async () => {
    renderAbout({
      phase: 'downloaded',
      current: '1.2.0',
      version: '1.3.0',
      note: 'PrismLCA is still busy (1 calculation running). Install the update once that has finished.'
    })
    expect(await screen.findByText(/still busy \(1 calculation running\)/)).toHaveClass('bad')
    expect(screen.getByRole('button', { name: 'Restart and install' })).toBeInTheDocument()
  })

  it('reports an update that did not complete and lets it be dismissed', async () => {
    const user = userEvent.setup()
    const discard = vi.fn(async () => ({ phase: 'idle', current: '1.2.0' }))
    renderAbout({ phase: 'incomplete', current: '1.2.0', version: '1.3.0' }, { discard })
    expect(await screen.findByText(/update to version 1\.3\.0 did not complete/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(discard).toHaveBeenCalledTimes(1)
  })

  it('offers a restart after a failed install has already stopped the backend', async () => {
    const user = userEvent.setup()
    const relaunch = vi.fn(async () => ({ phase: 'error', current: '1.2.0', message: 'x', restart: true }))
    renderAbout(
      {
        phase: 'error',
        current: '1.2.0',
        message: 'The update could not be installed: spawn EACCES',
        restart: true
      },
      { relaunch }
    )
    await user.click(await screen.findByRole('button', { name: 'Restart PrismLCA' }))
    expect(relaunch).toHaveBeenCalledTimes(1)
  })
})

describe('Settings → the category rail', () => {
  it('names the first page General, gives Language a page of its own, and marks the top level with icons', async () => {
    renderWithPrism(<Settings onClose={() => {}} />)
    const general = await screen.findByRole('button', { name: 'General' })
    expect(screen.queryByRole('button', { name: 'Display' })).toBeNull()
    // Every top-level entry and both group headings carry an icon; the grouped pages do not.
    for (const name of [
      'General',
      'Language',
      'Modelling',
      'Reporting',
      'Transport distances',
      'AI',
      'About'
    ])
      expect(screen.getByRole('button', { name }).querySelector('.settings-cat-icon svg')).not.toBeNull()
    expect(general.className).toContain('on')
    expect(screen.queryByText('Spell checking')).toBeNull() // no longer on General
    await userEvent.setup().click(screen.getByRole('button', { name: 'Language' }))
    expect(await screen.findByText('Spell checking')).toBeInTheDocument()
  })
})
