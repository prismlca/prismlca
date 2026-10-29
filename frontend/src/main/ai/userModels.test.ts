import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadUserModels, writeUserModels } from './userModels'
import type { AiModel } from './models'

/**
 * `models.json` is the one place a user hands PrismLCA a model id that then decides where a prompt —
 * which can carry licensed ecoinvent data — is sent. So the interesting cases here are the
 * refusals, not the happy path. Every limit traces to a finding of an adversarial review of the
 * custom-model design.
 */
const BUILTIN = new Set(['z-ai/glm-5.3', 'anthropic/claude-opus-5.5'])
const dir = mkdtempSync(join(tmpdir(), 'prism-usermodels-'))

let n = 0
/** Write a models.json and read it back. */
function load(body: unknown): ReturnType<typeof loadUserModels> {
  const path = join(dir, `m${n++}.json`)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  return loadUserModels(BUILTIN, path)
}
const one = (model: Record<string, unknown>): ReturnType<typeof loadUserModels> =>
  load({ version: 1, models: [model] })

/** A minimal accepted entry, as the Add-model dialog builds one. */
const entry = (id: string): AiModel =>
  ({ id, label: id.toUpperCase(), vision: false, contextTokens: 128_000 }) as AiModel

/** Write the entries to `path` and hand the path back, for a read straight after. */
function writeAnd(path: string, models: AiModel[]): string {
  writeUserModels(path, models)
  return path
}

describe('loading models.json', () => {
  it('takes a valid entry and fills the defaults that keep it safe', () => {
    const { models, problems } = one({ id: 'vendor/new-model' })
    expect(problems).toEqual([])
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'vendor/new-model',
      label: 'vendor/new-model',
      provider: 'openrouter',
      // null = the parameter is not sent at all. Anthropic answers HTTP 400 to a value.
      temperature: null,
      vision: false,
      contextTokens: 128_000,
      userAdded: true
    })
  })

  it('never takes ratings from the file, however they are written', () => {
    const { models } = one({ id: 'vendor/m', intelligence: 99, agentic: 99 })
    expect(models[0].intelligence).toBeNull()
    expect(models[0].agentic).toBeNull()
  })

  it('refuses to override a model PrismLCA already carries', () => {
    const { models, problems } = one({ id: 'z-ai/glm-5.3', label: 'mine' })
    expect(models).toEqual([])
    expect(problems[0]).toMatch(/already in PrismLCA/)
  })

  it('rejects ids that could steer the endpoints URL, and keeps :free working', () => {
    for (const id of [
      '../../etc/passwd',
      'vendor/m?x=1',
      'vendor/m#f',
      'vendor /m',
      'noslash',
      'vendor/m '
    ]) {
      expect(one({ id }).models, id).toEqual([])
    }
    expect(one({ id: 'minimax/minimax-m3:free' }).models).toHaveLength(1)
  })

  it('throws the whole file away on a reserved key, and leaves Object.prototype alone', () => {
    const { models, problems } = load('{"version":1,"models":[{"id":"a/b","__proto__":{"polluted":1}}]}')
    expect(models).toEqual([])
    expect(problems[0]).toMatch(/reserved key/)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('keeps the good entries when one is bad, and says which', () => {
    const { models, problems } = load({
      version: 1,
      models: [{ id: 'a/good' }, { id: 'bad id' }, { id: 'b/good' }]
    })
    expect(models.map((m) => m.id)).toEqual(['a/good', 'b/good'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/not a valid OpenRouter id/)
  })

  it('skips a duplicate id rather than letting the last one win silently', () => {
    const { models, problems } = load({
      version: 1,
      models: [
        { id: 'a/b', label: 'first' },
        { id: 'a/b', label: 'second' }
      ]
    })
    expect(models).toHaveLength(1)
    expect(models[0].label).toBe('first')
    expect(problems[0]).toMatch(/appears twice/)
  })

  it('bounds the values it accepts', () => {
    expect(one({ id: 'a/b', temperature: 5 }).models).toEqual([])
    // A quoted number is the mistake that actually reaches this file; NaN cannot, JSON writes null.
    expect(one({ id: 'a/b', temperature: '0.7' }).models).toEqual([])
    expect(one({ id: 'a/b', contextTokens: 10 }).models).toEqual([])
    expect(one({ id: 'a/b', contextTokens: 1.5 }).models).toEqual([])
    // Below PrismLCA's own output floor (20 000 tokens on every request) the model could never be
    // given a valid request, so the entry is refused rather than offered and left to fail.
    expect(one({ id: 'a/b', contextTokens: 16_384 }).models).toEqual([])
    expect(one({ id: 'a/b', temperature: 0.7, contextTokens: 200_000 }).models[0]).toMatchObject({
      temperature: 0.7,
      contextTokens: 200_000
    })
  })

  it('reads at most fifty entries and says so', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `v/m${i}` }))
    const { models, problems } = load({ version: 1, models: many })
    expect(models).toHaveLength(50)
    expect(problems[0]).toMatch(/only the first 50/)
  })

  it('needs a format version, so the format can ever change', () => {
    expect(load({ models: [{ id: 'a/b' }] }).problems[0]).toMatch(/needs "version": 1/)
    expect(load({ version: 2, models: [] }).problems[0]).toMatch(/needs "version": 1/)
  })

  it('survives a broken file without throwing, and says what is wrong', () => {
    const { models, problems } = load('{ not json')
    expect(models).toEqual([])
    expect(problems[0]).toMatch(/not valid JSON/)
  })

  it('treats an absent file as the normal case, not a problem', () => {
    const { models, problems } = loadUserModels(BUILTIN, join(dir, 'does-not-exist.json'))
    expect(models).toEqual([])
    expect(problems).toEqual([])
  })

  it('freezes the entries, because a run captures its model and reuses it', () => {
    const m = one({ id: 'a/b' }).models[0]
    expect(Object.isFrozen(m)).toBe(true)
  })

  it('derives explicitCache from the vendor instead of taking it', () => {
    expect(one({ id: 'anthropic/some-new-claude', explicitCache: false }).models[0].explicitCache).toBe(true)
    expect(one({ id: 'vendor/other', explicitCache: true }).models[0].explicitCache).toBeUndefined()
  })
})

