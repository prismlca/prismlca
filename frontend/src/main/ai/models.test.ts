import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OPENAI_MODEL_ID } from '../../shared/aiDefaults'
import { DEFAULT_MODEL_ID, findModel, getModels, modelBelongsTo, providerDefaults } from './models'

const AI_MODELS = getModels()

const LOGO_MAP = join(__dirname, '../../renderer/src/lib/labLogos.ts')

/** Same rule as the renderer's labKey(): a bare id (no slash) is a direct-OpenAI catalogue id. */
const vendorOf = (id: string): string => (id.includes('/') ? id.split('/')[0] : 'openai')

describe('lab logos', () => {
  it('are registered for every vendor in the catalogue', () => {
    // Checked from here because the renderer may not import from main, and read as text rather than
    // imported because the two live in separate tsconfig projects. Only the MAP is checked, never a
    // filename: `z-ai` deliberately resolves to `zai.svg`.
    //
    // The invariant is what matters. The map was written in July, `nvidia` and `qwen` joined later,
    // and a vendor with no entry renders as nothing at all — so the cost table quietly lost two
    // icons and it took a person noticing rather than anything in the build.
    const registered = readFileSync(LOGO_MAP, 'utf8')
    const vendors = [...new Set(AI_MODELS.map((m) => vendorOf(m.id)))]
    const unmapped = vendors.filter(
      (v) => !new RegExp(`(^|[\\s{])'?${v.replace(/[.\-]/g, '\\$&')}'?\\s*:`, 'm').test(registered)
    )
    expect(unmapped, `add a logo to LAB_LOGOS for: ${unmapped.join(', ')}`).toEqual([])
  })
})

describe('the direct-OpenAI half of the catalogue', () => {
  const openai = AI_MODELS.filter((m) => m.provider === 'openai')

  it('exists, and its ids are bare (no vendor prefix — that is how labKey tells the halves apart)', () => {
    expect(openai.length).toBeGreaterThan(0)
    for (const m of openai) expect(m.id.includes('/'), m.id).toBe(false)
  })

  it('carries complete hand-maintained list prices on EVERY entry', () => {
    // OpenAI reports no usage.cost and has no pricing endpoint: this table is the only thing the
    // cost circuit breaker sees. A missing entry does not error anywhere — it silently blinds the
    // breaker and the ledger, which is exactly the failure this assertion exists to make loud.
    for (const m of openai) {
      expect(m.pricing, `${m.id} needs pricing {input, cachedInput, output}`).toBeDefined()
      expect(m.pricing!.input, m.id).toBeGreaterThan(0)
      expect(m.pricing!.cachedInput, m.id).toBeGreaterThan(0)
      expect(m.pricing!.output, m.id).toBeGreaterThan(0)
    }
  })

  it('never marks explicitCache (OpenAI caches automatically; the marker is Anthropic-only)', () => {
    for (const m of openai) expect(m.explicitCache, m.id).toBeUndefined()
  })
})

describe('provider-aware model resolution', () => {
  it('keeps the historical single-provider behaviour by default', () => {
    expect(findModel('z-ai/glm-5.3').id).toBe('z-ai/glm-5.3')
    expect(findModel('does-not-exist').id).toBe(DEFAULT_MODEL_ID)
  })

  it('never lets an id cross to the wrong API — it degrades to the active provider’s default', () => {
    // A stored Sonnet-5 choice under the OpenAI provider is not an error, it is inactive there.
    expect(findModel('anthropic/claude-sonnet-5.5', 'openai').id).toBe(DEFAULT_OPENAI_MODEL_ID)
    expect(findModel('gpt-6.1-sol', 'openrouter').id).toBe(DEFAULT_MODEL_ID)
    expect(findModel('gpt-6.1-sol', 'openai').id).toBe('gpt-6.1-sol')
  })

  it('answers membership the way Settings sanitizes stored choices', () => {
    expect(modelBelongsTo('gpt-6-luna', 'openai')).toBe(true)
    expect(modelBelongsTo('gpt-6-luna', 'openrouter')).toBe(false)
    expect(modelBelongsTo('anthropic/claude-sonnet-5.5', 'openrouter')).toBe(true)
    expect(modelBelongsTo('', 'openai')).toBe(false)
  })

  it('names only catalogue models in the per-provider defaults, chat defaults included', () => {
    for (const p of ['openrouter', 'openai'] as const) {
      const d = providerDefaults(p)
      for (const id of [d.chat, d.research, d.review, d.writerFallback]) {
        expect(findModel(id, p).id, `${p}: ${id}`).toBe(id)
      }
    }
  })
})

describe('the order the catalogue is shown in', () => {
  /**
   * One order serves the six pickers AND the cost table, and it is DERIVED (lab A→Z, strongest of
   * that lab first) rather than the order entries were written in. Held here because the whole
   * point is that a new entry sorts itself in: an edit that reintroduces hand-kept order would
   * otherwise pass everything else and only show up as a table that has quietly gone back to
   * scattering families.
   */
  it('groups by lab alphabetically, strongest first inside a lab', () => {
    const labs = AI_MODELS.map((m) => vendorOf(m.id))
    expect(labs, 'labs must be A→Z').toEqual([...labs].sort((a, b) => a.localeCompare(b)))
    // …and each lab must be one contiguous block, not two.
    expect(new Set(labs).size).toBe(labs.filter((l, i) => l !== labs[i - 1]).length)

    for (const lab of new Set(labs)) {
      const rated = AI_MODELS.filter((m) => vendorOf(m.id) === lab).map((m) => m.intelligence ?? -Infinity)
      expect(rated, `${lab} must run strongest first`).toEqual([...rated].sort((a, b) => b - a))
    }
  })

  it('closes a lab with its unrated rows instead of hiding them mid-block', () => {
    // Whisper is the case: rated nowhere on the language leaderboard, still listed for cost.
    const openai = AI_MODELS.filter((m) => vendorOf(m.id) === 'openai')
    expect(openai.at(-1)?.id).toBe('openai/whisper-large-v3')
  })
})
