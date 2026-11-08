import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ASK_TO_LEAVE_MS, endProcess, holdQuitForBackend, QUIT_GRACE_MS } from './backendExit'

/** A child process that leaves on the signals it `obeys` and ignores the others. */
class FakeChild extends EventEmitter {
  pid: number | undefined = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly signals: string[] = []
  constructor(private readonly obeys: NodeJS.Signals[]) {
    super()
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal)
    if (this.exitCode === null && this.signalCode === null && this.obeys.includes(signal)) {
      // Like Node: the exit is reported later, never inside kill().
      queueMicrotask(() => {
        this.signalCode = signal
        this.emit('exit', null, signal)
      })
    }
    return true
  }
  /** Leaves on its own, as a backend does once it has agreed to a request to leave. */
  leave(): void {
    queueMicrotask(() => {
      this.exitCode = 0
      this.emit('exit', 0, null)
    })
  }
}
const asChild = (c: FakeChild): ChildProcess => c as unknown as ChildProcess

/** The backend agrees to leave and goes. */
const agreesAndLeaves = (child: FakeChild) =>
  vi.fn(async () => {
    child.leave()
    return true
  })

/** The request is answered with a no (or by a backend that cannot leave): the signals decide. */
const refuses = () => vi.fn(async () => false)

function hold(child: FakeChild | null, askToLeave: () => Promise<boolean> = refuses()) {
  const beforeEnd = vi.fn()
  const quit = vi.fn()
  const relaunch = vi.fn()
  const h = holdQuitForBackend({
    backend: () => (child ? asChild(child) : null),
    beforeEnd,
    askToLeave,
    quit,
    relaunch
  })
  const willQuit = (): boolean => {
    let prevented = false
    h.onWillQuit({ preventDefault: () => void (prevented = true) })
    return prevented
  }
  return { willQuit, beforeEnd, quit, relaunch, h }
}

