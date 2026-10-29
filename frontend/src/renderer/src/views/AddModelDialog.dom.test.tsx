import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithPrism } from '../test/render'
import AddModelDialog from './AddModelDialog'

/**
 * The picker exists so an id never has to be typed: a typo becomes a 404 in the middle of a paid
 * run. So what matters here is that the facts a user decides on are actually on screen — price,
 * context, and above all whether the model has a zero-retention endpoint, because without one it
 * cannot be served under PrismLCA's default privacy rule.
 */
const ROWS = [
  {
    id: 'mistralai/mistral-large-3',
    name: 'Mistral Large 3',
    contextTokens: 256_000,
    vision: false,
    pricing: { input: 2, output: 6 },
    zdr: true,
    inCatalogue: false
  },
  {
    id: 'someone/retaining-model',
    name: 'Retaining Model',
    contextTokens: 128_000,
    vision: true,
    pricing: { input: 1, output: 3 },
    zdr: false,
    inCatalogue: false
  },
  {
    id: 'z-ai/glm-5.3',
    name: 'GLM 5.3',
    contextTokens: 1_048_576,
    vision: false,
    pricing: { input: 1.4, output: 4.4 },
    zdr: true,
    inCatalogue: true
  }
]

const open = (
  overrides: Record<string, unknown> = {},
  onAdded = vi.fn()
): { onAdded: ReturnType<typeof vi.fn>; onClose: ReturnType<typeof vi.fn> } => {
  const onClose = vi.fn()
  renderWithPrism(<AddModelDialog onClose={onClose} onAdded={onAdded} />, {
    overrides: { ai: { openrouterCatalogue: async () => ROWS, ...overrides } }
  })
  return { onAdded, onClose }
}

describe('the Add-model dialog', () => {
  it('shows price, context and the zero-retention fact for each model', async () => {
    open()
    expect(await screen.findByText('Mistral Large 3')).toBeInTheDocument()
    const row = screen.getByText('Mistral Large 3').closest('button')
    expect(row?.textContent).toMatch(/256k ctx/)
    expect(row?.textContent).toMatch(/\$2\.00 \/ \$6\.00/)

    // The one fact nobody can guess, and the reason a model would 404 on first use.
    const retaining = screen.getByText('Retaining Model').closest('button')
    expect(retaining?.textContent).toMatch(/no zero-retention endpoint/)
    expect(row?.textContent).not.toMatch(/no zero-retention endpoint/)
  })

  it('shows a model PrismLCA already offers, but will not add it twice', async () => {
    open()
    const already = (await screen.findByText('GLM 5.3')).closest('button')
    expect(already).toBeDisabled()
    expect(already?.textContent).toMatch(/already listed/)
  })

  it('filters on every word, across name and id', async () => {
    const user = userEvent.setup()
    open()
    await screen.findByText('Mistral Large 3')
    await user.type(screen.getByRole('textbox'), 'mistral large')
    expect(screen.queryByText('Retaining Model')).toBeNull()
    expect(screen.getByText('Mistral Large 3')).toBeInTheDocument()

    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'z-ai/')
    expect(screen.getByText('GLM 5.3')).toBeInTheDocument()
    expect(screen.queryByText('Mistral Large 3')).toBeNull()
  })

  it('adds the picked model with the facts from the listing, then closes', async () => {
    const user = userEvent.setup()
    const add = vi.fn(async () => ({ ok: true, problems: [] }))
    const { onAdded, onClose } = open({ addUserModel: add })
    await user.click(await screen.findByText('Mistral Large 3'))

    expect(add).toHaveBeenCalledWith({
      id: 'mistralai/mistral-large-3',
      label: 'Mistral Large 3',
      vision: false,
      contextTokens: 256_000
    })
    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
  })

  it('does not pass a context window PrismLCA cannot serve', async () => {
    const user = userEvent.setup()
    const add = vi.fn(async (_entry: Record<string, unknown>) => ({ ok: true, problems: [] }))
    open(
      {
        addUserModel: add,
        openrouterCatalogue: async () => [{ ...ROWS[0], contextTokens: 16_384 }]
      },
      vi.fn()
    )
    await user.click(await screen.findByText('Mistral Large 3'))
    // null, not 16384: PrismLCA asks for up to 20 000 output tokens on every request, so the loader
    // would refuse that entry outright. Letting it pick its own default is the usable answer.
    expect(add.mock.calls[0][0]).toMatchObject({ contextTokens: null })
  })

  it('keeps the dialog open and says why when the model is refused', async () => {
    const user = userEvent.setup()
    const { onClose } = open({
      addUserModel: async () => ({ ok: false, problems: ['models.json: "x" is not a valid id — skipped.'] })
    })
    await user.click(await screen.findByText('Mistral Large 3'))
    expect(await screen.findByText(/is not a valid id/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says so when the list cannot be fetched at all', async () => {
    open({ openrouterCatalogue: async () => [] })
    expect(await screen.findByText(/could not be fetched/)).toBeInTheDocument()
  })
})
