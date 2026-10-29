import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import UnitCombo from './UnitCombo'

/**
 * The location field's use of the combo: suggestions name each code, typing a
 * name finds its code, the list is loaded on first focus — and free text stays free text.
 */
const NAMES: Record<string, string> = { DE: 'Germany', GLO: 'Global', RER: 'Europe' }

function Harness({ onFocus, onCommit }: { onFocus?: () => void; onCommit?: (v: string) => void }) {
  const [v, setV] = useState('')
  return (
    <UnitCombo
      value={v}
      units={['RER', 'DE', 'GLO']}
      describe={(c) => NAMES[c]}
      onFocus={onFocus}
      onChange={setV}
      onCommit={() => onCommit?.(v)}
    />
  )
}

describe('UnitCombo as the location field', () => {
  it('asks for its list on first focus and names every entry', () => {
    const onFocus = vi.fn()
    render(<Harness onFocus={onFocus} />)
    act(() => screen.getByRole('textbox').focus())
    expect(onFocus).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'DE · Germany' })).toBeTruthy()
  })

  it('finds a code by its name, code matches first', () => {
    render(<Harness />)
    const box = screen.getByRole('textbox')
    act(() => box.focus())
    fireEvent.change(box, { target: { value: 'germ' } })
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['DE · Germany'])
    fireEvent.mouseDown(screen.getByRole('button', { name: 'DE · Germany' }))
    expect((box as HTMLInputElement).value).toBe('DE')
  })

  it('keeps free text nobody has used before', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    const box = screen.getByRole('textbox')
    act(() => box.focus())
    fireEvent.change(box, { target: { value: 'Werk Süd' } })
    fireEvent.blur(box)
    expect(onCommit).toHaveBeenCalledWith('Werk Süd')
  })
})

describe('UnitCombo from the keyboard', () => {
  // The CPC field was a <datalist>, where ArrowDown and Enter picked a suggestion. Without the arrow keys
  // here, Enter committed the typed fragment ("Wood") as a code of its own.
  it('marks a suggestion with the arrow keys and takes it on Enter, keeping the field for the commit', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    const box = screen.getByRole('textbox')
    act(() => box.focus())
    fireEvent.change(box, { target: { value: 'e' } })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(screen.getByRole('button', { name: 'DE · Germany' }).className).toBe('sel')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect((box as HTMLInputElement).value).toBe('DE')
    expect(document.activeElement).toBe(box)
    expect(onCommit).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('DE')
  })

  it('Enter without a marked entry still commits what was typed', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    const box = screen.getByRole('textbox')
    act(() => box.focus())
    fireEvent.change(box, { target: { value: 'Werk' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('Werk')
  })
})
