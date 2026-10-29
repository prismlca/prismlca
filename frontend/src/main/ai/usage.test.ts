import { describe, expect, it, vi } from 'vitest'

// usage.ts reaches for electron's userData path at write time; the migration itself is pure, which
// is the part worth testing (a botched migration silently wipes real spending history).
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/prism-usage-test' } }))

const { migrate } = await import('./usage')

describe('usage ledger migration', () => {
  it('carries an old cost-only ledger over instead of discarding it', () => {
    // Before token counts existed an entry was a bare USD number.
    const out = migrate({
      '2026-06': { 'anthropic/claude-sonnet-5.5': 1.25, 'deepseek/deepseek-v4.1-flash': 0.01 }
    })
    expect(out['2026-06']['anthropic/claude-sonnet-5.5']).toEqual({
      cost: 1.25,
      prompt: 0,
      cached: 0,
      calls: 0
    })
    expect(out['2026-06']['deepseek/deepseek-v4.1-flash'].cost).toBe(0.01)
  })

  it('keeps a current entry as it is', () => {
    const entry = { cost: 0.5, prompt: 1000, cached: 800, calls: 3 }
    expect(
      migrate({ '2026-07': { 'deepseek/deepseek-v4.1-flash': entry } })['2026-07'][
        'deepseek/deepseek-v4.1-flash'
      ]
    ).toEqual(entry)
  })

  it('fills in fields a partially written entry is missing', () => {
    const out = migrate({ '2026-07': { m: { cost: 0.2 } } })
    expect(out['2026-07'].m).toEqual({ cost: 0.2, prompt: 0, cached: 0, calls: 0 })
  })

  it('survives junk without throwing — a corrupt ledger must not break a chat turn', () => {
    expect(migrate(null)).toEqual({})
    expect(migrate('nonsense')).toEqual({})
    expect(migrate({ '2026-07': 'not an object' })).toEqual({})
    expect(migrate({ '2026-07': { m: null } })).toEqual({ '2026-07': {} })
  })
})

describe('usage ledger fields', () => {
  it('carries output tokens through a reload, and keeps "not measured" out of the numbers', () => {
    // V127's other half, seen again in a real run: a correction round billed 13× as
    // much per prompt token as the chapter it corrected, and the difference sat entirely in output
    // and reasoning tokens that nothing recorded.
    const out = migrate({
      '2026-08': {
        'deepseek/deepseek-v4.1-flash': {
          cost: 0.27,
          prompt: 328236,
          cached: 251662,
          completion: 41000,
          calls: 27,
          categories: {
            reporting: { cost: 0.27, prompt: 328236, cached: 251662, completion: 41000, calls: 27 }
          }
        }
      }
    })
    const entry = out['2026-08']['deepseek/deepseek-v4.1-flash']
    expect(entry.completion).toBe(41000)
    expect(entry.categories?.reporting?.completion).toBe(41000)
    // An older entry has none, and must not grow a fabricated zero.
    const old = migrate({ '2026-07': { m: { cost: 1, prompt: 10, cached: 0, calls: 1 } } })
    expect('completion' in old['2026-07'].m).toBe(false)
  })
})
