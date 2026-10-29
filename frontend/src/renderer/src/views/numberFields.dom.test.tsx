import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Settings from './Settings'
import { renderWithPrism } from '../test/render'
import { setAS } from '../lib/appSettings'
import { DEFAULT_SETTINGS, setSettings } from '../lib/settings'
import { clearLikeChromium, typeLikeChromium } from '../test/typeNumber'
import {
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_RESEARCH_QUESTIONS,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MIN_THROUGHPUT,
  DEFAULT_WRITER_MAX_TOKENS
} from '../../../shared/aiDefaults'

/**
 * Number fields typed into the way a person does (18.10.2026). Each field used to coerce every keystroke:
 * an emptied field became its fallback or floor at once and the next digits were appended to it
 * (Backspace, 64000 → 250 000 tokens), and Chromium's "2." arrived as '' and came back as 0 ("2.75" →
 * a cost limit of 75). `typeLikeChromium` reproduces the second; user-event reproduces the first.
 */
const ROUTES = {
  'GET /api/v1/ai/skills': { skills: [] },
  'GET /api/v1/report/identity': { logo_height_mm: 12 },
  'POST /api/v1/report/identity': (body: Record<string, unknown>) => ({ logo_height_mm: 12, ...body })
}

afterEach(() => {
  setAS({
    maxCostUsd: DEFAULT_MAX_COST_USD,
    maxTokens: DEFAULT_MAX_TOKENS,
    writerMaxTokens: DEFAULT_WRITER_MAX_TOKENS,
    maxRounds: DEFAULT_MAX_ROUNDS,
    minThroughput: DEFAULT_MIN_THROUGHPUT,
    maxResearchQuestions: DEFAULT_MAX_RESEARCH_QUESTIONS
  })
  setSettings(DEFAULT_SETTINGS)
})

const input = (label: string | RegExp): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement

describe('number fields take what is typed', () => {
  it('AI → Limits: a decimal cost, and token, round and width figures typed after emptying the field', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-limits" />, {
      routes: ROUTES
    })
    const cost = input(/Cost limit per run/)
    clearLikeChromium(cost)
    typeLikeChromium(cost, '2.75')
    expect(prism.settings.maxCostUsd).toBe(2.75)

    for (const [label, typed, key] of [
      ['Max tokens per reply', '64000', 'maxTokens'],
      ['Max tokens per writer reply', '120000', 'writerMaxTokens'],
      ['Max tool rounds', '37', 'maxRounds'],
      ['Parallel research questions', '3', 'maxResearchQuestions'],
      [/Preferred provider speed/, '35', 'minThroughput']
    ] as const) {
      const field = input(label)
      await user.clear(field)
      await user.type(field, typed)
      await user.tab()
      expect([key, prism.settings[key]]).toEqual([key, Number(typed)])
      expect(field).toHaveValue(Number(typed))
    }
  })

  it('AI → Limits: an emptied token field writes nothing and shows the stored figure again on leaving', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} initialCategory="ai-limits" />, { routes: ROUTES })
    const bridge = (window as unknown as { prism: { appSettings: { set: () => Promise<unknown> } } }).prism
    const set = vi.spyOn(bridge.appSettings, 'set')
    for (const label of ['Max tokens per reply', 'Max tokens per writer reply', /Cost limit per run/]) {
      const field = input(label)
      const shown = field.value
      await user.clear(field)
      await user.tab()
      expect(field.value).toBe(shown)
    }
    expect(set).not.toHaveBeenCalled()
  })

  it('General: a rounding digit typed after emptying the field', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Settings onClose={() => {}} initialCategory="display" />, { routes: ROUTES })
    const edges = input('Numbers on the arrows (canvas)')
    await user.clear(edges)
    await user.type(edges, '4')
    await user.tab()
    await waitFor(() => expect(edges).toHaveValue(4))
  })

  it('Transport → Limits: calls per turn typed after emptying the field', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Settings onClose={() => {}} initialCategory="transport-limits" />, {
      routes: ROUTES
    })
    const perTurn = input('API calls per assistant turn')
    await user.clear(perTurn)
    await user.type(perTurn, '30')
    await user.tab()
    await waitFor(() => expect((prism.settings.transport as { perTurnCalls: number }).perTurnCalls).toBe(30))
    expect(perTurn).toHaveValue(30)
  })

  it('Reporting: a decimal logo height', async () => {
    renderWithPrism(<Settings onClose={() => {}} initialCategory="reporting" />, { routes: ROUTES })
    const logo = (await screen.findByLabelText(/Logo height/)) as HTMLInputElement
    await waitFor(() => expect(logo).toHaveValue(12))
    clearLikeChromium(logo)
    typeLikeChromium(logo, '7.4')
    expect(logo).toHaveValue(7.4)
  })
})
