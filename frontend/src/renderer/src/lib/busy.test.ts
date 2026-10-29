import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUSY_AFTER_MS, beginBusy, isBusy } from './busy'

describe('busy', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says nothing for a write that finishes within the second', () => {
    const end = beginBusy()
    vi.advanceTimersByTime(BUSY_AFTER_MS - 1)
    end()
    vi.advanceTimersByTime(10)
    expect(isBusy()).toBe(false)
  })

  it('shows once the oldest open write has run for a second, and clears when the last one ends', () => {
    const a = beginBusy()
    vi.advanceTimersByTime(600)
    const b = beginBusy()
    vi.advanceTimersByTime(500)
    expect(isBusy()).toBe(true)
    a()
    expect(isBusy()).toBe(true) // b is still running
    b()
    expect(isBusy()).toBe(false)
  })

  it('tolerates an end called twice', () => {
    const end = beginBusy()
    end()
    end()
    beginBusy()
    vi.advanceTimersByTime(BUSY_AFTER_MS)
    expect(isBusy()).toBe(true)
  })
})
