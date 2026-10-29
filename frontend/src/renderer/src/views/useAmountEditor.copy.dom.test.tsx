// @vitest-environment jsdom
/**
 * Double-click to copy, in the inspector: only where the amount cannot be edited (a background dataset's).
 * In an editable field the double-click stays the ordinary one — selecting the number to type over it.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAmountEditor } from './useAmountEditor'

function Cell({ readOnly }: { readOnly: boolean }): JSX.Element {
  const { cell } = useAmountEditor({
    flow: { uid: 'u1', amount: 0.123456789, formula: null },
    readOnly,
    reference: false,
    params: null,
    onAmount: () => {},
    onFormula: () => {}
  })
  return cell
}

const writeText = vi.fn(async () => {})
beforeEach(() => {
  writeText.mockClear()
  Object.assign(navigator, { clipboard: { writeText } })
})
afterEach(() => document.querySelectorAll('.copy-note').forEach((n) => n.remove()))

describe('copying an inspector amount', () => {
  it('copies the unrounded amount of a background dataset', async () => {
    const { container } = render(<Cell readOnly />)
    await act(async () => {
      fireEvent.doubleClick(container.querySelector('.flow-amt.ro') as HTMLElement)
    })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(String((writeText.mock.calls[0] as unknown as [string])[0]).replace(',', '.')).toBe('0.123456789')
    expect(document.querySelector('.copy-note')?.textContent).toMatch(/^Copied 0[.,]123456789$/)
  })

  it('leaves an editable amount alone', async () => {
    render(<Cell readOnly={false} />)
    await act(async () => {
      fireEvent.doubleClick(screen.getByRole('textbox'))
    })
    expect(writeText).not.toHaveBeenCalled()
  })
})
