/**
 * The allowlist is stored as the user's difference from our default. These pin the promise that
 * shape exists for: an untouched installation always runs on the current default, and every user
 * decision survives on top of it.
 */
import { describe, expect, it } from 'vitest'
import {
  addToAllowlist,
  allowlistIsDefault,
  DEFAULT_PROVIDER_ALLOWLIST,
  effectiveAllowlist,
  normaliseSlug,
  removeFromAllowlist,
  sanitiseSlugList
} from './providerAllowlist'

const none = { added: [], removed: [] }

describe('the provider allowlist', () => {
  it('is our default while nothing was changed', () => {
    expect(effectiveAllowlist(none)).toEqual([...DEFAULT_PROVIDER_ALLOWLIST])
    expect(allowlistIsDefault(true, none)).toBe(true)
    expect(allowlistIsDefault(false, none)).toBe(false)
  })

  it('keeps out the hosts our own runs showed breaking tool calls', () => {
    expect(DEFAULT_PROVIDER_ALLOWLIST).not.toContain('parasail')
    expect(DEFAULT_PROVIDER_ALLOWLIST).not.toContain('open-inference')
    // Lost required fields of GLM 5.3 Flash's tool calls in a run where another host lost none.
    expect(DEFAULT_PROVIDER_ALLOWLIST).not.toContain('primeintellect')
    // Every entry is a slug in canonical form, once.
    for (const s of DEFAULT_PROVIDER_ALLOWLIST) expect(normaliseSlug(s)).toBe(s)
    expect(new Set(DEFAULT_PROVIDER_ALLOWLIST).size).toBe(DEFAULT_PROVIDER_ALLOWLIST.length)
  })

  it('remembers a removed default host as removed, and an added one as added', () => {
    let d = removeFromAllowlist(none, 'novita')
    expect(d).toEqual({ added: [], removed: ['novita'] })
    expect(effectiveAllowlist(d)).not.toContain('novita')
    d = addToAllowlist(d, 'Groq ')
    expect(d).toEqual({ added: ['groq'], removed: ['novita'] })
    expect(effectiveAllowlist(d).at(-1)).toBe('groq')
    expect(allowlistIsDefault(true, d)).toBe(false)
  })

  it('brings a removed default host back by forgetting the removal, not by adding a copy', () => {
    const d = addToAllowlist(removeFromAllowlist(none, 'novita'), 'novita')
    expect(d).toEqual(none)
  })

  it('drops an added host without remembering it', () => {
    expect(removeFromAllowlist(addToAllowlist(none, 'groq'), 'groq')).toEqual(none)
  })

  it('lets a later default reach an installation, and keeps every decision the user made', () => {
    // Stored under one release's default…
    const before = ['a', 'b', 'c']
    const d = { added: ['groq'], removed: ['b'] }
    expect(effectiveAllowlist(d, before)).toEqual(['a', 'c', 'groq'])
    // …read under the next one: `c` dropped by us, `d` added by us, `b` still out because the user took
    // it out, and `groq` (added by the user) adopted into our default without appearing twice.
    const after = ['a', 'b', 'd', 'groq']
    expect(effectiveAllowlist(d, after)).toEqual(['a', 'd', 'groq'])
    // A third release drops `groq` again: the user's own addition stays.
    expect(effectiveAllowlist(d, ['a', 'b'])).toEqual(['a', 'groq'])
  })

  it('accepts slugs with a variant and refuses anything else', () => {
    expect(normaliseSlug('DeepInfra/FP8')).toBe('deepinfra/fp8')
    expect(normaliseSlug('google-vertex/us-east5')).toBe('google-vertex/us-east5')
    expect(normaliseSlug('')).toBe('')
    expect(normaliseSlug('two words')).toBe('')
    expect(normaliseSlug('../etc')).toBe('')
    expect(normaliseSlug('a//b')).toBe('')
    expect(normaliseSlug(42)).toBe('')
    expect(addToAllowlist(none, 'not a slug')).toBe(none)
  })

  it('reads a stored list defensively: slugs only, once each, capped', () => {
    expect(sanitiseSlugList(['groq', 'GROQ', 7, 'bad slug', null, 'together'])).toEqual(['groq', 'together'])
    expect(sanitiseSlugList('groq')).toEqual([])
    expect(sanitiseSlugList(Array.from({ length: 500 }, (_, i) => `p${i}`))).toHaveLength(200)
  })
})
