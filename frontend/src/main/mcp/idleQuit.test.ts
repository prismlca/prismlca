import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createIdleQuit } from './idleQuit'

describe('createIdleQuit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('quits after the idle time once armed, and only then', () => {
    const quit = vi.fn()
    const q = createIdleQuit({ idleMs: 1000, quit })
    vi.advanceTimersByTime(5000)
    expect(quit).not.toHaveBeenCalled() // never armed = a normal start
    q.arm()
    expect(q.state()).toBe('armed')
    vi.advanceTimersByTime(999)
    expect(quit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('restarts the clock on MCP activity', () => {
    const quit = vi.fn()
    const q = createIdleQuit({ idleMs: 1000, quit })
    q.arm()
    vi.advanceTimersByTime(800)
    q.activity()
    vi.advanceTimersByTime(800)
    expect(quit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('never quits once a person claimed the window — before or after arming', () => {
    const quit = vi.fn()
    const a = createIdleQuit({ idleMs: 1000, quit })
    a.arm()
    a.claim()
    vi.advanceTimersByTime(5000)
    expect(quit).not.toHaveBeenCalled()
    expect(a.state()).toBe('claimed')
    a.activity()
    a.arm() // a late arm must not revive it
    vi.advanceTimersByTime(5000)
    expect(quit).not.toHaveBeenCalled()

    const b = createIdleQuit({ idleMs: 1000, quit })
    b.claim()
    b.arm()
    vi.advanceTimersByTime(5000)
    expect(quit).not.toHaveBeenCalled()
  })
})

describe('createIdleQuit — work in flight and the last question', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not count while a call is in flight, and restarts the clock when the last one ends', () => {
    const quit = vi.fn()
    const q = createIdleQuit({ idleMs: 1000, quit })
    q.arm()
    q.begin() // a question card waits on a person — 30 minutes, say
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(quit).not.toHaveBeenCalled()
    q.begin()
    q.end()
    vi.advanceTimersByTime(5000)
    expect(quit).not.toHaveBeenCalled() // one is still open
    q.end()
    vi.advanceTimersByTime(999)
    expect(quit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('asks before quitting and tries again later when work is still running', async () => {
    const quit = vi.fn()
    let running = true
    const q = createIdleQuit({ idleMs: 1000, quit, canQuit: async () => !running })
    q.arm()
    await vi.advanceTimersByTimeAsync(1000)
    expect(quit).not.toHaveBeenCalled() // a job runs: postponed
    running = false
    await vi.advanceTimersByTimeAsync(1000)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('reports its state changes for the banner', () => {
    const states: string[] = []
    const q = createIdleQuit({ idleMs: 1000, quit: () => undefined, onChange: (s) => states.push(s) })
    q.arm()
    q.claim()
    expect(states).toEqual(['armed', 'claimed'])
  })
})