/**
 * Everything below was added after a second adversarial review found each of these getting
 * through — or, in the first case, taking the whole file down with it.
 */
describe('the ways a hand-edited file goes wrong', () => {
  it('survives an id that cannot even be turned into a string', () => {
    // `String({toString: 0})` throws. That throw escaped the loader, the Electron wrapper caught
    // it, and the result was zero models AND zero problems — every role silently unset.
    const { models, problems } = load({
      version: 1,
      models: [{ id: 'a/good' }, { id: { toString: 0 } }, { id: 'b/good' }]
    })
    expect(models.map((m) => m.id)).toEqual(['a/good', 'b/good'])
    expect(problems).toHaveLength(1)
  })

  it('rejects dot segments, which survive URL encoding and re-point the request', () => {
    // encodeURIComponent leaves "." alone, so /models/vendor/../endpoints normalises to
    // /models/endpoints — a different resource, on an authenticated request.
    expect(one({ id: 'vendor/..' }).models).toEqual([])
    expect(one({ id: 'vendor/.' }).models).toEqual([])
  })

  it('catches a reserved key that is spelled with an escape', () => {
    const { models, problems } = load('{"version":1,"models":[{"id":"a/b","\\u005f_proto__":{"x":1}}]}')
    expect(models).toEqual([])
    expect(problems[0]).toMatch(/reserved key/)
  })

  it('refuses a wrongly typed optional field instead of quietly replacing it', () => {
    // "true" as text used to become vision:false — a model that never gets the screenshot.
    expect(one({ id: 'a/b', vision: 'true' }).problems[0]).toMatch(/vision must be true or false/)
    expect(one({ id: 'a/b', label: 42 }).problems[0]).toMatch(/label must be text/)
    expect(one({ id: 'a/b', descriptor: 'x'.repeat(81) }).problems[0]).toMatch(/descriptor must be text/)
  })

  it('leaves the descriptor empty so the picker does not say it twice', () => {
    // The pickers append "— added by you"; a default of the same words read "added by you —
    // added by you".
    expect(one({ id: 'a/b' }).models[0].descriptor).toBe('')
  })

  it('tells a read failure apart from an absent file', () => {
    // A directory where the file should be: not "you have no models.json", a problem to report.
    const { models, problems } = loadUserModels(BUILTIN, dir)
    expect(models).toEqual([])
    expect(problems[0]).toMatch(/not a regular file/)
  })
})

describe('writing the file back', () => {
  /**
   * The dialog writes, then the SAME loader reads it back and what it accepted becomes the
   * catalogue. So the round trip is the contract: anything the dialog can put in the file must
   * survive a restart unchanged, or the two paths have drifted.
   */
  it('round-trips an entry through write and read', () => {
    const path = join(dir, 'roundtrip.json')
    const first = loadUserModels(BUILTIN, writeAnd(path, [entry('a/one'), entry('b/two')]))
    expect(first.problems).toEqual([])
    expect(first.models.map((m) => m.id)).toEqual(['a/one', 'b/two'])

    // …and again from what the writer produced, unchanged.
    writeUserModels(path, [...first.models])
    const second = loadUserModels(BUILTIN, path)
    expect(second.problems).toEqual([])
    expect(second.models).toEqual(first.models)
  })

  it('keeps the file hand-editable: no derived fields written back', () => {
    const path = join(dir, 'clean.json')
    writeUserModels(path, loadUserModels(BUILTIN, writeAnd(path, [entry('a/one')])).models)
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    expect(Object.keys(raw)).toEqual(['version', 'models'])
    // provider, ratings, userAdded and explicitCache are recomputed on load — writing them would
    // invite someone to edit a value the loader then ignores. A false `vision` is left out too:
    // the default already says it, and a file full of defaults is harder to read, not easier.
    expect(Object.keys(raw.models[0]).sort()).toEqual(['contextTokens', 'id', 'label'])
    const withVision = join(dir, 'vision.json')
    writeUserModels(withVision, [{ ...entry('a/one'), vision: true }])
    expect(JSON.parse(readFileSync(withVision, 'utf-8')).models[0].vision).toBe(true)
  })

  it('writes atomically, so a reader never catches half a file', () => {
    const path = join(dir, 'atomic.json')
    writeUserModels(path, [])
    expect(existsSync(`${path}.tmp`)).toBe(false)
  })
})

describe("OpenRouter's tilde aliases", () => {
  /**
   * `~anthropic/claude-fable-latest` and twelve siblings are real, listed ids — the tilde is how
   * OpenRouter marks a moving pointer at whichever model is current. The first grammar refused
   * them, so the Add-model dialog offered all thirteen and then rejected them on click. Found by
   * opening the dialog in the running app; no test would have.
   */
  it('accepts a leading tilde', () => {
    for (const id of ['~anthropic/claude-fable-latest', '~z-ai/glm-latest', '~openai/gpt-mini-latest']) {
      expect(
        one({ id }).models.map((m) => m.id),
        id
      ).toEqual([id])
    }
  })

  it('still refuses everything the tilde could have smuggled in', () => {
    for (const id of ['~/etc/passwd', '~~vendor/m', '~vendor/../x', '~vendor/m?x=1', '~']) {
      expect(one({ id }).models, id).toEqual([])
    }
  })
})
