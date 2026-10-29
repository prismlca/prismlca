import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import ReferenceProduct from './ReferenceProduct'

/** The block on its own, for what the inspector's mounting hides. */
const flow = (uid: string, amount: number) => ({
  uid,
  amount,
  formula: null,
  comment: null,
  input: { name: 'Processing', code: uid }
})
const props = {
  product: 'PET flakes',
  unit: 'kg',
  readOnly: false,
  unitVocab: [] as string[],
  restrictUnits: false,
  params: null,
  unitNotice: null,
  onField: vi.fn(),
  onAmount: vi.fn(),
  onFormula: vi.fn(),
  onComment: vi.fn(),
  onShowProperties: vi.fn()
}

describe('ReferenceProduct', () => {
  it('drops a formula draft when it is handed another process’s exchange', () => {
    // The library sheet mounts the editor without a key, so the block itself is keyed by the exchange.
    const { container, rerender } = render(<ReferenceProduct {...props} flow={flow('a', 1)} />)
    fireEvent.click(screen.getByText('fx'))
    expect(container.querySelector('.fx-input')).not.toBeNull()
    rerender(<ReferenceProduct {...props} flow={flow('b', 1)} />)
    expect(container.querySelector('.fx-input')).toBeNull()
    expect((container.querySelector('.flow-amt input') as HTMLInputElement).value).toBe('1')
  })

  it('names the unit field when it suggests units from the first character', () => {
    render(<ReferenceProduct {...props} unitVocab={['kg', 't']} flow={flow('a', 1)} />)
    expect((screen.getByLabelText('Unit') as HTMLInputElement).value).toBe('kg')
  })
})
