import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'

import { FlowRow } from './ActivityEditor'

/**
 * The amount field of a process input/output, as it is actually typed into.
 *
 * `parseAmount` has its own tests; this is the other half, and it is the half that was broken. The
 * field was an `<input type="number">` read with `Number(e.target.value)`, and the two failure modes
 * both lived in that wiring rather than in any parser: a comma whose meaning the browser decided
 * (0,5 → 5 on an English-locale machine), and `Number('')` being 0, so anything the field refused —
 * or simply clearing it — wrote a zero over the amount that was there.
 *
 * So every case below goes through a mounted field: type, blur, and see what the process would be
 * asked to store. jsdom does not localise a number input at all, which is exactly why the test is
 * written against a TEXT field — the day someone puts `type="number"` back, the comma cases fail
 * here instead of on a stranger's machine.
 */
const flow = {
  uid: 'x1',
  input: { database: 'fg', code: 'c1', name: 'tap water', unit: 'kg', location: null },
  amount: 2,
  type: 'technosphere',
  direction: 'input' as const,
  formula: null,
  comment: null
}

/** Mount one editable row and return its amount field plus the commits it produced. */
function field(
  amount = 2,
  reference = false
): {
  input: HTMLInputElement
  onAmount: ReturnType<typeof vi.fn>
} {
  const onAmount = vi.fn()
  const { container } = render(
    <FlowRow
      flow={{ ...flow, amount }}
      readOnly={false}
      reference={reference}
      onAmount={onAmount}
      onFormula={vi.fn()}
      onComment={vi.fn()}
      onRemove={vi.fn()}
    />
  )
  const input = container.querySelector('.flow-amt input') as HTMLInputElement
  return { input, onAmount }
}

/** Type a value and leave the field, which is what commits it. */
function type(input: HTMLInputElement, text: string): void {
  fireEvent.change(input, { target: { value: text } })
  fireEvent.blur(input)
}

describe('the amount field stores the number that was typed', () => {
  it('reads a decimal comma as a decimal comma', () => {
    const { input, onAmount } = field()
    type(input, '0,5')
    expect(onAmount).toHaveBeenCalledWith('x1', 0.5)
    // And it says so: the field reads back in the app's own notation, so nobody has to guess
    // whether the comma was understood.
    expect(input.value).toBe('0.5')
  })

  it('still reads a decimal point, and the grouped spellings of one number', () => {
    for (const [typed, stored] of [
      ['0.5', 0.5],
      ['1.234,5', 1234.5],
      ['1,234.5', 1234.5],
      ['2,5e-3', 0.0025],
      ['-0,5', -0.5]
    ] as const) {
      const { input, onAmount } = field()
      type(input, typed)
      expect(onAmount, typed).toHaveBeenCalledWith('x1', stored)
    }
  })

  it('is not a number input, because that field asked the machine what a comma means', () => {
    const { input } = field()
    expect(input.getAttribute('type')).toBe('text')
    expect(input.getAttribute('inputmode')).toBe('decimal')
  })
})

describe('the amount field refuses rather than writing a zero', () => {
  it('keeps the stored amount when the field is cleared', () => {
    // `Number('')` is 0: clearing the field and tabbing away used to set the amount to zero.
    const { input, onAmount } = field(2)
    type(input, '')
    expect(onAmount).not.toHaveBeenCalled()
    expect(input.value).toBe('2')
  })

  it('keeps the stored amount when the text is not a number', () => {
    for (const bad of ['abc', '12,345,67', '1.2.3', '-']) {
      const { input, onAmount } = field(2)
      type(input, bad)
      expect(onAmount, bad).not.toHaveBeenCalled()
      expect(input.value, bad).toBe('2')
    }
  })

  it('says so while the text is being typed, before anything is committed', () => {
    const { input } = field()
    fireEvent.change(input, { target: { value: '0,5,5' } })
    expect(input.className).toContain('refused')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    // A half-typed number is not an error: "0," is on the way to 0,5.
    fireEvent.change(input, { target: { value: '0,' } })
    expect(input.className).not.toContain('refused')
  })

  it('writes nothing when the number is the one already stored', () => {
    const { input, onAmount } = field(0.5)
    type(input, '0,5')
    expect(onAmount).not.toHaveBeenCalled()
  })

  it('abandons the edit on Escape', () => {
    const { input, onAmount } = field(2)
    // Focused, so Escape's own blur really fires — the commit it triggers is the one that must not write.
    input.focus()
    fireEvent.change(input, { target: { value: '99' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(onAmount).not.toHaveBeenCalled()
    expect(input.value).toBe('2')
  })
})

/**
 * The reference row's amount: every other flow of the process is per this amount, so a zero leaves
 * nothing to scale — refused in the field instead of waiting for the health check. A negative amount
 * stays allowed: that is how a treatment process is written.
 */
describe('the reference amount', () => {
  it('refuses zero and keeps the stored amount', () => {
    const { input, onAmount } = field(1, true)
    fireEvent.change(input, { target: { value: '0' } })
    expect(input.className).toContain('refused')
    expect(input.title).toContain('cannot be zero')
    fireEvent.blur(input)
    expect(onAmount).not.toHaveBeenCalled()
    expect(input.value).toBe('1')
  })

  it('takes a negative amount, the sign of a treatment process', () => {
    const { input, onAmount } = field(1, true)
    type(input, '-1')
    expect(onAmount).toHaveBeenCalledWith('x1', -1)
  })

  it('leaves zero allowed on an ordinary input', () => {
    const { input, onAmount } = field(2)
    type(input, '0')
    expect(onAmount).toHaveBeenCalledWith('x1', 0)
  })
})
