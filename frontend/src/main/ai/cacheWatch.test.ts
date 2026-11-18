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

  it('says "missed" for one round that reads nothing after earlier rounds did, "dropped" for the second in a row, and when it is over', () => {
    expect(
      run([
        { prompt: 50_000, cached: 30_000 },
        { prompt: 125_600, cached: 0 },
        { prompt: 130_000, cached: 0 },
        { prompt: 135_000, cached: 0 },
        { prompt: 140_000, cached: 134_900 },
        { prompt: 150_000, cached: 0 },
        { prompt: 160_000, cached: 149_800 }
      ])
    ).toEqual([null, 'missed', 'dropped', null, 'recovered', 'missed', 'recovered'])
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
    ).toEqual([null, null, 'missed'])
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
        { prompt: 170_000, cached: 149_000 }
      ])
    ).toEqual([null, null, 'stuck', null, null, 'recovered'])
  })

  it('keeps the higher bar when a stall falls to a lower plateau', () => {
    const cached = [42_000, 42_000, 42_000, 2_048, 2_048, 2_048, 42_000, 189_000]
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
    const cached = [42_000, 42_000, 42_000, 0, 42_000, 149_000]
    expect(run(cached.map((c, i) => ({ prompt: 70_000 + i * 20_000, cached: c })))).toEqual([
      null,
      null,
      'stuck',
      'missed',
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
    expect(w.observe({ prompt: 55_000, cached: 0 })).toBe('missed')
  })

  // Figures of a real run (Mistral Large 4 via OpenRouter): after rounds served in full, an endpoint
  // answered from the state it had six rounds earlier.
  it('says "partial" when a round is served far less than the round before had sent, and when that is over', () => {
    expect(
      run([
        { prompt: 212_801, cached: 211_456 },
        { prompt: 217_257, cached: 72_192 },
        { prompt: 218_890, cached: 217_088 }
      ])
    ).toEqual([null, 'partial', 'recovered'])
  })

  it('keeps a partial hit open while the hit stays as short, and while a round cannot be measured', () => {
    expect(
      run([
        { prompt: 212_801, cached: 211_456 },
        { prompt: 217_257, cached: 72_192 },
        // The same short figure again: no new alarm (a stall has its own rule), and no recovery either.
        { prompt: 218_890, cached: 72_192 },
        // Figures that add up several passes say nothing about the cache's coverage — neither the
        // round's own nor, for the round after it, those of the round before.
        { prompt: 260_000, cached: 250_000, aggregate: true },
        { prompt: 261_000, cached: 259_900 },
        { prompt: 262_000, cached: 260_900 }
      ])
    ).toEqual([null, 'partial', null, null, null, 'recovered'])
  })

  it('says "partial" for an older state a tenth short, and for a hit on the fixed head alone', () => {
    expect(
      run([
        { prompt: 239_888, cached: 238_848 },
        { prompt: 250_948, cached: 212_736 }
      ])
    ).toEqual([null, 'partial'])
    expect(
      run([
        { prompt: 227_631, cached: 220_160 },
        { prompt: 239_668, cached: 23_680 }
      ])
    ).toEqual([null, 'partial'])
  })

  it('says "partial" again for each such round, and for one that follows a miss', () => {
    expect(
      run([
        { prompt: 29_219, cached: 29_184 },
        { prompt: 45_881, cached: 0 },
        { prompt: 46_526, cached: 29_184 },
        { prompt: 70_000, cached: 30_000 },
        { prompt: 72_000, cached: 69_900 }
      ])
    ).toEqual([null, 'missed', 'partial', 'partial', 'recovered'])
  })

  it('does not call a hit "partial" for a few thousand tokens short of the round before', () => {
    expect(
      run([
        { prompt: 46_526, cached: 46_336 },
        { prompt: 52_089, cached: 46_336 + 64 },
        { prompt: 72_438, cached: 45_824 }
      ])
    ).toEqual([null, null, null])
  })

  it('measures no "partial" against a round whose figures add up several passes, nor for such a round', () => {
    expect(
      run([
        { prompt: 128_723, cached: 119_200, aggregate: true },
        { prompt: 75_601, cached: 68_495 },
        { prompt: 140_000, cached: 30_000, aggregate: true }
      ])
    ).toEqual([null, null, null])
  })

  it('measures no "partial" after a long pause or right after a compaction', () => {
    expect(
      run([
        { prompt: 100_000, cached: 99_000 },
        { prompt: 110_000, cached: 20_000, idleMs: CACHE_TTL_MS + 1 }
      ])
    ).toEqual([null, null])
    const w = createCacheWatch()
    w.observe({ prompt: 100_000, cached: 99_000 })
    w.reset()
    expect(w.observe({ prompt: 110_000, cached: 20_000 })).toBeNull()
    expect(w.observe({ prompt: 120_000, cached: 109_000 })).toBeNull()
  })

  it('says "partial" when a stall ends with a figure that grew but stays far short', () => {
    const cached = [42_000, 42_000, 42_000, 60_000]
    expect(run(cached.map((c, i) => ({ prompt: 70_000 + i * 20_000, cached: c })))).toEqual([
      null,
      null,
      'stuck',
      'partial'
    ])
  })
})
