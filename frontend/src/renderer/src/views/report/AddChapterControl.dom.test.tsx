import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import AddChapterControl from './AddChapterControl'

/** "Add chapter" is one button at rest; the kind picker and its confirm appear only when asked for. */
describe('Add chapter', () => {
  const button = (): HTMLElement => screen.getByRole('button', { name: 'Add chapter' })

  it('shows only the button until it is pressed', () => {
    render(<AddChapterControl onAdd={vi.fn()} />)
    expect(button().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Chapter type')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add this chapter' })).toBeNull()
  })

  it('opens the kind picker with a confirm, adds the chosen kind and folds away again', () => {
    const onAdd = vi.fn()
    render(<AddChapterControl onAdd={onAdd} />)
    fireEvent.click(button())
    expect(button().getAttribute('aria-expanded')).toBe('true')
    const picker = screen.getByLabelText('Chapter type')
    expect(picker).toHaveFocus()
    fireEvent.change(picker, { target: { value: 'conclusions' } })
    const confirm = screen.getByRole('button', { name: 'Add this chapter' })
    expect(confirm.getAttribute('title')).toBe('Add this chapter')
    expect(confirm.querySelector('svg')).not.toBeNull()
    fireEvent.click(confirm)
    expect(onAdd).toHaveBeenCalledWith('conclusions')
    expect(screen.queryByLabelText('Chapter type')).toBeNull()
    expect(button()).toHaveFocus()
  })

  it('backs out on Escape without adding, and hands the focus back to the button', () => {
    const onAdd = vi.fn()
    render(<AddChapterControl onAdd={onAdd} />)
    fireEvent.click(button())
    fireEvent.keyDown(screen.getByLabelText('Chapter type'), { key: 'Escape' })
    expect(screen.queryByLabelText('Chapter type')).toBeNull()
    expect(button()).toHaveFocus()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('closes when the button is pressed a second time', () => {
    const onAdd = vi.fn()
    render(<AddChapterControl onAdd={onAdd} />)
    fireEvent.click(button())
    fireEvent.click(button())
    expect(screen.queryByLabelText('Chapter type')).toBeNull()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('starts on a prose chapter and remembers the kind last chosen', () => {
    const onAdd = vi.fn()
    render(<AddChapterControl onAdd={onAdd} />)
    fireEvent.click(button())
    expect((screen.getByLabelText('Chapter type') as HTMLSelectElement).value).toBe('prose')
    fireEvent.change(screen.getByLabelText('Chapter type'), { target: { value: 'conclusions' } })
    fireEvent.keyDown(screen.getByLabelText('Chapter type'), { key: 'Escape' })
    fireEvent.click(button())
    expect((screen.getByLabelText('Chapter type') as HTMLSelectElement).value).toBe('conclusions')
  })
})
