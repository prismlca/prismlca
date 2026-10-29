/**
 * The app settings in `userData` — and the reason they moved there.
 *
 * The cost brake used to be a number the renderer read from its own store and sent along with each
 * run: the side being limited set the limit. `clampCost` is the fix, and the test for it is the point
 * of this file. The rest holds the ordinary promises: a round trip, defaults that do not surprise,
 * unknown keys kept, and a one-time seed that never overwrites a newer value.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'prism-settings-'))

vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const s = await import('./settings')
const FILE = join(userData, 'settings.json')

beforeEach(() => {
  writeFileSync(FILE, JSON.stringify({ schema: 1 }))
  s.resetSettingsCache()
})

/** Pin the locale the way the app sees it: LC_ALL and LC_MESSAGES outrank LANG, so they have to go. */
function withLocale(locale: string): { restore: () => void } {
  const before = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LC_MESSAGES: process.env.LC_MESSAGES
  }
  delete process.env.LC_ALL
  delete process.env.LC_MESSAGES
  process.env.LANG = locale
  return {
    restore: () => {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }
}

describe('the spell-check default', () => {
  // The bug this pins: the default was built at import time, where `app.getLocale()` has nothing to
  // say, so the locale branch never fired and every system got English-only checking.
  it('adds the system language when PrismLCA ships a dictionary for it', () => {
    expect(s.defaultDictsFor('de_DE.UTF-8')).toEqual(['en-US', 'de-DE'])
    expect(s.defaultDictsFor('de-DE')).toEqual(['en-US', 'de-DE'])
    expect(s.defaultDictsFor('fr')).toEqual(['en-US', 'fr-FR'])
  })

  it('reads a bare pt as European and an explicit pt-BR as Brazilian', () => {
    expect(s.defaultDictsFor('pt')).toEqual(['en-US', 'pt-PT'])
    expect(s.defaultDictsFor('pt_BR.UTF-8')).toEqual(['en-US', 'pt-BR'])
  })

  it('answers English alone for a language we ship no dictionary for, and never twice for English', () => {
    expect(s.defaultDictsFor('it-IT')).toEqual(['en-US'])
    expect(s.defaultDictsFor('')).toEqual(['en-US'])
    expect(s.defaultDictsFor('en-GB')).toEqual(['en-US'])
  })

  it('uses the environment when the app is not ready — which is when the file is first read', () => {
    // French on purpose: the machine running this has its own locale, and a default frozen at import
    // time could accidentally match it. A language nobody here uses can only come from the read.
    const env = withLocale('fr_FR.UTF-8')
    try {
      s.resetSettingsCache()
      expect(s.getSettings().spellcheckLanguages).toEqual(['en-US', 'fr-FR'])
    } finally {
      env.restore()
    }
  })

  it('never overrides a choice that was made — including “off”', () => {
    const env = withLocale('fr_FR.UTF-8')
    try {
      s.setSettings({ spellcheckLanguages: ['en-US'] })
      s.resetSettingsCache()
      expect(s.getSettings().spellcheckLanguages).toEqual(['en-US'])
      s.setSettings({ spellcheckLanguages: [] })
      s.resetSettingsCache()
      expect(s.getSettings().spellcheckLanguages).toEqual([])
    } finally {
      env.restore()
    }
  })
})

