import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ConfirmDialog from './ConfirmDialog'
import { writeConfirmSpec } from './ReportSections'

/**
 * The dialog itself, mounted, with the spec the report page's Write button builds.
 *
 * The pure tests next door pin what the question says and that building it writes nothing
 * (views/writeButton.test.ts). What is left is the half that only exists once it is on screen: the
 * button the author presses is the one that runs the write, and the way out of the dialog runs
 * nothing at all. That second half is the whole point of asking.
 */
const chapter = { kind: 'prose', title: 'Interpretation', text: 'The study finds…' }

describe('the confirmation in front of a rewrite', () => {
  it('writes when the author confirms', async () => {
    const user = userEvent.setup()
    const write = vi.fn()
    const spec = writeConfirmSpec(chapter, false, write)!
    render(<ConfirmDialog spec={spec} onClose={() => {}} />)

    await user.click(screen.getByRole('button', { name: 'Replace the chapter' }))
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('writes nothing when they cancel', async () => {
    const user = userEvent.setup()
    const write = vi.fn()
    const closed = vi.fn()
    render(<ConfirmDialog spec={writeConfirmSpec(chapter, false, write)!} onClose={closed} />)

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(write).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('shows the way back in the question, not only in the log afterwards', async () => {
    render(<ConfirmDialog spec={writeConfirmSpec(chapter, false, () => {})!} onClose={() => {}} />)
    expect(screen.getByText(/Put it back/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Replace this chapter?' })).toBeTruthy()
  })
})

/**
 * The three-way question: "undo the whole assistant turn, or only the last change?" has two
 * legitimate ways to proceed, so the dialog grew an optional secondary action. What must hold: each
 * button runs exactly its own handler, both close the dialog, and Cancel still runs neither.
 */
describe('the secondary action', () => {
  const spec = (onConfirm: () => void, onSecondary: () => void) => ({
    title: 'Undo an assistant turn',
    message: 'The last change belongs to an assistant turn with 12 changes.',
    confirmLabel: 'Undo all 12',
    onConfirm,
    secondary: { label: 'Only the last change', onClick: onSecondary }
  })

  it('runs only the chosen action and closes', async () => {
    const whole = vi.fn()
    const single = vi.fn()
    const onClose = vi.fn()
    render(<ConfirmDialog spec={spec(whole, single)} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Only the last change' }))
    expect(single).toHaveBeenCalledOnce()
    expect(whole).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps Cancel as the way out that does nothing', async () => {
    const whole = vi.fn()
    const single = vi.fn()
    const onClose = vi.fn()
    render(<ConfirmDialog spec={spec(whole, single)} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(whole).not.toHaveBeenCalled()
    expect(single).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
