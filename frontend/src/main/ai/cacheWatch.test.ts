import { describe, expect, it } from 'vitest'
import { CACHE_TTL_MS, createCacheWatch, type CacheObservation } from './cacheWatch'

/** Feed a run's rounds and collect what each one raised. */
const run = (rounds: CacheObservation[]): Array<string | null> => {
  const w = createCacheWatch()
  return rounds.map((r) => w.observe(r))
}

describe('the cache watch', () => {
  it('says nothing while the cache grows with the conversation', () => {
    expect(
      run([
        { prompt: 42_000, cached: 0 },
        { prompt: 61_000, cached: 41_900 },
        { prompt: 80_000, cached: 60_800 },
        { prompt: 95_000, cached: 79_700 },
        { prompt: 120_000, cached: 94_900 }
      ])
    ).toEqual([null, null, null, null, null])
  })

  it('raises "dropped" when a round reads nothing after earlier rounds did — once per drop, and says when it is over', () => {
    expect(
      run([
        { prompt: 50_000, cached: 30_000 },
        { prompt: 125_600, cached: 0 },
        { prompt: 130_000, cached: 0 },
        { prompt: 140_000, cached: 129_000 },
        { prompt: 150_000, cached: 0 }
      ])
    ).toEqual([null, 'dropped', null, 'recovered', 'dropped'])
  })

  it('never warns for a model or route that does not cache at all', () => {
    const rounds = Array.from({ length: 12 }, (_, i) => ({ prompt: 20_000 + i * 15_000, cached: 0 }))
    expect(run(rounds).every((a) => a === null)).toBe(true)
  })

  it('raises "stuck" when the hit stays the same for three rounds while the prompt grows', () => {
    expect(
      run([
        { prompt: 70_000, cached: 42_236 },
        { prompt: 92_000, cached: 42_236 },
        { prompt: 115_000, cached: 42_236 },
        { prompt: 140_000, cached: 42_236 },
        { prompt: 160_000, cached: 42_236 }
      ])
    ).toEqual([null, null, 'stuck', null, null])
  })

  it('does not call a hit "stuck" when the prompt barely grew', () => {
    expect(
      run([
        { prompt: 70_000, cached: 42_236 },
        { prompt: 70_400, cached: 42_236 },
        { prompt: 70_900, cached: 42_236 }
      ])
    ).toEqual([null, null, null])
  })

  it('says "stuck" again only after the figure moved, and that it moved', () => {
    expect(
      run([
        { prompt: 70_000, cached: 42_000 },
        { prompt: 90_000, cached: 42_000 },
        { prompt: 110_000, cached: 42_000 },
        { prompt: 130_000, cached: 129_000 },
        { prompt: 150_000, cached: 129_000 },
        { prompt: 170_000, cached: 129_000 },
        { prompt: 190_000, cached: 129_000 }
      ])
    ).toEqual([null, null, 'stuck', 'recovered', null, 'stuck', null])
  })

  it('takes a miss after a long pause for an expired cache, not a fault', () => {
    expect(
      run([
        { prompt: 50_000, cached: 30_000 },
        { prompt: 80_000, cached: 0, idleMs: CACHE_TTL_MS + 1 },
        { prompt: 90_000, cached: 0, idleMs: 2_000 }
      ])
    ).toEqual([null, null, 'dropped'])
  })

  it('ignores prompts too small to be cached', () => {
    expect(
      run([
        { prompt: 1_500, cached: 1_024 },
        { prompt: 1_800, cached: 0 }
      ])
    ).toEqual([null, null])
  })

  it('starts the "stuck" count over after a compaction', () => {
    const w = createCacheWatch()
    w.observe({ prompt: 70_000, cached: 42_000 })
    w.observe({ prompt: 90_000, cached: 42_000 })
    w.reset()
    expect(w.observe({ prompt: 60_000, cached: 42_000 })).toBeNull()
    expect(w.observe({ prompt: 80_000, cached: 42_000 })).toBeNull()
    expect(w.observe({ prompt: 100_000, cached: 42_000 })).toBe('stuck')
  })

  it('ends "stuck" with a hit after a miss that raised nothing (an expired cache)', () => {
    expect(
      run([
        { prompt: 70_000, cached: 42_000 },
        { prompt: 90_000, cached: 42_000 },
        { prompt: 110_000, cached: 42_000 },
        { prompt: 130_000, cached: 0, idleMs: CACHE_TTL_MS + 1 },
        { prompt: 150_000, cached: 129_000 }
      ])
    ).toEqual([null, null, 'stuck', null, 'recovered'])
  })

  it('does not call a stall over when the cached figure only fell', () => {
    expect(
      run([
        { prompt: 70_000, cached: 42_000 },
        { prompt: 90_000, cached: 42_000 },
        { prompt: 110_000, cached: 42_000 },
        { prompt: 130_000, cached: 2_048 },
        { prompt: 150_000, cached: 42_000 },
        { prompt: 170_000, cached: 60_000 }
      ])
    ).toEqual([null, null, 'stuck', null, null, 'recovered'])
  })

  it('keeps the higher bar when a stall falls to a lower plateau', () => {
    const cached = [42_000, 42_000, 42_000, 2_048, 2_048, 2_048, 42_000, 60_000]
    expect(run(cached.map((c, i) => ({ prompt: 70_000 + i * 20_000, cached: c })))).toEqual([
      null,
      null,
      'stuck',
      null,
      null,
      'stuck',
      null,
      'recovered'
    ])
  })

  it('says "stuck" again when hits return after a miss inside a stall, and "recovered" only past its bar', () => {
    const cached = [42_000, 42_000, 42_000, 0, 42_000, 50_000]
    expect(run(cached.map((c, i) => ({ prompt: 70_000 + i * 20_000, cached: c })))).toEqual([
      null,
      null,
      'stuck',
      'dropped',
      'stuck',
      'recovered'
    ])
  })

  it('measures a recovery from a stall against the first hit after a compaction', () => {
    const w = createCacheWatch()
    w.observe({ prompt: 70_000, cached: 42_000 })
    w.observe({ prompt: 90_000, cached: 42_000 })
    expect(w.observe({ prompt: 110_000, cached: 42_000 })).toBe('stuck')
    w.reset()
    // The rewritten conversation is shorter: its head alone is no recovery, its growth is.
    expect(w.observe({ prompt: 30_000, cached: 12_000 })).toBeNull()
    expect(w.observe({ prompt: 45_000, cached: 29_000 })).toBe('recovered')
  })

  it('lets the round right after a compaction miss, and reports a miss after that', () => {
    const w = createCacheWatch()
    w.observe({ prompt: 70_000, cached: 60_000 })
    w.reset()
    expect(w.observe({ prompt: 50_000, cached: 0 })).toBeNull()
    expect(w.observe({ prompt: 55_000, cached: 0 })).toBe('dropped')
  })
})
