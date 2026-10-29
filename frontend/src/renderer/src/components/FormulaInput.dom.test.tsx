import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import FormulaInput from './FormulaInput'

const P = [{ name: 'mass', hint: '12 kg' }, { name: 'mass_glass' }, { name: 'distance_km' }]

/** The field as a view uses it: controlled, with the commit reported upward. */
function Host({ initial = '', onCommit }: { initial?: string; onCommit: (p: unknown, v: string) => void }) {
  const [v, setV] = useState(initial)
  return (
    <FormulaInput
      value={v}
      onChange={setV}
      params={P}
      placeholder="formula"
      onCommit={(problem) => onCommit(problem, v)}
    />
  )
}

const field = (): HTMLTextAreaElement => screen.getByPlaceholderText('formula') as HTMLTextAreaElement

describe('FormulaInput', () => {
  it('offers the matching parameter names and inserts the picked one', () => {
    render(<Host onCommit={() => {}} />)
    const f = field()
    fireEvent.change(f, { target: { value: 'ma', selectionStart: 2 } })
    const opts = screen.getAllByRole('option')
    expect(opts.map((o) => o.textContent)).toEqual(['mass12 kg', 'mass_glass'])
    fireEvent.keyDown(f, { key: 'ArrowDown' })
    fireEvent.keyDown(f, { key: 'Enter' })
    expect(f.value).toBe('mass_glass')
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('takes the completion on Tab and keeps the rest of the formula', () => {
    render(<Host initial="2 * " onCommit={() => {}} />)
    const f = field()
    fireEvent.change(f, { target: { value: '2 * dis', selectionStart: 7 } })
    fireEvent.keyDown(f, { key: 'Tab' })
    expect(f.value).toBe('2 * distance_km')
  })

  it('does not send a formula with a problem and says why under the field', () => {
    const commit = vi.fn()
    render(<Host onCommit={commit} />)
    const f = field()
    fireEvent.change(f, { target: { value: 'Mass * 0,5', selectionStart: 10 } })
    fireEvent.keyDown(f, { key: 'Enter' })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0]).toMatchObject({ kind: 'unknown', name: 'Mass', suggestion: 'mass' })
    expect(screen.getByRole('alert').textContent).toContain('did you mean "mass"')
    expect(f).toHaveAttribute('aria-invalid', 'true')
    // The fix button repairs the name; the decimal comma is the next thing said.
    fireEvent.click(screen.getByRole('button', { name: /Use/ }))
    expect(f.value).toBe('mass * 0,5')
    expect(screen.getByText(/decimal separator/)).toBeInTheDocument()
  })

  it('does not nag about the name still being typed', () => {
    render(<Host onCommit={() => {}} />)
    const f = field()
    fireEvent.change(f, { target: { value: 'mass * re', selectionStart: 9 } })
    expect(screen.queryByText(/Unknown name/)).toBeNull()
    // Caret moves away from the word: now it is a claim, and it is wrong.
    fireEvent.change(f, { target: { value: 'mass * re ', selectionStart: 10 } })
    expect(screen.getByText(/Unknown name "re"/)).toBeInTheDocument()
  })

  it('commits a clean formula on blur and abandons on Escape', () => {
    const commit = vi.fn()
    const abandon = vi.fn()
    function H() {
      const [v, setV] = useState('mass')
      return (
        <FormulaInput
          value={v}
          onChange={setV}
          params={P}
          placeholder="formula"
          onCommit={commit}
          onAbandon={abandon}
        />
      )
    }
    render(<H />)
    const f = field()
    fireEvent.change(f, { target: { value: 'mass * 2', selectionStart: 8 } })
    fireEvent.blur(f)
    expect(commit).toHaveBeenCalledWith(null)
    fireEvent.keyDown(f, { key: 'Escape' })
    fireEvent.blur(f)
    expect(abandon).toHaveBeenCalledTimes(1)
    expect(commit).toHaveBeenCalledTimes(1) // the blur after Escape is not a commit
  })
  it('completes after an opening bracket, with the list outside any scrolling panel', () => {
    // The inspector's input list scrolls: a list positioned inside it was cut off, and a formula
    // starting with "(" pushed it past the edge with the "not closed" note.
    const { container } = render(
      <div style={{ overflow: 'auto', height: 40 }}>
        <Host onCommit={() => {}} />
      </div>
    )
    const f = field()
    fireEvent.change(f, { target: { value: '(ma', selectionStart: 3 } })
    const list = screen.getByRole('listbox')
    expect(container.contains(list)).toBe(false)
    expect(list.parentElement).toBe(document.body)
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['mass12 kg', 'mass_glass'])
    fireEvent.keyDown(f, { key: 'Enter' })
    expect(f.value).toBe('(mass')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('keeps a name typed in full in the list, and Enter on it commits at once', () => {
    const commit = vi.fn()
    render(<Host onCommit={commit} />)
    const f = field()
    fireEvent.change(f, { target: { value: 'mass', selectionStart: 4 } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['mass12 kg', 'mass_glass'])
    fireEvent.keyDown(f, { key: 'Enter' })
    expect(f.value).toBe('mass')
    expect(screen.queryByRole('listbox')).toBeNull()
    fireEvent.blur(f) // Enter blurs the field in the browser; jsdom needs it said
    expect(commit).toHaveBeenCalledWith(null, 'mass')
    // One letter past the name and nothing matches any more.
    fireEvent.change(f, { target: { value: 'massx', selectionStart: 5 } })
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})
