/**
 * Following an import job: a failed request is retried rather than ending the view, an engine that has
 * stopped is said as such, and a job already running when the view opens is followed to its end.
 */
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { renderWithPrism } from '../test/render'
import type { ImportStatus } from '../components/ImportProgress'
import { stoppedMessage, useImportJob } from './useImportJob'

const running = (detail: string, step = 'inventory'): ImportStatus => ({ state: 'running', step, detail })
const DONE: ImportStatus = { state: 'done', step: 'finished', detail: 'Imported 3 activities.' }
const cutOff = (): Error =>
  new Error("Error invoking remote method 'prism:api': Error: Backend response was cut off.")

function Probe({ onSettled }: { onSettled: (st: ImportStatus) => void }): JSX.Element {
  const { status, trouble, follow } = useImportJob(onSettled)
  return (
    <div>
      <p>status: {status ? `${status.state} ${status.detail}` : 'none'}</p>
      <p>trouble: {trouble ? `${trouble.final ? 'final' : 'passing'} ${trouble.message}` : 'none'}</p>
      <button onClick={() => follow(running('started'))}>follow</button>
    </div>
  )
}

/** Mounts the probe against a status endpoint that answers from `answers` in turn (the last repeats). */
function mount(
  answers: (ImportStatus | Error)[],
  opts: { exit?: () => unknown; strict?: boolean } = {}
): { settled: ImportStatus[]; statusCalls: () => number; unmount: () => void } {
  const settled: ImportStatus[] = []
  const queue = [...answers]
  const probe = <Probe onSettled={(st) => settled.push(st)} />
  const { prism, unmount } = renderWithPrism(opts.strict ? <StrictMode>{probe}</StrictMode> : probe, {
    routes: {
      'GET /api/v1/setup/status': () => {
        const next = queue.length > 1 ? queue.shift()! : queue[0]
        if (next instanceof Error) throw next
        return next
      }
    },
    overrides: { bridge: { backendExit: async () => opts.exit?.() ?? null } }
  })
  return {
    settled,
    statusCalls: () => prism.calls.filter((c) => c.path === '/api/v1/setup/status').length,
    unmount
  }
}

const after = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
const shown = (text: string): boolean => screen.queryByText(text, { exact: false }) !== null

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('useImportJob', () => {
  it('follows a job that is already running when the view opens, to its end', async () => {
    const job = mount([running('Reading 1 of 3'), running('Reading 2 of 3'), DONE])
    await after(0)
    expect(shown('status: running Reading 1 of 3')).toBe(true)
    await after(1500)
    expect(shown('status: running Reading 2 of 3')).toBe(true)
    await after(1500)
    expect(shown('status: done')).toBe(true)
    expect(job.settled).toEqual([DONE])
    await after(10_000)
    expect(job.statusCalls()).toBe(3)
  })

  it('keeps looking when the check on opening fails, and follows the job it then finds', async () => {
    const job = mount([cutOff(), cutOff(), running('Reading'), DONE])
    await after(0)
    expect(shown('status: none')).toBe(true)
    await after(1500 + 3000)
    expect(shown('status: running Reading')).toBe(true)
    expect(shown('trouble: none')).toBe(true)
    await after(1500)
    expect(job.settled).toEqual([DONE])
  })

  it('stays quiet when the engine had stopped before the view opened', async () => {
    const job = mount([cutOff()], { exit: () => ({ code: 1, signal: null }) })
    await after(30_000)
    expect(shown('status: none')).toBe(true)
    expect(shown('trouble: none')).toBe(true)
    expect(job.statusCalls()).toBe(1)
  })

  it('leaves a job that had ended before the view opened alone', async () => {
    const job = mount([DONE])
    await after(10_000)
    expect(shown('status: none')).toBe(true)
    expect(job.settled).toEqual([])
    expect(job.statusCalls()).toBe(1)
  })

  it('retries a failed request, says so after three in a row, and carries on once the engine answers', async () => {
    const job = mount([running('Reading'), cutOff(), cutOff(), cutOff(), running('Writing', 'writing'), DONE])
    await after(0)
    await after(1500) // 1st failure: tried again after 1.5 s, nothing said yet
    await after(1500) // 2nd: after 3 s
    expect(shown('trouble: none')).toBe(true)
    expect(shown('status: running Reading')).toBe(true)
    await after(3000) // 3rd: now it says so, and keeps trying after 5 s
    expect(shown("trouble: passing PrismLCA's engine is not answering (Backend response was cut off.)")).toBe(
      true
    )
    await after(5000)
    expect(shown('trouble: none')).toBe(true)
    expect(shown('status: running Writing')).toBe(true)
    await after(1500)
    expect(job.settled).toEqual([DONE])
  })

  it('says once the engine has stopped, and asks nothing more', async () => {
    const job = mount([running('Writing 27,400 datasets', 'writing'), cutOff()], {
      exit: () => ({ code: null, signal: 'SIGKILL' })
    })
    await after(0)
    await after(1500)
    expect(shown('trouble: final')).toBe(true)
    expect(shown('ran out of memory')).toBe(true)
    expect(shown('exists but is empty')).toBe(true)
    expect(shown('status: running Writing 27,400 datasets')).toBe(true) // where it stopped
    const calls = job.statusCalls()
    await after(60_000)
    expect(job.statusCalls()).toBe(calls)
    expect(job.settled).toEqual([])
  })

  it('runs one loop when a start overtakes the check on opening', async () => {
    const job = mount([running('Reading')])
    fireEvent.click(screen.getByRole('button', { name: 'follow' }))
    await after(6000)
    // the check on opening (1), then the followed job at 0, 1.5, 3, 4.5 and 6 s (5)
    expect(job.statusCalls()).toBe(6)
  })

  it('runs one loop under StrictMode, which mounts every effect twice', async () => {
    const job = mount([running('Reading')], { strict: true })
    await after(6000)
    // two checks on opening, then the job at 1.5, 3, 4.5 and 6 s
    expect(job.statusCalls()).toBe(6)
  })

  it('stops asking when the view closes', async () => {
    const job = mount([running('Reading')])
    await after(1500)
    const calls = job.statusCalls()
    job.unmount()
    await after(10_000)
    expect(job.statusCalls()).toBe(calls)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('stoppedMessage', () => {
  it('names the exit and leaves out what does not apply', () => {
    const text = stoppedMessage(running('Reading 18,704 of 27,400'), { code: 1, signal: null })
    expect(text).toBe("PrismLCA's engine stopped during the import (exit code 1). Restart PrismLCA to go on.")
  })

  it('tells how to get past an interrupted write, and what to do about memory', () => {
    const text = stoppedMessage(running('Writing', 'writing'), { code: null, signal: 'SIGKILL' })
    expect(text).toContain('most likely because the computer ran out of memory')
    expect(text).toContain('close other programs before you import again')
    expect(text).toContain('remove that database under Background data (Remove… on its card)')
  })
})
