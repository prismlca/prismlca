import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createKeepAwake,
  KEEP_AWAKE_INTERVAL_MS,
  KEEP_AWAKE_POLL_TIMEOUT_MS,
  type KeepAwakeDeps
} from './keepAwake'

/** A world the rule reads from, changed by the test between checks. */
function setup(over: Partial<KeepAwakeDeps> = {}) {
  const world = { enabled: true, mains: true, backend: [] as string[], main: [] as string[], down: false }
  let next = 1
  const live = new Set<number>()
  const deps: KeepAwakeDeps = {
    hold: vi.fn(() => {
      live.add(next)
      return next++
    }),
    release: vi.fn((id: number) => void live.delete(id)),
    enabled: () => world.enabled,
    onMains: () => world.mains,
    backendWork: async () => {
      if (world.down) throw new Error('ECONNREFUSED')
      return world.backend
    },
    mainWork: () => world.main,
    ...over
  }
  const k = createKeepAwake(deps)
  return { world, deps, k, live }
}

describe('createKeepAwake', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('holds while the backend reports long work, and only one hold however long it runs', async () => {
    const { world, k, live, deps } = setup()
    await k.check()
    expect(k.held()).toBe(false)
    world.backend = ['the search index being built']
    await k.check()
    await k.check()
    expect(k.held()).toBe(true)
    expect(deps.hold).toHaveBeenCalledTimes(1)
    expect(live.size).toBe(1)
  })

  it("holds for main's own runs too", async () => {
    const { world, k } = setup()
    world.main = ['the report writer']
    await k.check()
    expect(k.held()).toBe(true)
  })

  it('lets go only after two idle checks in a row — the gap between import and index keeps the hold', async () => {
    const { world, k, live } = setup()
    world.backend = ['a background import running']
    await k.check()
    world.backend = []
    await k.check() // the import has finished, the index build has not started yet
    expect(k.held()).toBe(true)
    world.backend = ['the search index being built']
    await k.check()
    world.backend = []
    await k.check()
    expect(k.held()).toBe(true)
    await k.check()
    expect(k.held()).toBe(false)
    expect(live.size).toBe(0)
  })

  it('never holds on battery, and lets go at once when the plug is pulled', async () => {
    const { world, k } = setup()
    world.backend = ['a background import running']
    world.mains = false
    await k.check()
    expect(k.held()).toBe(false)
    world.mains = true
    await k.check()
    expect(k.held()).toBe(true)
    world.mains = false
    await k.check()
    expect(k.held()).toBe(false)
  })

  it('does nothing with the setting off, and lets go when it is switched off', async () => {
    const { world, k, deps } = setup()
    world.main = ['an assistant run']
    world.enabled = false
    await k.check()
    expect(deps.hold).not.toHaveBeenCalled()
    world.enabled = true
    await k.check()
    expect(k.held()).toBe(true)
    world.enabled = false
    await k.check()
    expect(k.held()).toBe(false)
  })

  it('trusts the last answer for two unanswered checks, then counts a silent backend as idle', async () => {
    const { world, k } = setup()
    world.backend = ['2 calculations running']
    await k.check()
    world.down = true
    await k.check()
    await k.check()
    expect(k.held()).toBe(true) // a backend busy enough to miss a poll is still working
    await k.check()
    await k.check()
    expect(k.held()).toBe(false) // a dead backend is not working for anyone
  })

  it('gives up on a hanging poll after its own timeout, and does not ask again while it hangs', async () => {
    const backendWork = vi.fn(() => new Promise<string[]>(() => {}))
    const { k } = setup({ backendWork })
    const first = k.check()
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_TIMEOUT_MS)
    await first
    const second = k.check()
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_POLL_TIMEOUT_MS)
    await second
    expect(backendWork).toHaveBeenCalledTimes(1)
  })

  it('checks on start and then every interval', async () => {
    const backendWork = vi.fn(async () => [])
    const { k } = setup({ backendWork })
    k.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(backendWork).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(KEEP_AWAKE_INTERVAL_MS)
    expect(backendWork).toHaveBeenCalledTimes(2)
  })

  it('releases on stop and never holds again — not even from a check that was still waiting', async () => {
    let answer: (work: string[]) => void = () => {}
    const backendWork = vi.fn(() => new Promise<string[]>((resolve) => (answer = resolve)))
    const { k, live, world } = setup({ backendWork })
    world.main = ['an assistant run']
    const pending = k.check()
    k.stop()
    answer(['a background import running'])
    await pending
    expect(k.held()).toBe(false)
    expect(live.size).toBe(0)
    await k.check()
    expect(k.held()).toBe(false)
  })
})
