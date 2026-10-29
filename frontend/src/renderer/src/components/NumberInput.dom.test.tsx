import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { NumberInput } from './NumberInput'
import { clearLikeChromium, typeLikeChromium } from '../test/typeNumber'

/** The handlers below are the shapes the app's fields had: a clamp with a floor, a `||` fallback, cents. */
const tokens = (v: string): number => Math.max(20_000, Math.min(250_000, Math.round(Number(v))))
const rounds = (v: string): number => Math.max(1, Math.min(400, Math.round(Number(v) || 150)))
const cost = (v: string): number => Math.max(0, Math.min(100, Math.round((Number(v) || 0) * 100) / 100))

function Field({
  start,
  coerce,
  onBlur
}: {
  start: number
  coerce: (v: string) => number
  onBlur?: () => void
}) {
  const [stored, setStored] = useState(start)
  return (
    <>
      <NumberInput aria-label="n" value={stored} onValue={(raw) => setStored(coerce(raw))} onBlur={onBlur} />
      <output>{stored}</output>
    </>
  )
}

/** The wiring every field had before — kept here so the Chromium helper is shown to reproduce the bug. */
function OldField({ start, coerce }: { start: number; coerce: (v: string) => number }) {
  const [stored, setStored] = useState(start)
  return (
    <>
      <input
        aria-label="n"
        type="number"
        value={stored}
        onChange={(e) => setStored(coerce(e.target.value))}
      />
      <output>{stored}</output>
    </>
  )
}

const field = (): HTMLInputElement => screen.getByLabelText('n') as HTMLInputElement
const stored = (): string => screen.getByRole('status').textContent ?? ''

describe('NumberInput', () => {
  it('reproduces the bug with the old wiring — the helper is honest', () => {
    render(<OldField start={20} coerce={cost} />)
    clearLikeChromium(field())
    typeLikeChromium(field(), '2.75')
    expect(stored()).toBe('75')
  })

  it('takes a decimal typed through its unfinished "2." state', () => {
    render(<Field start={20} coerce={cost} />)
    clearLikeChromium(field())
    typeLikeChromium(field(), '2.75')
    expect(stored()).toBe('2.75')
    clearLikeChromium(field())
    typeLikeChromium(field(), '0.5')
    expect(stored()).toBe('0.5')
  })

  it('does not jump to a floor or fallback when emptied, so typed digits are not appended to it', async () => {
    const user = userEvent.setup()
    render(<Field start={50_000} coerce={tokens} />)
    await user.clear(field())
    await user.type(field(), '64000')
    await user.tab()
    expect(stored()).toBe('64000')

    const { unmount } = render(<Field start={150} coerce={rounds} />)
    const r = screen.getAllByLabelText('n')[1] as HTMLInputElement
    await user.clear(r)
    await user.type(r, '37')
    await user.tab()
    expect(screen.getAllByRole('status')[1]).toHaveTextContent('37')
    unmount()
  })

  it('writes nothing while empty, and shows the stored value again on leaving', async () => {
    const user = userEvent.setup()
    render(<Field start={20} coerce={cost} />)
    await user.clear(field())
    expect(field().value).toBe('')
    expect(stored()).toBe('20') // an empty cost field no longer switches the brake off
    await user.tab()
    expect(field()).toHaveValue(20)
  })

  it('shows what was typed while editing and the clamped value once left', async () => {
    const user = userEvent.setup()
    render(<Field start={150} coerce={rounds} />)
    await user.clear(field())
    await user.type(field(), '500')
    expect(field().value).toBe('500')
    expect(stored()).toBe('400')
    await user.tab()
    expect(field()).toHaveValue(400)
  })

  it('applies a spinner step at once and hands the blur on', () => {
    const blurred = vi.fn()
    render(<Field start={20} coerce={cost} onBlur={blurred} />)
    fireEvent.change(field(), { target: { value: '20.5' } }) // what the arrow writes
    expect(stored()).toBe('20.5')
    fireEvent.blur(field())
    expect(blurred).toHaveBeenCalledTimes(1)
  })

  it('passes the other attributes through and renders a number field', () => {
    render(<NumberInput aria-label="n" value={3} onValue={() => {}} min={1} max={12} step={0.5} disabled />)
    expect(field()).toHaveAttribute('type', 'number')
    expect(field()).toHaveAttribute('min', '1')
    expect(field()).toHaveAttribute('step', '0.5')
    expect(field()).toBeDisabled()
    expect(field()).toHaveValue(3)
  })
})
