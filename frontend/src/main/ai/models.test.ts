import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ANTHROPIC_MODEL_ID,
  DEFAULT_GOOGLE_MODEL_ID,
  DEFAULT_OPENAI_MODEL_ID
} from '../../shared/aiDefaults'
import { billedBy, labKey } from '../../shared/labKey'
import { priceFor, priceOn } from './directModels'
import {
  DEFAULT_MODEL_ID,
  findModel,
  getModels,
  isDirectOnlyId,
  modelBelongsTo,
  providerDefaults
} from './models'

const AI_MODELS = getModels()

const LOGO_MAP = join(__dirname, '../../renderer/src/lib/labLogos.ts')

/** The renderer's rule, imported rather than copied: a copy kept "bare = OpenAI" after Google's bare
 *  ids arrived and failed the order test for a reason that had nothing to do with the order. */
const vendorOf = labKey

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

describe.each(['anthropic', 'google', 'openai'] as const)(
  'the direct-%s half of the catalogue',
  (provider) => {
    const rows = AI_MODELS.filter((m) => m.provider === provider)

    it('exists, its ids are bare, and the ledger books them to this provider', () => {
      expect(rows.length).toBeGreaterThan(0)
      for (const m of rows) {
        expect(m.id.includes('/'), m.id).toBe(false)
        // The cost table has no provider column: it tells the halves apart by the id alone.
        expect(billedBy(m.id), m.id).toBe(provider)
        expect(labKey(m.id), m.id).toBe(provider)
      }
    })

    it('carries complete hand-maintained list prices on EVERY entry', () => {
      // Neither vendor reports a cost or has a pricing endpoint: this table is the only thing the
      // cost circuit breaker sees. A missing entry does not error anywhere — it silently blinds the
      // breaker and the ledger, which is exactly the failure this assertion exists to make loud.
      for (const m of rows) {
        expect(m.pricing, `${m.id} needs pricing {input, cachedInput, output}`).toBeDefined()
        expect(m.pricing!.input, m.id).toBeGreaterThan(0)
        expect(m.pricing!.cachedInput, m.id).toBeGreaterThan(0)
        expect(m.pricing!.output, m.id).toBeGreaterThan(0)
      }
    })

    it('dates its announced price changes in order, each one a complete price', () => {
      for (const m of rows) {
        const days = (m.priceChanges ?? []).map((c) => c.from)
        for (const d of days) expect(d, m.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(days, m.id).toEqual([...days].sort())
        for (const c of m.priceChanges ?? [])
          expect(c.input * c.output * c.cachedInput, m.id).toBeGreaterThan(0)
      }
    })

    it('marks explicitCache exactly on Anthropic (the others cache automatically)', () => {
      for (const m of rows) expect(m.explicitCache === true, m.id).toBe(provider === 'anthropic')
    })

    it('applies the long-prompt prices only above the threshold, to the whole request', () => {
      for (const m of rows.filter((r) => r.longPrompt)) {
        expect(priceFor(m, m.longPrompt!.above), m.id).toEqual(priceOn(m))
        expect(priceFor(m, m.longPrompt!.above + 1), m.id).toBe(m.longPrompt)
      }
    })

    it('prices a longer prompt higher, if it prices it apart at all', () => {
      for (const m of rows.filter((r) => r.longPrompt)) {
        const long = m.longPrompt!
        expect(long.above, m.id).toBeGreaterThan(0)
        expect(long.input, m.id).toBeGreaterThan(m.pricing!.input)
        expect(long.cachedInput, m.id).toBeGreaterThan(m.pricing!.cachedInput)
        expect(long.output, m.id).toBeGreaterThan(m.pricing!.output)
      }
    })
  }
)

describe('list prices by date', () => {
  const argon = AI_MODELS.find((m) => m.id === 'gemini-4-argon' && m.provider === 'google')!

  it('bills the price that applies on the day — the announced step included', () => {
    expect(priceOn(argon, '2026-11-30')?.input).toBe(2)
    expect(priceOn(argon, '2026-12-01')?.input).toBe(4)
    expect(priceOn(argon, '2027-06-01')?.output).toBe(20)
  })

  it('is undefined for a row without hand-kept prices', () => {
    expect(priceOn({ pricing: undefined })).toBeUndefined()
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
    // The same model under two ids: OpenRouter's prefixed row and Google's bare one never mix.
    expect(findModel('google/gemini-3.8-flash', 'google').id).toBe(DEFAULT_GOOGLE_MODEL_ID)
    expect(findModel('gemini-4-argon', 'openrouter').id).toBe(DEFAULT_MODEL_ID)
    expect(findModel('gemini-4-argon', 'google').id).toBe('gemini-4-argon')
    expect(findModel('anthropic/claude-sonnet-5.5', 'anthropic').id).toBe(DEFAULT_ANTHROPIC_MODEL_ID)
    expect(findModel('claude-opus-5-5', 'openrouter').id).toBe(DEFAULT_MODEL_ID)
    expect(findModel('claude-opus-5-5', 'anthropic').id).toBe('claude-opus-5-5')
  })

  it('knows which ids must never travel to OpenRouter', () => {
    expect(isDirectOnlyId('gpt-6-luna')).toBe(true)
    expect(isDirectOnlyId('gemini-3.8-flash')).toBe(true)
    expect(isDirectOnlyId('google/gemini-3.8-flash')).toBe(false)
    expect(isDirectOnlyId('claude-haiku-5-5')).toBe(true)
    expect(isDirectOnlyId('anthropic/claude-haiku-5.5')).toBe(false)
    expect(isDirectOnlyId('some/unknown-model')).toBe(false)
  })

  it('answers membership the way Settings sanitizes stored choices', () => {
    expect(modelBelongsTo('gpt-6-luna', 'openai')).toBe(true)
    expect(modelBelongsTo('gpt-6-luna', 'openrouter')).toBe(false)
    expect(modelBelongsTo('anthropic/claude-sonnet-5.5', 'openrouter')).toBe(true)
    expect(modelBelongsTo('', 'openai')).toBe(false)
  })

  it('names only catalogue models in the per-provider defaults, chat defaults included', () => {
    for (const p of ['openrouter', 'anthropic', 'google', 'openai'] as const) {
      const d = providerDefaults(p)
      for (const id of [d.chat, d.research, d.review, d.writerFallback, d.match]) {
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

describe('reasoning effort per row', () => {
  const VOCAB = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

  it('lists only known levels, in ascending order, and names a default or a floor only among them', () => {
    for (const m of AI_MODELS) {
      const levels = m.reasoningEfforts ?? []
      const ranks = levels.map((l) => VOCAB.indexOf(l))
      expect(
        ranks.every((r) => r >= 0),
        m.id
      ).toBe(true)
      expect(ranks, m.id).toEqual([...ranks].sort((a, b) => a - b))
      expect(new Set(levels).size, m.id).toBe(levels.length)
      if (m.defaultEffort) expect(levels, m.id).toContain(m.defaultEffort)
      if (m.minChatEffort) {
        expect(levels, m.id).toContain(m.minChatEffort)
        // A floor without its reason would cut the picker short with nothing to say why.
        expect(m.minChatEffortNote, m.id).toBeTruthy()
      }
    }
  })

  // OpenAI's model pages and reasoning guide, and OpenRouter's listing for the same models: 6.1 Sol and
  // Astra take neither `none` nor `minimal`, Luna takes `none` but not `minimal`, all three take `max`;
  // 6.1 Sol and Luna default to medium. The two routes to one model offer the same levels.
  it.each([
    ['gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['gpt-6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
    ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max'], undefined]
  ] as const)('%s offers the documented levels on both routes', (id, levels, dflt) => {
    const direct = findModel(id, 'openai')
    const routed = findModel(`openai/${id}`, 'openrouter')
    expect(direct.id).toBe(id)
    expect(routed.id).toBe(`openai/${id}`)
    expect(direct.reasoningEfforts).toEqual(levels)
    expect(routed.reasoningEfforts).toEqual(levels)
    expect(direct.defaultEffort).toBe(dflt)
  })

  it('puts the chat floor on GPT-6 Luna alone, on both routes, and leaves it the cheap roles', () => {
    expect(
      AI_MODELS.filter((m) => m.minChatEffort)
        .map((m) => m.id)
        .sort()
    ).toEqual(['gpt-6-luna', 'openai/gpt-6-luna'])
    expect(findModel('gpt-6-luna', 'openai').minChatEffort).toBe('high')
    expect(findModel('openai/gpt-6-luna', 'openrouter').minChatEffort).toBe('high')
    // The floor is the chat's: Luna stays the default for research, review, writer fallback and matching.
    const { research, review, writerFallback, match } = providerDefaults('openai')
    expect([research, review, writerFallback, match]).toEqual(Array(4).fill('gpt-6-luna'))
    expect(providerDefaults('openrouter').match).toBe('openai/gpt-6-luna')
  })
})