describe('ending the backend', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('asks first and stops there when the backend leaves', async () => {
    const child = new FakeChild(['SIGTERM'])
    expect(await endProcess(asChild(child))).toBe(true)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('kills a backend that is still there after the grace period', async () => {
    const child = new FakeChild(['SIGKILL'])
    const done = endProcess(asChild(child), 2_000)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(child.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(await done).toBe(true)
  })

  it('a quit asks the backend to leave in order, and sends no signal when it goes', async () => {
    const child = new FakeChild([])
    const ask = agreesAndLeaves(child)
    const { willQuit, beforeEnd, quit } = hold(child, ask)
    expect(willQuit()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(ask).toHaveBeenCalledTimes(1)
    // MCP sessions and the keep-awake poll stop before the request: nothing talks to a leaving backend.
    expect(beforeEnd.mock.invocationCallOrder[0]).toBeLessThan(ask.mock.invocationCallOrder[0])
    expect(child.signals).toEqual([])
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('kills a backend that agreed but is still there after the grace period, without a SIGTERM first', async () => {
    const child = new FakeChild(['SIGKILL'])
    const { willQuit, quit } = hold(
      child,
      vi.fn(async () => true)
    )
    willQuit()
    await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS - 1)
    expect(child.signals).toEqual([])
    expect(quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(child.signals).toEqual(['SIGKILL'])
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('falls back to the signals when the request is refused or fails', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing = vi.fn(async (): Promise<boolean> => {
      throw new Error('Backend is not ready.')
    })
    for (const ask of [refuses(), failing]) {
      const child = new FakeChild(['SIGTERM'])
      const { willQuit, quit } = hold(child, ask)
      willQuit()
      await vi.advanceTimersByTimeAsync(0)
      expect(child.signals).toEqual(['SIGTERM'])
      expect(quit).toHaveBeenCalledTimes(1)
    }
    log.mockRestore()
  })

  it('an unanswered request holds the quit no longer than its own deadline', async () => {
    const child = new FakeChild(['SIGTERM'])
    const { willQuit, quit } = hold(
      child,
      vi.fn(() => new Promise<boolean>(() => undefined))
    )
    willQuit()
    await vi.advanceTimersByTimeAsync(ASK_TO_LEAVE_MS - 1)
    expect(child.signals).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(child.signals).toEqual(['SIGTERM'])
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('holds the quit until a backend that ignores the request is killed, then quits once', async () => {
    const child = new FakeChild(['SIGKILL'])
    const ask = refuses()
    const { willQuit, beforeEnd, quit } = hold(child, ask)
    expect(willQuit()).toBe(true)
    expect(beforeEnd).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(child.signals).toEqual(['SIGTERM'])
    // A second quit while the first one waits is held too, without a second request or signal.
    expect(willQuit()).toBe(true)
    await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS - 1)
    expect(quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(quit).toHaveBeenCalledTimes(1)
    expect(beforeEnd).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledTimes(1)
    // The quit it runs goes through.
    expect(willQuit()).toBe(false)
  })

  it('still quits when the end cannot be confirmed', async () => {
    for (const agreed of [false, true]) {
      const child = new FakeChild([])
      const { willQuit, quit } = hold(
        child,
        vi.fn(async () => agreed)
      )
      expect(willQuit()).toBe(true)
      await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS + 5_000)
      expect(child.signals).toEqual(agreed ? ['SIGKILL'] : ['SIGTERM', 'SIGKILL'])
      expect(quit).toHaveBeenCalledTimes(1)
    }
  })

  it('does not hold the quit when there is no backend to end', () => {
    const exited = new FakeChild([])
    exited.exitCode = 0
    const neverStarted = new FakeChild([])
    neverStarted.pid = undefined
    for (const child of [null, exited, neverStarted]) {
      const ask = refuses()
      const { willQuit, beforeEnd, quit } = hold(child, ask)
      expect(willQuit()).toBe(false)
      expect(beforeEnd).not.toHaveBeenCalled()
      expect(ask).not.toHaveBeenCalled()
      expect(quit).not.toHaveBeenCalled()
      expect(child?.signals ?? []).toEqual([])
    }
  })

  it('starts the app again for a person who opened it while the backend was being ended', async () => {
    const child = new FakeChild(['SIGKILL'])
    const { willQuit, quit, relaunch, h } = hold(child)
    expect(h.holding()).toBe(false)
    expect(willQuit()).toBe(true)
    expect(h.holding()).toBe(true)
    h.reopenAfterEnd()
    h.reopenAfterEnd()
    await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS)
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(relaunch.mock.invocationCallOrder[0]).toBeLessThan(quit.mock.invocationCallOrder[0])
    // Still quitting: a start arriving now is not given a window here either.
    expect(h.holding()).toBe(true)
  })

  it('relaunches a late start too, but never into a backend that may still hold the lock', async () => {
    const leavingChild = new FakeChild([])
    const leaves = hold(leavingChild, agreesAndLeaves(leavingChild))
    leaves.willQuit()
    await vi.advanceTimersByTimeAsync(0)
    expect(leaves.quit).toHaveBeenCalledTimes(1)
    leaves.h.reopenAfterEnd()
    expect(leaves.relaunch).toHaveBeenCalledTimes(1)

    const stays = hold(new FakeChild([]))
    stays.willQuit()
    stays.h.reopenAfterEnd()
    await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS + 5_000)
    expect(stays.quit).toHaveBeenCalledTimes(1)
    stays.h.reopenAfterEnd()
    expect(stays.relaunch).not.toHaveBeenCalled()
  })

  it('quits even when the relaunch fails', async () => {
    const child = new FakeChild([])
    const { willQuit, quit, relaunch, h } = hold(child, agreesAndLeaves(child))
    relaunch.mockImplementation(() => {
      throw new Error('no relaunch')
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    willQuit()
    h.reopenAfterEnd()
    await vi.advanceTimersByTimeAsync(0)
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(quit).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })

  it('without a quit under way, a start is not held back', () => {
    const { h, relaunch } = hold(new FakeChild(['SIGTERM']))
    expect(h.holding()).toBe(false)
    expect(relaunch).not.toHaveBeenCalled()
  })
})
