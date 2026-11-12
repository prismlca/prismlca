/**
 * The chat role's effort floor (V486): main never sends less than a model's `minChatEffort`, whatever
 * is stored, and an upgrade lifts a stored lower choice once and says so. The floor is the chat's
 * alone — the research legs keep running Luna at low.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { chat } from './test/fakeStream'
import { chatEffort, chatEffortLevels, effortStepName } from '../../shared/aiDefaults'
import { chatRunEffort, effortAfterRejection, effortRejectionRetry, liftChatEffortFloors } from './chatEffort'
import { AiProviderError } from './providers/types'
import { findModel, getModels } from './models'

vi.mock('./client', async () => (await import('./test/fakeStream')).clientModuleMock())

const LUNA = findModel('openai/gpt-6-luna', 'openrouter')
const LUNA_DIRECT = findModel('gpt-6-luna', 'openai')
const SOL = findModel('openai/gpt-6.1-sol', 'openrouter')

describe('the shared rule', () => {
  it('offers the levels from the floor up, and all of them without one', () => {
    expect(chatEffortLevels(LUNA)).toEqual(['high', 'xhigh', 'max'])
    expect(chatEffortLevels(SOL)).toEqual(SOL.reasoningEfforts)
    expect(chatEffortLevels(undefined)).toEqual([])
  })

  it('lifts a lower choice and Default to the floor, and keeps a higher one', () => {
    for (const low of ['', undefined, 'none', 'low', 'medium'] as const)
      expect(chatEffort(low, LUNA)).toBe('high')
    expect(chatEffort('xhigh', LUNA)).toBe('xhigh')
    expect(chatEffort('max', LUNA)).toBe('max')
    expect(chatEffort(undefined, SOL)).toBe('')
    expect(chatEffort('low', SOL)).toBe('low')
  })

  it('reads a level the row no longer offers as Default — 6.1 Sol lost none and minimal', () => {
    expect(chatEffort('minimal', SOL)).toBe('')
    expect(chatEffort('none', SOL)).toBe('')
    // Luna lost minimal: below the floor either way.
    expect(chatEffort('minimal', LUNA)).toBe('high')
    // A model that documents no levels sends none, whatever a hand-edited file says.
    expect(chatEffort('high', { reasoningEfforts: undefined })).toBe('')
  })

  it('names Default with the documented level, and a bare Default where there is none', () => {
    expect(effortStepName('', 'medium')).toBe('Default (medium)')
    expect(effortStepName('', undefined)).toBe('Default')
    expect(effortStepName('xhigh', 'medium')).toBe('X-high')
  })
})

describe('what a chat run sends', () => {
  it('never goes below the Luna floor on either route, whatever is stored', () => {
    for (const m of [LUNA, LUNA_DIRECT]) {
      expect(chatRunEffort(m, {})).toBe('high')
      expect(chatRunEffort(m, { [m.id]: 'none' })).toBe('high')
      expect(chatRunEffort(m, { [m.id]: 'medium' })).toBe('high')
      expect(chatRunEffort(m, { [m.id]: 'xhigh' })).toBe('xhigh')
      expect(chatRunEffort(m, { [m.id]: 'max' })).toBe('max')
    }
  })

  it('leaves a model without a floor as stored — Default, or a level it lost, sends nothing', () => {
    expect(chatRunEffort(SOL, {})).toBeUndefined()
    expect(chatRunEffort(SOL, { [SOL.id]: 'low' })).toBe('low')
    expect(chatRunEffort(SOL, { [SOL.id]: 'minimal' })).toBeUndefined()
  })

  it('retries a refused level on the floor above it, and only a refused floor on the default', () => {
    expect(effortAfterRejection('max', LUNA)).toBe('high')
    expect(effortAfterRejection('high', LUNA)).toBeUndefined()
    expect(effortAfterRejection('xhigh', SOL)).toBeUndefined()
  })
})

describe('the research legs keep Luna free', () => {
  beforeEach(() => {
    chat.seen.length = 0
    chat.alwaysDelta = true
    chat.fallbackText = '[{"component":"x","material":"PET","mass_kg":0.01,"source_url":"https://e.org"}]'
  })

  it('runs a research leg on Luna at low, below its chat floor', async () => {
    const { researchBom } = await import('./subagent')
    await researchBom({ product: 'widget', components: ['body'], model: LUNA.id })
    expect(chat.seen.map((c) => [c.model, c.reasoningEffort])).toEqual([[LUNA.id, 'low']])
  })
})

describe('the one-time lift of stored choices', () => {
  const models = getModels()

  it('lifts a lower stored level wherever it is, and says so once per model', () => {
    const { efforts, notice } = liftChatEffortFloors(
      { 'openai/gpt-6-luna': 'medium', 'gpt-6-luna': 'none', 'z-ai/glm-5.3': 'low' },
      'anthropic/claude-sonnet-5.5',
      models
    )
    expect(efforts).toEqual({ 'openai/gpt-6-luna': 'high', 'gpt-6-luna': 'high', 'z-ai/glm-5.3': 'low' })
    // Both routes share one label: one sentence, then the reason.
    expect(notice).toBe(
      'GPT-6 Luna (OpenAI) now chats at High reasoning effort. Luna models reliably only at high effort or above — at lower settings it can miss whole parts of a model.'
    )
  })

  it('lifts Default only where Luna is the chat model', () => {
    expect(liftChatEffortFloors({}, 'openai/gpt-6-luna', models)).toMatchObject({
      efforts: { 'openai/gpt-6-luna': 'high' },
      notice: expect.stringContaining('now chats at High')
    })
    expect(liftChatEffortFloors(undefined, 'openai/gpt-6.1-sol', models)).toEqual({ efforts: {}, notice: '' })
  })

  it('leaves a level at or above the floor, and anything unreadable, to the run and the sanitiser', () => {
    const stored = { 'openai/gpt-6-luna': 'xhigh', 'gpt-6-luna': 'turbo' }
    expect(liftChatEffortFloors(stored, 'gpt-6-luna', models)).toEqual({ efforts: stored, notice: '' })
  })
})

describe('a refused reasoning level', () => {
  const luna = { id: 'gpt-6-luna', minChatEffort: 'high' as const }
  const refused = new AiProviderError('Unsupported value for reasoning.effort: "max"', 'http')
  it('retries on the floor when the refused level sat above it, and says so', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const r = effortRejectionRetry(refused, 'max', luna)
    expect(r?.next).toBe('high')
    expect(r?.note).toMatch(/rejected the reasoning effort "max" — continuing on "high"/)
  })
  it('falls back to the default when the floor itself was refused', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(effortRejectionRetry(refused, 'high', luna)?.next).toBeUndefined()
  })
  it('leaves every other failure alone', () => {
    expect(effortRejectionRetry(new AiProviderError('rate limit', 'rate_limit'), 'max', luna)).toBeNull()
    expect(effortRejectionRetry(new AiProviderError('Bad request: messages', 'http'), 'max', luna)).toBeNull()
    expect(effortRejectionRetry(refused, undefined, luna)).toBeNull()
  })
})
