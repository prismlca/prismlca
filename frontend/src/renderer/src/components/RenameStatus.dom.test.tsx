import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import RenameStatus, { RENAMED_SHOWN_MS } from './RenameStatus'

afterEach(() => vi.useRealTimers())

describe('RenameStatus', () => {
  it('shows a spinner while the rename runs, then "Renamed" for a moment, then nothing', () => {
    vi.useFakeTimers()
    const { rerender, container } = render(<RenameStatus busy={true} done={0} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Renaming… moving chats, reports and parameters/)
    expect(container.querySelector('.spinner')).not.toBeNull()

    rerender(<RenameStatus busy={false} done={1} />)
    expect(screen.getByRole('status')).toHaveTextContent('Renamed')
    act(() => void vi.advanceTimersByTime(RENAMED_SHOWN_MS + 10))
    expect(container.textContent).toBe('')
  })

  it('says nothing after a refused rename — the error line does', () => {
    const { rerender, container } = render(<RenameStatus busy={true} done={0} />)
    rerender(<RenameStatus busy={false} done={0} />)
    expect(container.textContent).toBe('')
  })
})
