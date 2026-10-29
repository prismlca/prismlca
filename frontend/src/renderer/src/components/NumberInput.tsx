import { useState, type InputHTMLAttributes } from 'react'

const complete = (raw: string): boolean => raw.trim() !== '' && Number.isFinite(Number(raw))

/**
 * A number field a person can type into.
 *
 * Every number field used to hand each keystroke straight to a handler that coerced and clamped it, and
 * two things broke on the way. An emptied field became the handler's fallback at once —
 * `Number('') || 150`, or the minimum — so the digits typed next were appended to it: Backspace, 64000
 * gave 250 000 tokens. And Chromium reports an unfinished "2." as an empty value, so the handler turned
 * it into 0 and React wrote the 0 back into the field: "2.75" became a cost limit of 75.
 *
 * So the field keeps what is being typed, and the handler only ever sees a complete number — still on
 * every keystroke, so a change applies the moment it is a number (no Save buttons). An empty or
 * unfinished field writes nothing; leaving the field shows the stored value again, clamped as the
 * handler left it. `onValue` receives the raw text, exactly what the old `onChange` handlers parsed.
 */
export function NumberInput({
  value,
  onValue,
  onBlur,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> & {
  value: number
  onValue: (raw: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      {...rest}
      type="number"
      value={draft ?? value}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        if (complete(raw)) onValue(raw)
      }}
      onBlur={(e) => {
        setDraft(null)
        onBlur?.(e)
      }}
    />
  )
}

/**
 * The complete number a field shows, as text — for a handler that saves on blur.
 *
 * During an edit the field shows the draft, and a reload that landed meanwhile may already have put the
 * server's older value back into the parent's state: saving that state on blur dropped what was typed,
 * invisibly, because the field still showed it. Inside `onBlur` the input still
 * shows the draft. Null when it shows no complete number — then the state is all there is.
 */
export function shownNumber(input: HTMLInputElement): string | null {
  return complete(input.value) ? input.value : null
}