describe('the app settings store', () => {
  it('answers with the defaults when nothing is stored', () => {
    const got = s.getSettings()
    expect(got.maxCostUsd).toBe(s.DEFAULTS.maxCostUsd)
    expect(got.disabledTools).toEqual([])
    expect(got.zeroDataRetention).toBe(s.DEFAULTS.zeroDataRetention)
  })

  it('gives the writer a ceiling of its own, larger than the chat’s and clamped the same way', () => {
    expect(s.getSettings().writerMaxTokens).toBe(100_000)
    expect(s.getSettings().writerMaxTokens).toBeGreaterThan(s.getSettings().maxTokens)
    s.setSettings({ writerMaxTokens: 999_999 })
    s.resetSettingsCache()
    expect(s.getSettings().writerMaxTokens).toBe(250_000)
    s.setSettings({ writerMaxTokens: 'abc' as never })
    s.resetSettingsCache()
    expect(s.getSettings().writerMaxTokens).toBe(100_000) // garbage reads as the writer's default
  })

  it('writes through and reads back', () => {
    s.setSettings({ maxCostUsd: 7.5, disabledTools: ['delete_activity'] })
    s.resetSettingsCache()
    const got = s.getSettings()
    expect(got.maxCostUsd).toBe(7.5)
    expect(got.disabledTools).toEqual(['delete_activity'])
  })

  it('does not let a run ask for a higher limit than the stored one', () => {
    // The whole reason these moved out of the renderer.
    s.setSettings({ maxCostUsd: 2 })
    expect(s.clampCost(50)).toBe(2)
    expect(s.clampCost(1)).toBe(1) // asking for less is fine
    expect(s.clampCost(undefined)).toBe(2) // no request value: the stored limit applies
  })

  it('treats a stored 0 as "no limit" and still honours a request that sets one', () => {
    s.setSettings({ maxCostUsd: 0 })
    expect(s.clampCost(undefined)).toBe(0)
    expect(s.clampCost(5)).toBe(5)
  })

  it('clamps the round budget the same way', () => {
    s.setSettings({ maxRounds: 40 })
    expect(s.clampRounds(400)).toBe(40)
    expect(s.clampRounds(10)).toBe(10)
    expect(s.clampRounds(undefined)).toBe(40)
  })

  it('moves a retired model id to its successor instead of leaving it to fail', () => {
    // OpenRouter retired `stealth/ox-alpha` on 2026-08-26. A stored id outlives the
    // catalogue: taking the model out of the picker does nothing for the person who already chose
    // it, and they find out by losing a paid run — sixteen 404s inside one report run, measured.
    writeFileSync(
      FILE,
      JSON.stringify({
        schema: 2,
        model: 'stealth/ox-alpha',
        researchModel: 'stealth/ox-alpha',
        reviewModel: 'anthropic/claude-sonnet-5.5',
        writerModel: ''
      })
    )
    s.resetSettingsCache()
    const after = s.getSettings()
    expect(after.model).toBe('z-ai/glm-5.3-flash')
    expect(after.researchModel).toBe('z-ai/glm-5.3-flash')
    // Every other choice is left exactly as it was — a migration touches the one id it is about.
    expect(after.reviewModel).toBe('anthropic/claude-sonnet-5.5')
    expect(after.writerModel).toBe('')
    // …and it is written back, so it runs once per installation rather than once per read.
    expect(JSON.parse(readFileSync(FILE, 'utf-8')).model).toBe('z-ai/glm-5.3-flash')
  })

  it('keeps a setting written by a newer version', () => {
    writeFileSync(FILE, JSON.stringify({ schema: 1, maxCostUsd: 3, futureThing: { deep: true } }))
    s.resetSettingsCache()
    s.setSettings({ maxRounds: 12 })
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'))
    expect(raw.futureThing).toEqual({ deep: true })
    expect(raw.maxRounds).toBe(12)
    expect(raw.maxCostUsd).toBe(3)
  })

  it('seeds from the old browser values only where the file is silent', () => {
    s.setSettings({ maxCostUsd: 9 }) // already decided here, in a later session
    s.resetSettingsCache()
    const after = s.seedSettings({ maxCostUsd: 2, voiceLanguage: 'de' })
    expect(after.maxCostUsd).toBe(9) // the stale copy must not win
    expect(after.voiceLanguage).toBe('de') // but an unset key is taken over
  })

  it('normalises nonsense rather than passing it on', () => {
    writeFileSync(FILE, JSON.stringify({ schema: 1, maxCostUsd: -5, maxRounds: 0, disabledTools: 'nope' }))
    s.resetSettingsCache()
    const got = s.getSettings()
    expect(got.maxCostUsd).toBe(0)
    expect(got.maxRounds).toBeGreaterThanOrEqual(1)
    expect(got.disabledTools).toEqual([])
  })

  it('keeps the preferred background a trimmed string, and nothing else', () => {
    s.setSettings({ preferredBackground: '  bafu-2026-v1 ' })
    s.resetSettingsCache()
    expect(s.getSettings().preferredBackground).toBe('bafu-2026-v1')
    writeFileSync(FILE, JSON.stringify({ schema: 1, preferredBackground: ['bafu-2026-v1'] }))
    s.resetSettingsCache()
    expect(s.getSettings().preferredBackground).toBe('')
  })

  it('survives an unreadable file with the defaults instead of an exception', () => {
    writeFileSync(FILE, '{ not json')
    s.resetSettingsCache()
    expect(s.getSettings().maxCostUsd).toBe(s.DEFAULTS.maxCostUsd)
  })
})

