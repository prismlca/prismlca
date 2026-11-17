/**
 * The Models table shows its rows at once and OpenRouter's prices when they arrive — "…" in between, so a
 * price on its way is not read as "no permitted provider" (a dash). Under a direct provider the table
 * shows that provider's list prices and OpenRouter is not asked at all.
 */
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithPrism } from '../../test/render'
import { setAS } from '../../lib/appSettings'
import { KEY_CHANGED_EVENT, type AiModelInfo } from '../../lib/ai'
import { AiModelsPanel } from './AiModelsPanel'
import { useLivePrices } from './useLivePrices'

const MODELS = [
  { id: 'z-ai/glm-5.3', label: 'GLM 5.3 (Z.AI)', descriptor: 'open weight', selectable: true, pricing: null },
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    label: 'Sonnet 5.5 (Claude)',
    descriptor: 'balanced',
    selectable: true,
    pricing: { input: 3, output: 15 },
    pricingSource: 'list'
  }
]

afterEach(() => act(() => setAS({ provider: 'openrouter' })))

describe('the Models table and OpenRouter prices', () => {
  it('shows the rows at once, "…" while the price is on its way, then the price', async () => {
    let answer: (p: Record<string, { input: number; output: number }>) => void = () => undefined
    const prices = vi.fn(
      () => new Promise<Record<string, { input: number; output: number }>>((r) => (answer = r))
    )
    renderWithPrism(<AiModelsPanel />, {
      overrides: { ai: { models: async () => MODELS, openrouterPrices: prices } }
    })
    const row = (await screen.findByText('GLM 5.3 (Z.AI)')).closest('tr')!
    expect(within(row).getAllByText('…')).toHaveLength(2)
    // "…" is there from the first render; the request goes out an effect later, and only then can it be answered.
    await waitFor(() => expect(prices).toHaveBeenCalledTimes(1))
    act(() => answer({ 'z-ai/glm-5.3': { input: 0.4, output: 2.46 } }))
    await waitFor(() => expect(within(row).queryByText('…')).toBeNull())
    expect(row.textContent).toMatch(/0\.40/)
    expect(prices).toHaveBeenCalledTimes(1)
  })

  it('says "loading" in the very render that first has the rows, not one effect later', () => {
    // Otherwise the rows are on screen with a dash for a moment, and a test that looks right then fails.
    const seen: boolean[] = []
    function Probe(): null {
      seen.push(useLivePrices(MODELS as unknown as AiModelInfo[], true).loading)
      return null
    }
    renderWithPrism(<Probe />, {
      overrides: { ai: { openrouterPrices: () => new Promise<Record<string, never>>(() => undefined) } }
    })
    expect(seen[0]).toBe(true)
    expect(seen).not.toContain(false)
  })

  it('says "loading" again when the same request is asked a second time', async () => {
    // Away and back — to a direct provider, or to another set of models — ends in the request that was
    // answered before. It is asked again, so its rows show "…" again, not the old answer's dash.
    const answers: Array<(p: Record<string, never>) => void> = []
    const prices = vi.fn(() => new Promise<Record<string, never>>((r) => answers.push(r)))
    const all = MODELS as unknown as AiModelInfo[]
    let loading = false
    function Probe({ models, enabled }: { models: AiModelInfo[]; enabled: boolean }): null {
      loading = useLivePrices(models, enabled).loading
      return null
    }
    const { rerender } = renderWithPrism(<Probe models={all} enabled />, {
      overrides: { ai: { openrouterPrices: prices } }
    })
    await waitFor(() => expect(answers).toHaveLength(1))
    await act(async () => answers[0]({}))
    expect(loading).toBe(false)

    rerender(<Probe models={all} enabled={false} />)
    expect(loading).toBe(false)
    rerender(<Probe models={all} enabled />)
    expect(loading).toBe(true)
    await waitFor(() => expect(answers).toHaveLength(2))
    await act(async () => answers[1]({}))
    expect(loading).toBe(false)

    // …and through another request that is still on its way when the first one comes back.
    rerender(<Probe models={[{ ...all[0], id: 'another/model' }]} enabled />)
    expect(loading).toBe(true)
    await waitFor(() => expect(answers).toHaveLength(3))
    rerender(<Probe models={all} enabled />)
    expect(loading).toBe(true)
    await waitFor(() => expect(answers).toHaveLength(4))
    await act(async () => answers[3]({}))
    expect(loading).toBe(false)
  })

  it('does not ask OpenRouter while a direct provider is chosen', async () => {
    const prices = vi.fn(async () => ({}))
    renderWithPrism(<AiModelsPanel />, {
      overrides: { ai: { models: async () => MODELS, openrouterPrices: prices } }
    })
    act(() => setAS({ provider: 'anthropic' }))
    await screen.findByText('Sonnet 5.5 (Claude)')
    expect(prices).not.toHaveBeenCalled()
  })

  it('asks again when a key is entered while the page is open, and clears when it is removed', async () => {
    let keyed = false
    const prices = vi.fn(async () => (keyed ? { 'z-ai/glm-5.3': { input: 0.4, output: 2.46 } } : {}))
    renderWithPrism(<AiModelsPanel />, {
      overrides: { ai: { models: async () => MODELS, openrouterPrices: prices } }
    })
    const row = (await screen.findByText('GLM 5.3 (Z.AI)')).closest('tr')!
    await waitFor(() => expect(within(row).queryByText('…')).toBeNull())
    expect(row.textContent).not.toMatch(/0\.40/)
    keyed = true
    act(() => window.dispatchEvent(new Event(KEY_CHANGED_EVENT)))
    await waitFor(() => expect(row.textContent).toMatch(/0\.40/))
    keyed = false
    act(() => window.dispatchEvent(new Event(KEY_CHANGED_EVENT)))
    await waitFor(() => expect(row.textContent).not.toMatch(/0\.40/))
    expect(prices).toHaveBeenCalledTimes(3)
  })

  it('keeps the newer answer when an older one comes back late', async () => {
    const answers: Array<(p: Record<string, { input: number; output: number }>) => void> = []
    const prices = vi.fn(
      () => new Promise<Record<string, { input: number; output: number }>>((r) => answers.push(r))
    )
    renderWithPrism(<AiModelsPanel />, {
      overrides: { ai: { models: async () => MODELS, openrouterPrices: prices } }
    })
    const row = (await screen.findByText('GLM 5.3 (Z.AI)')).closest('tr')!
    await waitFor(() => expect(prices).toHaveBeenCalledTimes(1))
    act(() => window.dispatchEvent(new Event(KEY_CHANGED_EVENT)))
    await waitFor(() => expect(prices).toHaveBeenCalledTimes(2))
    // The newer request answers first, the older one after it.
    act(() => answers[1]({ 'z-ai/glm-5.3': { input: 0.4, output: 2.46 } }))
    await waitFor(() => expect(row.textContent).toMatch(/0\.40/))
    act(() => answers[0]({ 'z-ai/glm-5.3': { input: 9, output: 9 } }))
    await new Promise((r) => setTimeout(r, 20))
    expect(row.textContent).toMatch(/0\.40/)
  })

  it('stops showing "…" when the provider changes while prices are on their way', async () => {
    const prices = vi.fn(
      () => new Promise<Record<string, { input: number; output: number }>>(() => undefined)
    )
    renderWithPrism(<AiModelsPanel />, {
      overrides: { ai: { models: async () => MODELS, openrouterPrices: prices } }
    })
    await screen.findByText('GLM 5.3 (Z.AI)')
    act(() => setAS({ provider: 'anthropic' }))
    const row = (await screen.findByText('Sonnet 5.5 (Claude)')).closest('tr')!
    expect(within(row).queryByText('…')).toBeNull()
  })
})
