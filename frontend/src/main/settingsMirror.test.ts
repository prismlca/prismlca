/**
 * The settings mirror — one list, run everywhere.
 *
 * The bug this pins: the mirror calls used to be written out at each site, and `settings:seed` ran
 * only two of the four — a user upgrading with a stored `minThroughput` or dictionary choice lost
 * both until the next settings write. With one `applySettings`, "seed and set apply the same
 * mirrors" holds structurally; this test keeps the list itself from silently shrinking.
 */
import { describe, expect, it, vi } from 'vitest'

const zdr = vi.fn()
const throughput = vi.fn()
const provider = vi.fn()
const spellcheck = vi.fn()
const allowlist = vi.fn()

vi.mock('./ai/providers/openrouter', () => ({
  setZeroDataRetention: (...a: unknown[]) => zdr(...a),
  setMinThroughput: (...a: unknown[]) => throughput(...a),
  setProviderAllowlist: (...a: unknown[]) => allowlist(...a)
}))
vi.mock('./ai/providers/state', () => ({ setActiveProvider: (...a: unknown[]) => provider(...a) }))
vi.mock('./spellcheck', () => ({ applySpellcheckLanguages: (...a: unknown[]) => spellcheck(...a) }))

const { applySettings } = await import('./settingsMirror')

describe('applySettings', () => {
  it('feeds every module-state mirror from one call', () => {
    applySettings({
      zeroDataRetention: false,
      zdrExceptAnthropic: true,
      zdrExceptOpenai: false,
      zdrExceptGoogle: true,
      minThroughput: 42,
      provider: 'openai',
      spellcheckLanguages: ['de-DE'],
      providerAllowlistOn: true,
      providerAllowlistAdded: ['groq'],
      providerAllowlistRemoved: ['novita']
    } as never)
    // The vendor exceptions ride with the switch: mirrored in the same call, so main can never
    // hold the master flag from one settings write and the exceptions from another.
    expect(zdr).toHaveBeenCalledWith(false, { anthropic: true, openai: false, google: true })
    expect(throughput).toHaveBeenCalledWith(42)
    expect(provider).toHaveBeenCalledWith('openai')
    expect(spellcheck).toHaveBeenCalledWith(['de-DE'])
    // The list main sends is the default with the user's difference applied.
    const sent = allowlist.mock.calls[0][0] as string[]
    expect(sent).toContain('groq')
    expect(sent).not.toContain('novita')
    expect(sent).toContain('anthropic')
  })

  it('mirrors a switched-off allowlist as no restriction at all', () => {
    allowlist.mockClear()
    applySettings({
      provider: 'openrouter',
      spellcheckLanguages: [],
      providerAllowlistOn: false,
      providerAllowlistAdded: [],
      providerAllowlistRemoved: []
    } as never)
    expect(allowlist).toHaveBeenCalledWith(null)
  })
})
