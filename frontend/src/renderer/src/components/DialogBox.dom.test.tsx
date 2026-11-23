import { StrictMode, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DialogBox from './DialogBox'

/**
 * What a dialog owes a screen reader and a keyboard: a role and a name, the focus inside when it opens,
 * and the focus back where it was when it closes — unless the close put it somewhere on purpose.
 */
function Host({ field = false, strict = false }: { field?: boolean; strict?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const dialog = open ? (
    <DialogBox className="modal" label="New model">
      {field ? <input aria-label="Model name" autoFocus /> : <p>Nothing to type here.</p>}
      <button onClick={() => setOpen(false)}>Cancel</button>
      <button
        onClick={() => {
          document.querySelector<HTMLElement>('[aria-label="Elsewhere"]')?.focus()
          setOpen(false)
        }}
      >
        Go elsewhere
      </button>
    </DialogBox>
  ) : null
  const page = (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <input aria-label="Elsewhere" />
      {dialog}
    </>
  )
  return strict ? <StrictMode>{page}</StrictMode> : page
}

describe('DialogBox', () => {
  it('is a modal dialog with a name', async () => {
    render(<Host />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    const dialog = screen.getByRole('dialog', { name: 'New model' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveClass('modal')
  })

  it('takes the focus when nothing inside does, so Tab starts in the dialog', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    const dialog = screen.getByRole('dialog', { name: 'New model' })
    expect(dialog).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('leaves the focus with a field that took it', async () => {
    render(<Host field />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('textbox', { name: 'Model name' })).toHaveFocus()
  })

  it('leaves it there in development too, where StrictMode mounts the box twice', async () => {
    render(<Host field strict />)
    await userEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(screen.getByRole('textbox', { name: 'Model name' })).toHaveFocus()
  })

  it('hands the focus back to what opened it when it closes', async () => {
    const user = userEvent.setup()
    render(<Host field />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus()
  })

  it('keeps a focus the close put somewhere on purpose', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    await user.click(screen.getByRole('button', { name: 'Go elsewhere' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Elsewhere' })).toHaveFocus()
  })

  it('keeps a click inside from reaching the backdrop', () => {
    const backdrop = vi.fn()
    render(
      <div onClick={backdrop}>
        <DialogBox label="Sheet">
          <button>Inside</button>
        </DialogBox>
      </div>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }))
    expect(backdrop).not.toHaveBeenCalled()
  })

  it('keeps Tab inside the dialog, both ways, and brings a dropped focus back in', async () => {
    const user = userEvent.setup()
    render(<Host field />)
    await user.click(screen.getByRole('button', { name: 'Open' }))
    const name = screen.getByRole('textbox', { name: 'Model name' })
    const last = screen.getByRole('button', { name: 'Go elsewhere' })
    await user.tab()
    await user.tab()
    expect(last).toHaveFocus()
    await user.tab()
    expect(name).toHaveFocus()
    await user.tab({ shift: true })
    expect(last).toHaveFocus()
    // The focused control vanished and the focus fell to <body>: Tab starts in the dialog again.
    last.blur()
    await user.tab()
    expect(name).toHaveFocus()
  })

  it("leaves a field's own Tab alone", async () => {
    const user = userEvent.setup()
    render(
      <DialogBox label="Formula">
        <button>Before</button>
        {/* The last stop, where the dialog's own wrap would otherwise take Tab to "Before". */}
        <input aria-label="Formula" onKeyDown={(e) => e.key === 'Tab' && e.preventDefault()} />
      </DialogBox>
    )
    const field = screen.getByRole('textbox', { name: 'Formula' })
    field.focus()
    await user.tab()
    expect(field).toHaveFocus()
  })

  it('counts a group of radio buttons as one stop', async () => {
    const user = userEvent.setup()
    render(
      <DialogBox label="Pick">
        <button>First</button>
        <input type="radio" name="g" aria-label="A" />
        <input type="radio" name="g" aria-label="B" defaultChecked />
        <input type="radio" name="g" aria-label="C" />
      </DialogBox>
    )
    screen.getByRole('radio', { name: 'B' }).focus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus()
  })

  it('the topmost of stacked dialogs holds Tab; closing it gives the focus back inside the one below', async () => {
    const user = userEvent.setup()
    function Stack(): JSX.Element {
      const [confirm, setConfirm] = useState(false)
      return (
        <DialogBox label="Sheet">
          <button onClick={() => setConfirm(true)}>Delete</button>
          <button>Other</button>
          {confirm ? (
            <DialogBox label="Delete?">
              <button onClick={() => setConfirm(false)}>Cancel</button>
              <button>Confirm</button>
            </DialogBox>
          ) : null}
        </DialogBox>
      )
    }
    render(<Stack />)
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('dialog', { name: 'Delete?' })).toHaveFocus()
    await user.tab()
    await user.tab()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus()
  })

  it('a dialog that replaced another gives the focus back to where the first was opened from', async () => {
    const user = userEvent.setup()
    // Distances → "Settings": the button that was pressed goes down with Distances.
    function Handover(): JSX.Element {
      const [shown, setShown] = useState<'none' | 'distances' | 'settings'>('none')
      return (
        <>
          <button onClick={() => setShown('distances')}>Distances</button>
          {shown === 'distances' ? (
            <DialogBox label="Distances">
              <button onClick={() => setShown('settings')}>Open settings</button>
            </DialogBox>
          ) : null}
          {shown === 'settings' ? (
            <DialogBox label="Settings">
              <button onClick={() => setShown('none')}>Close</button>
            </DialogBox>
          ) : null}
        </>
      )
    }
    render(<Handover />)
    await user.click(screen.getByRole('button', { name: 'Distances' }))
    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.getByRole('button', { name: 'Distances' })).toHaveFocus()
  })
})
