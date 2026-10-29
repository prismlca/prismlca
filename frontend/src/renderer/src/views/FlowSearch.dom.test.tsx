import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'

import FlowSearchControl from './FlowSearch'

/**
 * The filter field in the process details window lives inside a dialog that closes on Escape. Escape in
 * the field has to close the field, not the window — and opening it has to put the cursor in it.
 */
describe('FlowSearchControl', () => {
  it('opens empty from the magnifier and closes again from it', () => {
    const onChange = vi.fn()
    const { getByRole, rerender } = render(<FlowSearchControl query={null} onChange={onChange} />)
    fireEvent.click(getByRole('button'))
    expect(onChange).toHaveBeenLastCalledWith('')
    rerender(<FlowSearchControl query="air" onChange={onChange} />)
    fireEvent.click(getByRole('button'))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('puts the cursor in the field when it opens', () => {
    const { getByRole, rerender } = render(<FlowSearchControl query={null} onChange={() => {}} />)
    rerender(<FlowSearchControl query="" onChange={() => {}} />)
    expect(document.activeElement).toBe(getByRole('textbox'))
  })

  it('closes the field on Escape without letting the key reach the window', () => {
    const onChange = vi.fn()
    const windowKey = vi.fn()
    window.addEventListener('keydown', windowKey)
    const { getByRole } = render(<FlowSearchControl query="air" onChange={onChange} />)
    fireEvent.keyDown(getByRole('textbox'), { key: 'Escape' })
    window.removeEventListener('keydown', windowKey)
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(windowKey).not.toHaveBeenCalled()
  })
})