/** Real catalogue ids on purpose: since an unknown id reads as "not set" (see the block below),
 *  an invented one would be blanked before these assertions ever ran. The subject of these three
 *  is the inheritance rule, not the vocabulary, so the ids are incidental. */
const A = 'z-ai/glm-5.3'
const B = 'moonshotai/kimi-k3'
const C = 'deepseek/deepseek-v4.1-flash'

describe('splitting the sub-agent model into research and review', () => {
  it('lets a file written before the split keep governing the reviewer', () => {
    // It was one setting called "Research & review model", and it meant both. Moving somebody's
    // reviewer back to the default because a key appeared would change what their app does.
    writeFileSync(FILE, JSON.stringify({ schema: 1, researchModel: A }))
    s.resetSettingsCache()
    const got = s.getSettings()
    expect(got.researchModel).toBe(A)
    expect(got.reviewModel).toBe(A)
  })

  it('stops inheriting the moment a reviewer of its own is chosen — including "the default"', () => {
    s.setSettings({ researchModel: A, reviewModel: '' })
    s.resetSettingsCache()
    const got = s.getSettings()
    expect(got.researchModel).toBe(A)
    expect(got.reviewModel).toBe('') // explicitly stored empty = "use the built-in default"
  })

  it('keeps the two apart once they are set', () => {
    s.setSettings({ researchModel: A, reviewModel: B })
    s.resetSettingsCache()
    const got = s.getSettings()
    expect([got.researchModel, got.reviewModel]).toEqual([A, B])
  })

  it('reads a file that still names a summarising model without carrying the key on', () => {
    // The setting was retired (the chat model summarises now). A file written before
    // that still has the key; it must neither break the read nor resurface as a setting.
    writeFileSync(FILE, JSON.stringify({ schema: 2, researchModel: A, summaryModel: C }))
    s.resetSettingsCache()
    const got = s.getSettings() as unknown as Record<string, unknown>
    expect(got.researchModel).toBe(A)
    expect(got.summaryModel).toBeUndefined()
  })
})

describe('a stored model the catalogue does not carry', () => {
  /**
   * The reason this exists: `modelForActive` (ipc/shared.ts) lets ANY non-empty id through on
   * OpenRouter, and the transport passes it on. So without this, someone who removed a model from
   * their own models.json would see "Default" in Settings while research, review, summary, report
   * and import matching went on sending to the endpoint they had just deleted.
   */
  it('reads as "not set" in every one of the six roles', () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        schema: 1,
        model: 'gone/away',
        writerModel: 'gone/away',
        researchModel: 'gone/away',
        reviewModel: 'gone/away',
        matchModel: 'gone/away'
      })
    )
    s.resetSettingsCache()
    const got = s.getSettings()
    expect([got.model, got.writerModel, got.researchModel, got.reviewModel, got.matchModel]).toEqual([
      '',
      '',
      '',
      '',
      ''
    ])
  })

  it('is not written back, so the choice returns when the model does', () => {
    writeFileSync(FILE, JSON.stringify({ schema: 1, model: 'gone/away' }))
    s.resetSettingsCache()
    expect(s.getSettings().model).toBe('')
    expect(JSON.parse(readFileSync(FILE, 'utf-8')).model).toBe('gone/away')
  })

  it('leaves a stored choice from the OTHER provider alone', () => {
    // Inactive is not unknown: the id is in the catalogue, just under the other provider, and it
    // has to survive so switching back restores it.
    s.setSettings({ provider: 'openrouter', model: 'gpt-6.1-sol' })
    s.resetSettingsCache()
    expect(s.getSettings().model).toBe('gpt-6.1-sol')
  })
})

