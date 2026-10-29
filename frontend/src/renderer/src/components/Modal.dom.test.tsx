import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import Modal from './Modal'

describe('Modal keys', () => {
  it('submits on Enter in a text field and closes on Escape', () => {
    const onSubmit = vi.fn()
    const onClose = vi.fn()
    render(
      <Modal
        title="New model"
        submitLabel="Create"
        onSubmit={onSubmit}
        onClose={onClose}
        fields={[{ key: 'name', label: 'Model name', value: '' }]}
      />
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'pet-bottle' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith({ name: 'pet-bottle' })
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/** The exchange dialogs said only "Amount" — no flow, no unit. */
describe('Modal facts and units', () => {
  it('shows the read-only facts above the fields and the unit after the amount', () => {
    render(
      <Modal
        title="Add exchange"
        submitLabel="Add"
        onSubmit={() => {}}
        onClose={() => {}}
        facts={[
          { label: 'Flow', value: 'steel, low-alloyed' },
          { label: 'From', value: 'market for steel · GLO' }
        ]}
        fields={[{ key: 'amount', label: 'Amount', type: 'number', value: '1', unit: 'kg' }]}
      />
    )
    expect(screen.getByText('steel, low-alloyed')).toBeTruthy()
    expect(screen.getByText('market for steel · GLO')).toBeTruthy()
    expect(screen.getByText('kg')).toBeTruthy()
    expect(screen.getByRole('spinbutton')).toBeTruthy()
  })
})
