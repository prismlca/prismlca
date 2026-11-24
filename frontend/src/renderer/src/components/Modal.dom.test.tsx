import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
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

/** Create with an empty name used to close the dialog without a word, and a refused name closed it
 *  too — whatever was typed into the other fields was gone. */
describe('Modal keeps its input', () => {
  const fields = [
    { key: 'name', label: 'Model name', value: '', required: true },
    { key: 'goal', label: 'Goal', type: 'textarea', value: '' }
  ]

  it('keeps Create disabled while a required field is blank, also against Enter', () => {
    const onSubmit = vi.fn()
    render(
      <Modal title="New model" submitLabel="Create" onSubmit={onSubmit} onClose={() => {}} fields={fields} />
    )
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement
    const name = screen.getByRole('textbox', { name: 'Model name' })
    expect(create.disabled).toBe(true)
    fireEvent.change(name, { target: { value: '   ' } })
    fireEvent.keyDown(name, { key: 'Enter' })
    expect(create.disabled).toBe(true)
    expect(onSubmit).not.toHaveBeenCalled()
    fireEvent.change(name, { target: { value: 'bottle' } })
    expect(create.disabled).toBe(false)
  })

  it('shows a refusal in the dialog and keeps every field as typed', async () => {
    let refuse: (e: Error) => void = () => {}
    const onSubmit = vi.fn(() => new Promise<void>((_, reject) => (refuse = reject)))
    const onClose = vi.fn()
    render(
      <Modal title="New model" submitLabel="Create" onSubmit={onSubmit} onClose={onClose} fields={fields} />
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Model name' }), { target: { value: 'bottle' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), {
      target: { value: 'Compare two bottles' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'bottle', goal: 'Compare two bottles' })

    // While the write is out the dialog neither submits again, nor closes, nor takes edits the write
    // would not carry.
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Goal' }), {
      target: { value: 'changed meanwhile' }
    })
    expect((screen.getByRole('textbox', { name: 'Goal' }) as HTMLTextAreaElement).value).toBe(
      'Compare two bottles'
    )
    expect(screen.getByRole('dialog').getAttribute('aria-busy')).toBe('true')

    await act(async () => refuse(new Error("Database 'bottle' already exists. — Choose another name.")))
    expect(screen.getByRole('alert').textContent).toBe(
      "Database 'bottle' already exists. — Choose another name."
    )
    expect((screen.getByRole('textbox', { name: 'Model name' }) as HTMLInputElement).value).toBe('bottle')
    expect((screen.getByRole('textbox', { name: 'Goal' }) as HTMLTextAreaElement).value).toBe(
      'Compare two bottles'
    )
    expect(create.disabled).toBe(false)
    expect(onClose).not.toHaveBeenCalled()

    // The next try starts without the old reason.
    fireEvent.click(create)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('opens with the reason it was reopened for, until the next submit', () => {
    render(
      <Modal
        title="Restore under another name"
        submitLabel="Restore"
        error="A workspace named 'B' already exists."
        onSubmit={() => {}}
        onClose={() => {}}
        fields={[{ key: 'name', label: 'Restore it as:', value: 'B', required: true }]}
      />
    )
    expect(screen.getByRole('alert').textContent).toBe("A workspace named 'B' already exists.")
    expect((screen.getByRole('textbox', { name: 'Restore it as:' }) as HTMLInputElement).value).toBe('B')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'C' } })
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