/** What schema number this version stamps on a file it writes. */
function currentSchema(): number {
  s.setSettings({})
  return JSON.parse(readFileSync(FILE, 'utf-8')).schema as number
}

describe('schema 2: the research-question default finally reaches existing files', () => {
  it('lifts a stored 4 to 6 — the old default, materialised, was never a choice', () => {
    // Runs repeatedly noted "effectively 4 (persisted); the default 6 applies only after a
    // reset": the raise to 6 never arrived anywhere.
    writeFileSync(FILE, JSON.stringify({ schema: 1, maxResearchQuestions: 4 }))
    s.resetSettingsCache()
    expect(s.getSettings().maxResearchQuestions).toBe(6)
    const raw = JSON.parse(readFileSync(FILE, 'utf-8'))
    expect(raw.maxResearchQuestions).toBe(6) // persisted, so it runs once, not on every read
    // Stamped with the CURRENT schema, not with 2: a file is migrated all the way forward in one
    // pass, so a later bump does not have to re-walk the earlier ones. Read from a file this
    // version writes rather than pinned to a literal — the claim is "all the way forward", and a
    // literal here goes red on every schema bump for a reason that is not the one being tested.
    expect(raw.schema).toBe(currentSchema())
  })

  it('leaves any other stored value alone — somebody typed that one', () => {
    writeFileSync(FILE, JSON.stringify({ schema: 1, maxResearchQuestions: 5 }))
    s.resetSettingsCache()
    expect(s.getSettings().maxResearchQuestions).toBe(5)
  })

  it('never migrates twice: a 4 chosen under schema 2 stays a 4', () => {
    writeFileSync(FILE, JSON.stringify({ schema: 2, maxResearchQuestions: 4 }))
    s.resetSettingsCache()
    expect(s.getSettings().maxResearchQuestions).toBe(4)
  })
})

describe('schema 4: the cost brake stops being the thing that ends normal work', () => {
  it('lifts a stored 2 to the new default — nobody who never opened the field chose it', () => {
    // Same shape as schema 2: a file written before the raise materialised the old default, so the
    // raise would otherwise reach only a fresh install.
    writeFileSync(FILE, JSON.stringify({ schema: 3, maxCostUsd: 2 }))
    s.resetSettingsCache()
    expect(s.getSettings().maxCostUsd).toBe(15)
    expect(JSON.parse(readFileSync(FILE, 'utf-8')).maxCostUsd).toBe(15) // persisted, so it runs once
  })

  it('leaves any other figure alone — including a deliberate 0, which means "no limit"', () => {
    writeFileSync(FILE, JSON.stringify({ schema: 3, maxCostUsd: 5 }))
    s.resetSettingsCache()
    expect(s.getSettings().maxCostUsd).toBe(5)
    writeFileSync(FILE, JSON.stringify({ schema: 3, maxCostUsd: 0 }))
    s.resetSettingsCache()
    expect(s.getSettings().maxCostUsd).toBe(0)
  })

  it('never migrates twice: a 2 chosen under schema 4 stays a 2', () => {
    writeFileSync(FILE, JSON.stringify({ schema: 4, maxCostUsd: 2 }))
    s.resetSettingsCache()
    expect(s.getSettings().maxCostUsd).toBe(2)
  })
})

