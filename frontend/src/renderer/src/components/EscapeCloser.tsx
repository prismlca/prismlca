import { useEffect, useRef } from 'react'

/**
 * Escape closes the dialog it is rendered in — the topmost one, when dialogs stack.
 *
 * No dialog in the app answered Escape (V333): every one of them closed on the ✕, on Cancel
 * or on a click beside it, and nothing else. Rendered as the first child of a `.modal-backdrop`, this
 * registers the dialog's close on a module-level stack while it is mounted; one window listener closes
 * whatever is on top. A confirm over a sheet therefore takes the first Escape, the sheet the second.
 *
 * A field that gives Escape its own meaning (abandon this edit, close this suggestion list) calls
 * `stopPropagation()` in its handler, and the dialog stays.
 */
const stack: Array<{ current: () => void }> = []

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  const top = stack[stack.length - 1]
  if (!top) return
  e.preventDefault()
  top.current()
}

export default function EscapeCloser({ onClose }: { onClose: () => void }): null {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    const entry = { current: () => ref.current() }
    if (!stack.length) window.addEventListener('keydown', onKey)
    stack.push(entry)
    return () => {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
      if (!stack.length) window.removeEventListener('keydown', onKey)
    }
  }, [])
  return null
}
