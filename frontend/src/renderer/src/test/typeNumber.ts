import { fireEvent } from '@testing-library/react'

/** HTML's "valid floating-point number" — what Chromium will report. JavaScript's Number() is looser: it
 *  takes "2." as 2, where the browser reports ''. */
const VALID_FLOAT = /^-?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/

/**
 * Type into an `<input type="number">` the way Chromium reports it, which jsdom and user-event do not.
 *
 * Chromium shows "2." while its `value` says '' — an unfinished number is no number — so the change
 * event carries ''. If React then writes something else into the field (the bug NumberInput exists
 * for), that is what the person sees, and the next keystroke lands after it. jsdom has one value for
 * both, and user-event keeps its own idea of the text, so neither reproduces "2.75" turning into 75.
 */
export function typeLikeChromium(input: HTMLInputElement, text: string): void {
  input.focus() // nobody types into a field without focusing it — and leaving it is what ends the edit
  let visible = input.value
  for (const ch of text) {
    visible += ch
    const reported = VALID_FLOAT.test(visible) ? visible : ''
    fireEvent.change(input, { target: { value: reported } })
    if (input.value !== reported) visible = input.value // React wrote the field back
  }
}

/** Empty the field the way Backspace does — one change event carrying ''. */
export function clearLikeChromium(input: HTMLInputElement): void {
  input.focus()
  fireEvent.change(input, { target: { value: '' } })
}
