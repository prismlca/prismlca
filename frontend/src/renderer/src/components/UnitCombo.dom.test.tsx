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
    act(() => screen.getByRole('combobox').focus())
    expect(onFocus).toHaveBeenCalled()
    expect(screen.getByRole('option', { name: 'DE · Germany' })).toBeTruthy()
  })

  it('finds a code by its name, code matches first', () => {
    render(<Harness />)
    const box = screen.getByRole('combobox')
    act(() => box.focus())
    fireEvent.change(box, { target: { value: 'germ' } })
    expect(screen.getAllByRole('option').map((b) => b.textContent)).toEqual(['DE · Germany'])
    fireEvent.mouseDown(screen.getByRole('option', { name: 'DE · Germany' }))
    expect((box as HTMLInputElement).value).toBe('DE')
  })

  it('keeps free text nobody has used before', () => {
    const onCommit = vi.fn()
    render(<Harness onCommit={onCommit} />)
    const box = screen.getByRole('combobox')
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
    const box = screen.getByRole('combobox')
    act(() => box.focus())
    fireEvent.change(box, { target: { value: 'e' } })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    const marked = screen.getByRole('option', { name: 'DE · Germany' })
    expect(marked.className).toBe('sel')
    // …and announced, not only drawn: the field points at the marked option and keeps the focus.
    expect(marked).toHaveAttribute('aria-selected', 'true')
    expect(box).toHaveAttribute('aria-activedescendant', marked.id)
    expect(box).toHaveAttribute('aria-expanded', 'true')
    expect(box).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
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
    const box = screen.getByRole('combobox')
    act(() => box.focus())
    fireEvent.change(box, { target: { value: 'Werk' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onCommit).toHaveBeenCalledWith('Werk')
  })
})

describe('UnitCombo reopened in a field that kept its focus', () => {
  it('asks for its list again, as a new focus would', () => {
    const onFocus = vi.fn()
    render(<Harness onFocus={onFocus} />)
    const box = screen.getByRole('combobox')
    act(() => box.focus())
    fireEvent.mouseDown(screen.getByRole('option', { name: 'DE · Germany' }))
    expect(onFocus).toHaveBeenCalledTimes(1)
    fireEvent.click(box) // the list closed on the pick; a click opens it again
    expect(onFocus).toHaveBeenCalledTimes(2)
    fireEvent.click(box) // already open: nothing to load
    expect(onFocus).toHaveBeenCalledTimes(2)
  })
})

describe('UnitCombo for a screen reader', () => {
  it('is a combobox whose closed state says so, and whose options are no tab stops', () => {
    render(<Harness />)
    const box = screen.getByRole('combobox')
    expect(box).toHaveAttribute('aria-expanded', 'false')
    expect(box).not.toHaveAttribute('aria-activedescendant')
    act(() => box.focus())
    expect(box).toHaveAttribute('aria-expanded', 'true')
    expect(box).not.toHaveAttribute('aria-activedescendant') // nothing marked yet: the typed text stands
    for (const o of screen.getAllByRole('option')) {
      expect(o).toHaveAttribute('tabindex', '-1')
      expect(o).toHaveAttribute('aria-selected', 'false')
    }
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(box).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('UnitCombo when its list shrinks under the mark', () => {
  it('points at no option that is gone, and Enter takes nothing stale', () => {
    const onChange = vi.fn()
    const view = (units: string[]): JSX.Element => (
      <UnitCombo value="" units={units} onChange={onChange} ariaLabel="Code" />
    )
    const { rerender } = render(view(['RER', 'DE', 'GLO']))
    const box = screen.getByRole('combobox', { name: 'Code' })
    act(() => box.focus())
    for (let i = 0; i < 3; i++) fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'GLO' }).id)
    // New suggestions arrive: one entry left, the mark was on the third.
    rerender(view(['DE']))
    expect(box).not.toHaveAttribute('aria-activedescendant')
    expect(screen.getByRole('option', { name: 'DE' })).toHaveAttribute('aria-selected', 'false')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    // The arrow keys start again from the top of what is there.
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'DE' }).id)
  })
})