describe('the transport group', () => {
  // The first nested group in the file: the overlay copies whatever object is stored, so every
  // field must be coerced afterwards — a hand-edited file is the case this pins.
  it('fills defaults when absent and coerces a hand-edited group field by field', () => {
    expect(s.getSettings().transport).toEqual(s.DEFAULTS.transport)
    writeFileSync(
      FILE,
      JSON.stringify({
        schema: 4,
        transport: {
          geocoder: 'google',
          glec: { road: 'no', air: false },
          railFactor: 'abc',
          perTurnCalls: 9999,
          dailyCalls: { geocode: -5 },
          recent: [
            { mode: 'teleport', from: 'a', to: 'b', km: 1 },
            { mode: 'road', from: 'a', to: 'b', km: '12.5', crossing_km: '41.8', crossing_unchecked: 'yes' }
          ]
        }
      })
    )
    s.resetSettingsCache()
    const t = s.getSettings().transport
    expect(t.geocoder).toBe('ors')
    expect(t.glec).toEqual({ road: true, air: false, rail: true, sea: true })
    expect(t.railFactor).toBe(1.2)
    expect(t.perTurnCalls).toBe(500)
    expect(t.dailyCalls).toEqual({ geocode: 0, route: 2000 })
    // The crossing survives a restart (a number, coerced); a non-boolean flag does not.
    expect(t.recent).toEqual([
      { mode: 'road', from: 'a', to: 'b', km: 12.5, at: '', geocoder: 'ors', crossing_km: 41.8 }
    ])
  })

  it('keeps the access legs of a recent entry with what makes them incomplete', () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        schema: 4,
        transport: {
          recent: [
            {
              mode: 'air',
              from: 'Heidelberg',
              to: 'Shanghai',
              km: 8941.9,
              access: {
                from: { code: 'FRA', km: 21, crossing_km: '100' },
                to: { code: 'SHA', failed: true },
                x: 1
              }
            }
          ]
        }
      })
    )
    s.resetSettingsCache()
    expect(s.getSettings().transport.recent[0].access).toEqual({
      from: { code: 'FRA', km: 21, crossing_km: 100 },
      to: { code: 'SHA', failed: true }
    })
  })

  it('is written as a whole and read back', () => {
    const next = { ...s.DEFAULTS.transport, geocoder: 'mapbox' as const, railFactor: 1.3 }
    expect(s.setSettings({ transport: next }).transport).toMatchObject({
      geocoder: 'mapbox',
      railFactor: 1.3
    })
    s.resetSettingsCache()
    expect(s.getSettings().transport.geocoder).toBe('mapbox')
  })
})

describe('the display group (V353)', () => {
  it('fills the defaults and clamps what the file holds', () => {
    expect(s.getSettings().display).toEqual(s.DEFAULTS.display)
    writeFileSync(
      FILE,
      JSON.stringify({
        schema: 4,
        display: { round: { edges: 99, properties: 'abc', io: 3 }, freeUnits: 'yes' }
      })
    )
    s.resetSettingsCache()
    // `parameters` and `results` are missing from the file, as from every file written before they
    // existed: they come back as their defaults, not as copies of `io`.
    // So are the two arrow-label switches: on, which is what the canvas showed before they existed.
    expect(s.getSettings().display).toEqual({
      round: { edges: 12, properties: 6, io: 3, parameters: 6, results: 4 },
      freeUnits: false,
      edgeAmounts: true,
      edgeProducts: true
    })
    s.setSettings({
      display: {
        round: { edges: 5, properties: 6, io: 6, parameters: 6, results: 3 },
        freeUnits: true,
        edgeAmounts: true,
        edgeProducts: false
      }
    })
    expect(JSON.parse(readFileSync(FILE, 'utf8')).display.round.edges).toBe(5)
    expect(JSON.parse(readFileSync(FILE, 'utf8')).display.round.results).toBe(3)
    expect(s.getSettings().display.freeUnits).toBe(true)
    expect(s.getSettings().display.edgeProducts).toBe(false)
  })
})

