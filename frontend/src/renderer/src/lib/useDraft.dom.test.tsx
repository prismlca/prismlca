import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import EditableField from '../views/EditableField'
import { useDraft } from './useDraft'

/**
 * Types into a field in the very commit that mounts it — after the field is in the page, before React has
 * run that commit's passive effects. Nobody types during a commit; what this forces is the order a busy
 * machine allows, where the passive effects can run in a later task and a keystroke (or a test's change
 * event) comes first. Forced here, that order holds on any machine.
 */
function TypeOnMount({ label, text }: { label: string; text: string }): null {
  useLayoutEffect(() => {
    const input = document.querySelector(`input[aria-label="${label}"]`)
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!(input instanceof HTMLInputElement) || !setValue) throw new Error(`no input named ${label}`)
    // The prototype's setter goes past React's record of the value, so the input event reads as a change.
    setValue.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, [label, text])
  return null
}

function Draft({ saved }: { saved: string }): JSX.Element {
  const [draft, setDraft] = useDraft(saved)
  return <input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
}

describe('useDraft', () => {
  it('keeps what was typed before React ran the effects of the render that showed the field', () => {
    const saves: string[] = []
    render(
      <>
        <EditableField value="water" readOnly={false} ariaLabel="Product" onSave={(v) => saves.push(v)} />
        <TypeOnMount label="Product" text="drinking water" />
      </>
    )
    const field = screen.getByLabelText('Product') as HTMLInputElement
    expect(field.value).toBe('drinking water')
    fireEvent.blur(field)
    expect(saves).toEqual(['drinking water'])
  })

  it('goes back to the saved value when that changes from outside, and not before', () => {
    const { rerender } = render(<Draft saved="water" />)
    const field = screen.getByLabelText('Draft') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'drinking water' } })
    rerender(<Draft saved="water" />)
    expect(field.value).toBe('drinking water')
    rerender(<Draft saved="tap water" />)
    expect(field.value).toBe('tap water')
  })
})
