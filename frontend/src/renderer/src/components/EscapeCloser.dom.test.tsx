import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import EscapeCloser from './EscapeCloser'

describe('EscapeCloser', () => {
  it('closes the dialog on Escape and nothing else', () => {
    const close = vi.fn()
    render(<EscapeCloser onClose={close} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(close).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes only the topmost of stacked dialogs, then the next', () => {
    const sheet = vi.fn()
    const confirm = vi.fn()
    const { unmount } = render(<EscapeCloser onClose={sheet} />)
    const top = render(<EscapeCloser onClose={confirm} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(sheet).not.toHaveBeenCalled()
    top.unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(sheet).toHaveBeenCalledTimes(1)
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(sheet).toHaveBeenCalledTimes(1)
  })

  it('leaves a field that claimed the key alone', () => {
    const close = vi.fn()
    render(
      <div>
        <EscapeCloser onClose={close} />
        <input data-testid="f" onKeyDown={(e) => e.key === 'Escape' && e.stopPropagation()} />
      </div>
    )
    fireEvent.keyDown(document.querySelector('[data-testid="f"]')!, { key: 'Escape' })
    expect(close).not.toHaveBeenCalled()
  })
})
