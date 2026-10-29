import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { BusyClock } from './Busy'

/**
 * The report foot's freshness check waits about a minute with nothing to measure progress against, and
 * the animated dots it used to show passed for punctuation. What replaced them has to
 * be visibly alive: a spinner, and a clock that actually counts.
 */
describe('BusyClock', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows a spinner and counts the seconds since it appeared', () => {
    render(<BusyClock label="checking what changed" />)
    const status = screen.getByRole('status')
    expect(status.querySelector('.spinner')).not.toBeNull()
    expect(status.textContent).toMatch(/checking what changed · 0 s/)
    act(() => vi.advanceTimersByTime(3_000))
    expect(status.textContent).toMatch(/· 3 s/)
  })

  it('stops its clock when it leaves the page', () => {
    const { unmount } = render(<BusyClock label="checking" />)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
