import { describe, expect, it, vi } from 'vitest'

import {
  accountGuard,
  costAccount,
  costGuard,
  costNote,
  costReason,
  resetCostAccounts,
  stopNote,
  DEADLINE_REASON
} from './reportWriter'

/**
 * The spend ceiling for a report run.
 *
 * The report writers were the half of the app the "Cost limit per run" setting never reached: they
 * booked every call into the ledger and were bounded by a DEADLINE instead, so a long "Write all"
 * could spend whatever it took and only a clock could stop it. These pin the three things that makes
 * a brake rather than a counter — it stops the run, it stops it once, and it says which limit it was.
 */
const usage = (cost: number): { cost: number } => ({ cost })

describe('the report cost guard stops a run at its ceiling', () => {
  it('lets a run continue while it is under the limit', () => {
    const c = new AbortController()
    const guard = costGuard(15, c, vi.fn())
    guard('m', usage(5))
    guard('m', usage(9))
    expect(c.signal.aborted).toBe(false)
  })

  it('aborts the run when the spend reaches the limit', () => {
    const c = new AbortController()
    const guard = costGuard(15, c, vi.fn())
    guard('m', usage(9))
    guard('m', usage(7))
    expect(c.signal.aborted).toBe(true)
    // The figures travel with the reason, so the author is told which limit stopped them.
    expect(c.signal.reason).toMatchObject({ cost: true, limit: 15 })
    expect((c.signal.reason as { spent: number }).spent).toBeCloseTo(16)
  })

  it('still books every call into the ledger, including the one that trips it', () => {
    // The guard rides on the reporting channel; if it swallowed a call the ledger would understate
    // exactly the run that cost the most.
    const book = vi.fn()
    const c = new AbortController()
    const guard = costGuard(1, c, book)
    guard('m', usage(0.4))
    guard('m', usage(0.9))
    expect(book).toHaveBeenCalledTimes(2)
    expect(book).toHaveBeenLastCalledWith('m', { cost: 0.9 })
  })

  it('aborts once, not on every later call', () => {
    // Lanes keep reporting after the abort — `writeAll` finishes the chapters already in flight.
    // A second abort would replace the reason, and the run would report a spend that kept growing.
    const c = new AbortController()
    const guard = costGuard(1, c, vi.fn())
    guard('m', usage(2))
    const first = c.signal.reason
    guard('m', usage(5))
    expect(c.signal.reason).toBe(first)
  })

  it('treats 0 as no limit, like everywhere else', () => {
    const c = new AbortController()
    const guard = costGuard(0, c, vi.fn())
    guard('m', usage(1000))
    expect(c.signal.aborted).toBe(false)
  })

  it('ignores a call whose cost the provider did not report', () => {
    // A missing price is not a free call, but it is also not a reason to stop a paid run on a NaN.
    const c = new AbortController()
    const guard = costGuard(1, c, vi.fn())
    guard('m', {})
    guard('m', { cost: undefined })
    expect(c.signal.aborted).toBe(false)
  })
})

describe('what the author is told', () => {
  it('names the limit, says the finished chapters were kept, and points at the setting', () => {
    const note = costNote(costReason(15, 15.4))
    expect(note).toContain('$15.00')
    expect(note).toContain('$15.40')
    expect(note).toContain('Settings')
    expect(note).toMatch(/kept/i)
  })

  it('keeps the three stop reasons apart — the point of having a reason at all', () => {
    // V178: a lapsed backstop reached the author as "the correction was cancelled", so a run nobody
    // had touched blamed the author for stopping it. A cost stop needs its own words for the same
    // reason — it is the only one of the three that is answered in Settings.
    const cost = new AbortController()
    cost.abort(costReason(15, 15.4))
    const deadline = new AbortController()
    deadline.abort(DEADLINE_REASON)
    const stopped = new AbortController()
    stopped.abort()

    expect(stopNote(cost.signal, 'cancelled')).toContain('cost limit')
    expect(stopNote(deadline.signal, 'cancelled')).toContain('time limit')
    expect(stopNote(stopped.signal, 'cancelled')).toBe('cancelled')
    expect(stopNote(undefined, 'cancelled')).toBe('cancelled')
  })
})

describe('one account per run, across the IPC calls that make it up', () => {
  it('shares the spend between two guards on the same account and stops the second one', () => {
    resetCostAccounts()
    const account = costAccount('run-1', 10)
    const first = new AbortController()
    accountGuard(account, first, vi.fn())('m', usage(6))
    expect(first.signal.aborted).toBe(false)
    // The next IPC call of the same run picks up the same account…
    expect(costAccount('run-1', 10)).toBe(account)
    const second = new AbortController()
    accountGuard(account, second, vi.fn())('m', usage(5))
    // …and is the one that trips: 6 + 5 over a limit of 10.
    expect(second.signal.aborted).toBe(true)
    expect(account.stopped).toBe(true)
    expect(account.spent).toBeCloseTo(11)
  })

  it('opens the account with the limit of its first call and keeps it', () => {
    resetCostAccounts()
    costAccount('run-2', 3)
    expect(costAccount('run-2', 99).limit).toBe(3)
  })

  it('sweeps an account that has been open for hours', () => {
    resetCostAccounts()
    costAccount('run-old', 1, 0).spent = 5
    costAccount('run-new', 1, 3 * 60 * 60 * 1000)
    // A fresh lookup of the old id opens a new, unspent account rather than finding the swept one.
    expect(costAccount('run-old', 1, 3 * 60 * 60 * 1000).spent).toBe(0)
  })
})
