import { afterEach, describe, expect, it } from 'vitest'

import { setZeroDataRetention, zdrForModel } from './openrouter'

/**
 * Which requests carry `provider.zdr: true`.
 *
 * Two rules are in play and they are not the same one. `data_collection: 'deny'` selects providers
 * that do not COLLECT data — OpenRouter's own wording for the opposite value is "providers which
 * store user data non-transiently and may train on it", so that is the rule that stops training.
 * `zdr: true` is stricter and separate: only endpoints that RETAIN nothing.
 *
 * The exception exists because strictness is not free. Measured against
 * `/api/v1/endpoints/zdr` on 2026-09-10, sixteen of the eighteen catalogue models have at least one
 * zero-retention endpoint — but `anthropic/claude-fable-5.1` has none at all, so a blanket rule
 * would take the strongest model in the catalogue out of the picker on first launch. Google joined on
 * 2026-10-16: its endpoints log prompts for abuse monitoring, and OpenRouter announced (site banner) that
 * Google models require "Safety Retention" from 2026-10-18 — strict, every Gemini row would answer 404.
 *
 * OpenRouter's per-request parameter is a single boolean (the per-model-group fields exist only
 * account-wide and on guardrails), so the exception is applied here, by vendor.
 */
const on = (anthropic: boolean, openai: boolean, google = true): void =>
  setZeroDataRetention(true, { anthropic, openai, google })

afterEach(() => setZeroDataRetention(true, { anthropic: true, openai: true, google: true }))

describe('zdrForModel', () => {
  it('sends nothing at all when the switch is off', () => {
    setZeroDataRetention(false, { anthropic: false, openai: false, google: false })
    expect(zdrForModel('z-ai/glm-5.3')).toBe(false)
    expect(zdrForModel('anthropic/claude-fable-5.1')).toBe(false)
  })

  it('enforces retention for every vendor that is not exempted', () => {
    on(true, true)
    for (const id of [
      'z-ai/glm-5.3',
      'moonshotai/kimi-k3',
      'deepseek/deepseek-v4.1-flash',
      'qwen/qwen3.8-max',
      'vendor/a-model-the-user-added'
    ]) {
      expect(zdrForModel(id), id).toBe(true)
    }
  })

  it('exempts the three vendors when their boxes are ticked', () => {
    on(true, true)
    expect(zdrForModel('anthropic/claude-fable-5.1')).toBe(false)
    expect(zdrForModel('openai/gpt-6.1-sol')).toBe(false)
    expect(zdrForModel('google/gemini-4-argon')).toBe(false)
    expect(zdrForModel('google/gemini-3.8-flash')).toBe(false)
  })

  it('makes Google strict on its own when its box is unticked', () => {
    on(true, true, false)
    expect(zdrForModel('google/gemini-4-argon')).toBe(true)
    expect(zdrForModel('anthropic/claude-opus-5.5')).toBe(false)
    expect(zdrForModel('openai/gpt-6-astra')).toBe(false)
  })

  it('exempts them independently', () => {
    on(true, false)
    expect(zdrForModel('anthropic/claude-opus-5.5')).toBe(false)
    expect(zdrForModel('openai/gpt-6-astra')).toBe(true)
    on(false, true)
    expect(zdrForModel('anthropic/claude-opus-5.5')).toBe(true)
    expect(zdrForModel('openai/gpt-6-astra')).toBe(false)
  })

  it('never exempts on a prefix that merely starts the same way', () => {
    on(true, true)
    expect(zdrForModel('anthropic-mirror/claude')).toBe(true)
    expect(zdrForModel('openai-proxy/gpt')).toBe(true)
    expect(zdrForModel('google-mirror/gemini')).toBe(true)
  })

  it('treats a bare id (no vendor) as not exempted', () => {
    // Direct-OpenAI catalogue ids never reach this transport, but an id without a slash must not
    // accidentally read as a vendor match.
    on(true, true)
    expect(zdrForModel('gpt-6.1-sol')).toBe(true)
  })
})
