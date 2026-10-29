/**
 * The fx toggle and the formula field of one flow row, together — the sequence that went wrong:
 * type a formula with an unknown name, leave it refused, toggle fx off and on again, and
 * the field showed the abandoned text with its warning instead of what the model stores.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { FlowRow } from './ActivityEditor'

const flow = {
  uid: 'u1',
  type: 'technosphere',
  amount: 2,
  input: { database: 'eco', code: 'x', name: 'steel', unit: 'kg', location: 'GLO', categories: [] },
  direction: 'input' as const,
  formula: null,
  comment: null
}

function mount(): { onFormula: ReturnType<typeof vi.fn>; toggle: () => void; container: HTMLElement } {
  const onFormula = vi.fn()
  const { container } = render(
    <FlowRow
      flow={flow}
      readOnly={false}
      reference={false}
      params={[{ name: 'mass' }]}
      onAmount={vi.fn()}
      onFormula={onFormula}
      onComment={vi.fn()}
      onRemove={vi.fn()}
    />
  )
  const toggle = (): void => {
    fireEvent.click(container.querySelector('.fxtog') as HTMLElement)
  }
  return { onFormula, toggle, container }
}

const editor = (c: HTMLElement): HTMLTextAreaElement | null => c.querySelector('textarea.fx-expand')

describe('the fx toggle and its formula field', () => {
  it('drops a refused formula when fx is toggled off, and reopens on what is stored', () => {
    const { onFormula, toggle, container } = mount()
    toggle()
    const f = editor(container)!
    fireEvent.change(f, { target: { value: 'abc * 2', selectionStart: 7 } })
    fireEvent.blur(f)
    expect(onFormula).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Unknown name "abc"')
    expect(editor(container)).not.toBeNull() // stays open, with the problem under it

    toggle() // off: back to the plain amount, nothing written
    expect(editor(container)).toBeNull()
    expect(container.querySelector('.fx-problem')).toBeNull()
    expect(onFormula).not.toHaveBeenCalled()

    toggle() // on again: the stored (empty) formula, no leftover warning
    expect(editor(container)!.value).toBe('')
    expect(container.querySelector('.fx-problem')).toBeNull()
  })

  it('writes a clean formula on Enter', () => {
    const { onFormula, toggle, container } = mount()
    toggle()
    const f = editor(container)!
    fireEvent.change(f, { target: { value: 'mass * 2', selectionStart: 8 } })
    fireEvent.keyDown(f, { key: 'Enter' })
    fireEvent.blur(f)
    expect(onFormula).toHaveBeenCalledWith('u1', 'mass * 2')
    expect(editor(container)).toBeNull()
  })
})
