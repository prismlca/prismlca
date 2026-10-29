import { useState, type InputHTMLAttributes } from 'react'

/**
 * A text field that reads like the display and edits like the data: while it is idle it shows `idle` —
 * the stored number rounded to the Settings digits — and from the moment it takes focus the full `value`,
 * so every keystroke lands on the number that is actually stored. Selecting and copying need focus too,
 * so what leaves the field is always the full value.
 *
 * The caller decides when there is anything to round: `idle` is null while the field holds text that is
 * not (yet) the stored number — a refused entry, or one whose write has not come back — because hiding
 * that behind a rounded figure would show a value the model does not have.
 *
 * Commits must read the caller's own state, never the element's: on blur the element may already show the
 * idle text again.
 */
export function IdleRoundedInput({
  value,
  idle,
  title,
  onFocus,
  onBlur,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value'> & {
  value: string
  idle: string | null
}): JSX.Element {
  const [focused, setFocused] = useState(false)
  const rounded = !focused && idle !== null && idle !== value
  return (
    <input
      {...rest}
      value={rounded ? idle : value}
      // The full number one hover away, unless the field has something more urgent to say.
      title={title ?? (rounded ? value : undefined)}
      onFocus={(e) => {
        setFocused(true)
        onFocus?.(e)
      }}
      onBlur={(e) => {
        setFocused(false)
        onBlur?.(e)
      }}
    />
  )
}
