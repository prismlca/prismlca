// @vitest-environment jsdom
/**
 * A long import shows how long it has been running and can be cancelled until it writes. Without
 * either, a stuck import and a slow one looked the same, and the only way out was to end the process.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ImportProgress, { type ImportStatus } from './ImportProgress'

const reading: ImportStatus = {
  state: 'running',
  step: 'inventory',
  detail: 'Reading datasets: 1,200 of 26,533',
  progress: 0.08,
  cancellable: true,
  started_at: 1_000
}

afterEach(() => vi.useRealTimers())

describe('ImportProgress', () => {
  it('shows the elapsed time and the count', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000 + 125_000) // 125 s after started_at
    render(<ImportProgress status={reading} onCancel={async () => {}} />)
    expect(screen.getByText('Running for 2:05')).toBeTruthy()
    expect(screen.getByText(/1,200 of 26,533/)).toBeTruthy()
  })

  it('cancels once and waits for the backend', async () => {
    let finish = (): void => {}
    const onCancel = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    render(<ImportProgress status={reading} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }))
    const button = screen.getByRole('button', { name: 'Cancelling…' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(onCancel).toHaveBeenCalledTimes(1)
    await act(async () => finish())
  })

  it('offers no cancel once the write has begun, nor after the end', () => {
    const { rerender } = render(
      <ImportProgress
        status={{ ...reading, step: 'writing', cancellable: false }}
        onCancel={async () => {}}
      />
    )
    expect(screen.queryByRole('button', { name: 'Cancel import' })).toBeNull()
    rerender(
      <ImportProgress
        status={{ ...reading, state: 'cancelled', step: 'cancelled', cancellable: false }}
        onCancel={async () => {}}
      />
    )
    expect(screen.queryByRole('button', { name: 'Cancel import' })).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
})
