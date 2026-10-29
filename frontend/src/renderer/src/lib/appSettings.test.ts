import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage } from '../test/prism'

/**
 * The app-settings store, and the one-shot migration inside it.
 *
 * This module reads `localStorage` at import time (`legacy()` builds the first snapshot), so the
 * globals have to exist BEFORE the import — hence the dynamic `await import()` in each test rather
 * than a top-level one. Same ordering `lib/modelView.test.ts` uses.
 */

const ZDR = 'prism.ai.zeroDataRetention'

/** A fresh module instance with a fresh browser store and a recording bridge. */
async function load(opts: { stored?: Record<string, unknown>; fromMain?: Record<string, unknown> } = {}) {
  vi.resetModules()
  const ls = memoryStorage()
  for (const [k, v] of Object.entries(opts.stored ?? {})) ls.setItem(k, JSON.stringify(v))

  const sets: Record<string, unknown>[] = []
  const seeds: Record<string, unknown>[] = []
  let file: Record<string, unknown> = { zeroDataRetention: true, ...(opts.fromMain ?? {}) }

  vi.stubGlobal('localStorage', ls)
  vi.stubGlobal('window', {
    localStorage: ls,
    addEventListener: () => {},
    removeEventListener: () => {},
    prism: {
      appSettings: {
        get: async () => ({ ...file }),
        set: async (patch: Record<string, unknown>) => {
          sets.push(patch)
          file = { ...file, ...patch }
          return { ...file }
        },
        seed: async (legacy: Record<string, unknown>) => {
          seeds.push(legacy)
          return { ...file }
        }
      }
    }
  })

  const mod = await import('./appSettings')
  return { mod, sets, seeds, ls, file: () => file }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('setAS — write-through with an optimistic local value', () => {
  it('publishes immediately, then takes main’s normalised answer', async () => {
    const { mod, sets } = await load()
    // Main clamps; the store must end up on main's number, not the one that was asked for.
    const seen: unknown[] = []
    mod.setAS({ maxTokens: 999_999 })
    seen.push(mod.getAS().maxTokens) // optimistic, before the round trip
    await Promise.resolve()
    await Promise.resolve()

    expect(seen[0]).toBe(999_999)
    expect(sets).toEqual([{ maxTokens: 999_999 }])
  })

  /** A bridge whose `set` fails for the keys named, and whose `get` answers with the file (or fails). */
  async function failing(opts: { refuse: string[]; getFails?: boolean }) {
    vi.resetModules()
    const ls = memoryStorage()
    let file: Record<string, unknown> = { zeroDataRetention: false, maxRounds: 10 }
    const release: Array<() => void> = []
    vi.stubGlobal('localStorage', ls)
    vi.stubGlobal('window', {
      localStorage: ls,
      addEventListener: () => {},
      removeEventListener: () => {},
      prism: {
        appSettings: {
          get: async () => {
            if (opts.getFails) throw new Error('main is not listening')
            return { ...file }
          },
          set: async (patch: Record<string, unknown>) => {
            if (Object.keys(patch).some((k) => opts.refuse.includes(k))) throw new Error('disk full')
            file = { ...file, ...patch }
            // Held until the test lets it go, so a later write can be in flight across the failure.
            await new Promise<void>((r) => release.push(r))
            return { ...file }
          },
          seed: async () => ({ ...file })
        }
      }
    })
    const mod = await import('./appSettings')
    return { mod, release, file: () => file }
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('goes back to what main stored when a write is refused, and says so', async () => {
    // The case it exists for: zero data retention switched ON, main could not save it and went on
    // without it — the switch must not keep claiming otherwise (the renderer side of main refusing a write it
    // cannot save).
    const { mod } = await failing({ refuse: ['zeroDataRetention'] })
    mod.setAS({ zeroDataRetention: true })
    expect(mod.getAS().zeroDataRetention).toBe(true) // optimistic, before the answer
    await settle()
    expect(mod.getAS().zeroDataRetention).toBe(false)
  })

  it('keeps a later write that is still in flight when an earlier one is refused', async () => {
    const { mod, release } = await failing({ refuse: ['zeroDataRetention'] })
    mod.setAS({ zeroDataRetention: true })
    mod.setAS({ maxRounds: 42 }) // held in flight
    await settle()
    expect(mod.getAS().zeroDataRetention).toBe(false)
    expect(mod.getAS().maxRounds).toBe(42)
    release.forEach((r) => r())
    await settle()
    expect(mod.getAS().maxRounds).toBe(42)
  })

  it('keeps the shown value when main cannot be asked either', async () => {
    const { mod } = await failing({ refuse: ['maxRounds'], getFails: true })
    mod.setAS({ maxRounds: 42 })
    await settle()
    expect(mod.getAS().maxRounds).toBe(42)
  })

  it('merges a patch instead of replacing the settings', async () => {
    // `setAS` takes a Partial, and every caller in the app passes exactly one key. If it replaced
    // rather than merged, changing the model would silently reset the cost brake.
    const { mod } = await load()
    const before = mod.getAS().maxCostUsd
    mod.setAS({ model: 'z-ai/glm-5.3' })
    expect(mod.getAS().model).toBe('z-ai/glm-5.3')
    expect(mod.getAS().maxCostUsd).toBe(before)
  })
})

describe('the zero-data-retention migration', () => {
  it('carries the browser value into the file exactly once, then drops the key', async () => {
    // The situation it exists for: the switch was toggled OFF while the file still said true, so the
    // two disagreed — and the browser copy was the one actually routing requests.
    const { mod, sets, ls } = await load({ stored: { [ZDR]: false }, fromMain: { zeroDataRetention: true } })
    await mod.initAppSettings()

    expect(sets).toContainEqual({ zeroDataRetention: false })
    expect(ls.getItem(ZDR)).toBeNull()
    expect(mod.getAS().zeroDataRetention).toBe(false)

    // Second start: nothing left to carry, and no write.
    const before = sets.length
    await mod.initAppSettings()
    expect(sets.length).toBe(before)
  })

  it('writes nothing when the two already agree', async () => {
    const { mod, sets, ls } = await load({ stored: { [ZDR]: true }, fromMain: { zeroDataRetention: true } })
    await mod.initAppSettings()
    expect(sets).toEqual([]) // the key is still removed, but there is nothing to change
    expect(ls.getItem(ZDR)).toBeNull()
  })

  it('leaves the file alone when the browser never held the key', async () => {
    const { mod, sets } = await load({ fromMain: { zeroDataRetention: false } })
    await mod.initAppSettings()
    expect(sets).toEqual([])
    expect(mod.getAS().zeroDataRetention).toBe(false)
  })

  it('hands the legacy keys to main as the seed', async () => {
    const { mod, seeds } = await load({ stored: { 'prism.ai.model': 'z-ai/glm-5.3' } })
    await mod.initAppSettings()
    expect(seeds).toHaveLength(1)
    expect(seeds[0].model).toBe('z-ai/glm-5.3')
  })

  it('survives main not being ready, leaving the app usable', async () => {
    vi.resetModules()
    const ls = memoryStorage()
    vi.stubGlobal('localStorage', ls)
    vi.stubGlobal('window', {
      localStorage: ls,
      addEventListener: () => {},
      removeEventListener: () => {},
      prism: {
        appSettings: {
          get: async () => ({}),
          set: async () => ({}),
          seed: async () => {
            throw new Error('not ready')
          }
        }
      }
    })
    const mod = await import('./appSettings')
    await expect(mod.initAppSettings()).resolves.toBeUndefined()
  })
})
