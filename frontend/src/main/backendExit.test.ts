import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { endProcess, holdQuitForBackend, QUIT_GRACE_MS } from './backendExit'

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
}
const asChild = (c: FakeChild): ChildProcess => c as unknown as ChildProcess

function hold(child: FakeChild | null) {
  const beforeEnd = vi.fn()
  const quit = vi.fn()
  const listener = holdQuitForBackend({ backend: () => (child ? asChild(child) : null), beforeEnd, quit })
  const willQuit = (): boolean => {
    let prevented = false
    listener({ preventDefault: () => void (prevented = true) })
    return prevented
  }
  return { willQuit, beforeEnd, quit }
}

describe('ending the backend', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

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

  it('holds the quit until a backend that ignores the request is killed, then quits once', async () => {
    const child = new FakeChild(['SIGKILL'])
    const { willQuit, beforeEnd, quit } = hold(child)
    expect(willQuit()).toBe(true)
    expect(beforeEnd).toHaveBeenCalledTimes(1)
    expect(child.signals).toEqual(['SIGTERM'])
    // A second quit while the first one waits is held too, without a second round of signals.
    expect(willQuit()).toBe(true)
    await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS - 1)
    expect(quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(quit).toHaveBeenCalledTimes(1)
    expect(beforeEnd).toHaveBeenCalledTimes(1)
    // The quit it runs goes through.
    expect(willQuit()).toBe(false)
  })

  it('quits as soon as the backend leaves in order', async () => {
    const child = new FakeChild(['SIGTERM'])
    const { willQuit, quit } = hold(child)
    expect(willQuit()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(child.signals).toEqual(['SIGTERM'])
  })

  it('still quits when the end cannot be confirmed', async () => {
    const child = new FakeChild([])
    const { willQuit, quit } = hold(child)
    expect(willQuit()).toBe(true)
    await vi.advanceTimersByTimeAsync(QUIT_GRACE_MS + 5_000)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('does not hold the quit when there is no backend to end', () => {
    const exited = new FakeChild([])
    exited.exitCode = 0
    const neverStarted = new FakeChild([])
    neverStarted.pid = undefined
    for (const child of [null, exited, neverStarted]) {
      const { willQuit, beforeEnd, quit } = hold(child)
      expect(willQuit()).toBe(false)
      expect(beforeEnd).not.toHaveBeenCalled()
      expect(quit).not.toHaveBeenCalled()
      expect(child?.signals ?? []).toEqual([])
    }
  })
})