describe('the start page settings', () => {
  it('default to no news fetching and no recent models', () => {
    const got = s.getSettings()
    expect(got.newsAutoLoad).toBe(false)
    expect(got.recentModels).toEqual([])
  })

  it('reads anything but a literal true as "do not fetch the news"', () => {
    writeFileSync(FILE, JSON.stringify({ schema: 4, newsAutoLoad: 'yes' }))
    s.resetSettingsCache()
    expect(s.getSettings().newsAutoLoad).toBe(false)
    s.setSettings({ newsAutoLoad: true })
    expect(s.getSettings().newsAutoLoad).toBe(true)
  })

  it('turns a garbled recent list into an empty one', () => {
    writeFileSync(FILE, JSON.stringify({ schema: 4, recentModels: 'PET bottle' }))
    s.resetSettingsCache()
    expect(s.getSettings().recentModels).toEqual([])
    writeFileSync(
      FILE,
      JSON.stringify({
        schema: 4,
        recentModels: [1, null, { db: 'x' }, { project: 'p', db: 'x', openedAt: 'soon' }]
      })
    )
    s.resetSettingsCache()
    expect(s.getSettings().recentModels).toEqual([])
  })

  it('dedupes by project and model, sorts newest first and keeps ten', () => {
    const day = (d: number): string => new Date(Date.UTC(2026, 8, d)).toISOString()
    const many = Array.from({ length: 14 }, (_, i) => ({ project: 'p', db: `m${i}`, openedAt: day(i + 1) }))
    writeFileSync(
      FILE,
      JSON.stringify({
        schema: 4,
        recentModels: [
          ...many,
          // The same model opened again later — one entry, the newer stamp.
          { project: 'p', db: 'm0', openedAt: day(20) },
          // Same name in another project is another model.
          { project: 'q', db: 'm0', openedAt: day(19) }
        ]
      })
    )
    s.resetSettingsCache()
    const got = s.getSettings().recentModels
    expect(got).toHaveLength(10)
    expect(got[0]).toEqual({ project: 'p', db: 'm0', openedAt: day(20) })
    expect(got[1]).toEqual({ project: 'q', db: 'm0', openedAt: day(19) })
    expect(got[2].db).toBe('m13')
    expect(got.filter((r) => r.project === 'p' && r.db === 'm0')).toHaveLength(1)
  })
})

describe('a save that fails', () => {
  it('leaves the cache with the old values, so nothing reads a setting the file does not have', async () => {
    if (process.getuid?.() === 0) return // root writes anywhere; the guard cannot be provoked
    const { chmodSync } = await import('node:fs')
    s.setSettings({ zeroDataRetention: false })
    chmodSync(userData, 0o500)
    try {
      expect(() => s.setSettings({ zeroDataRetention: true })).toThrow()
    } finally {
      chmodSync(userData, 0o700)
    }
    expect(s.getSettings().zeroDataRetention).toBe(false)
  })
})

describe('the chat guardrails', () => {
  it('reads the approval switch and the per-model reasoning efforts defensively', () => {
    writeFileSync(
      FILE,
      JSON.stringify({
        schema: 4,
        chatApproval: 'yes please',
        reasoningEffort: { 'z-ai/glm-5.3': 'high', 'openai/gpt-6-luna': 'turbo', '': 'low', bad: 3 }
      })
    )
    s.resetSettingsCache()
    const got = s.getSettings()
    expect(got.chatApproval).toBe('irreversible')
    expect(got.reasoningEffort).toEqual({ 'z-ai/glm-5.3': 'high' })
    s.setSettings({ chatApproval: 'never', reasoningEffort: { 'z-ai/glm-5.3': 'xhigh' } })
    expect(s.getSettings().chatApproval).toBe('never')
    expect(s.getSettings().reasoningEffort).toEqual({ 'z-ai/glm-5.3': 'xhigh' })
  })
})
