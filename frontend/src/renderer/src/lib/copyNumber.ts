/**
 * A number to the clipboard at full precision, written the way the computer's spreadsheet reads it back.
 *
 * Double-clicking a figure in the inspector or in the Results table copies its value unrounded — the display
 * rounds, the copy does not — and a small note at the pointer says what went to the clipboard. The decimal
 * separator is the one of the computer's regional format, because that is what a spreadsheet parses a pasted
 * number by: "0.5" arrives in a German Excel as a date or as text. No thousands separator, which is read
 * differently from one format to the next, and an exponent the way spreadsheets write it ("1,2E-7").
 */

/** The decimal separator of a locale; '.' when it cannot be told. */
export function decimalSeparator(locale: string): string {
  try {
    return new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.'
  } catch {
    return '.'
  }
}

/** The value as clipboard text: every digit the number holds, the given separator, `E` for an exponent. */
export function clipboardNumber(value: number, separator: string): string {
  const s = String(value).replace('e', 'E')
  return separator === '.' ? s : s.replace('.', separator)
}

let separator: Promise<string> | null = null

/** The regional format's separator, asked of the main process once. Without the bridge (tests, a plain
 *  browser) the display language stands in, which is right more often than a fixed '.'. */
function systemSeparator(): Promise<string> {
  if (!separator) {
    const asked = window.prism?.systemLocale?.() ?? Promise.reject(new Error('no bridge'))
    separator = asked.catch(() => navigator.language).then(decimalSeparator)
  }
  return separator
}

/** Copy `value` and say so beside the pointer. */
export async function copyNumber(value: number, at: { clientX: number; clientY: number }): Promise<void> {
  if (!Number.isFinite(value)) return
  const text = clipboardNumber(value, await systemSeparator())
  try {
    await navigator.clipboard.writeText(text)
    note(`Copied ${text}`, at)
  } catch {
    note('Could not copy to the clipboard', at)
  }
}

/** The note: at the pointer, kept inside the window, gone after a moment. Plain DOM rather than React state,
 *  so any view can copy a number without hosting a component for it. */
function note(text: string, at: { clientX: number; clientY: number }): void {
  document.querySelectorAll('.copy-note').forEach((n) => n.remove())
  const el = document.createElement('div')
  el.className = 'copy-note'
  el.setAttribute('role', 'status')
  el.textContent = text
  document.body.appendChild(el)
  const left = Math.max(4, Math.min(at.clientX + 12, window.innerWidth - el.offsetWidth - 8))
  el.style.left = `${left}px`
  el.style.top = `${Math.max(4, at.clientY - 30)}px`
  setTimeout(() => el.remove(), 1400)
}
