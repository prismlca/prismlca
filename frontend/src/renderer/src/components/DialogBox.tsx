import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { holdTab, returnTarget } from './dialogFocus'

/**
 * The box of a modal dialog, the element inside its backdrop: what makes a sheet a dialog for a screen
 * reader and the keyboard, and not only for the eye.
 *
 * - The dialog role, `aria-modal` and a name, so assistive technology announces the sheet as a dialog
 *   called "Settings" rather than as a run of text that appeared somewhere in the page. A name that
 *   stays the same while the sheet's content changes is also what a driver or a test finds it by.
 * - The focus moves into the box when it opens, because a screen reader announces a dialog when the
 *   focus enters it, not when it is painted. A field inside that took the focus first (`autoFocus`, or
 *   its own effect) keeps it; otherwise the box itself takes it (tabIndex -1: reachable by script, never
 *   by Tab), so the next Tab lands on the dialog's first control instead of on the page behind it.
 * - While it is the topmost dialog, Tab and Shift+Tab go round its controls and never out into the page
 *   behind the backdrop (dialogFocus.ts).
 * - When the dialog closes, the focus goes back to what had it before, so a keyboard user carries on
 *   where they opened the dialog instead of at the top of the window — also when that control went down
 *   with a dialog this one replaced. Only if the focus went down with the dialog: a close that put it
 *   somewhere on purpose keeps it there.
 * - A click inside does not reach the backdrop, which closes the dialog on a click beside the box.
 */
export default function DialogBox({
  label,
  children,
  ...rest
}: {
  /** The dialog's accessible name: its title, or what the title says when it carries more than a name. */
  label: string
  children: ReactNode
} & Omit<
  HTMLAttributes<HTMLDivElement>,
  'role' | 'tabIndex' | 'onClick' | 'aria-label' | 'aria-labelledby' | 'aria-modal'
>): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  // Read while rendering: in the commit that follows, a field inside may already take the focus.
  const [opener] = useState(() => document.activeElement)
  useEffect(() => {
    const el = box.current
    if (!el) return
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true })
    const release = holdTab(el, opener)
    return () => {
      release()
      // Only a focus that went down with the box is handed back: it is on <body> once the box has left
      // the page. One still inside (StrictMode's trial unmount in development) or put elsewhere on
      // purpose stays where it is.
      const now = document.activeElement
      if (now && now !== document.body) return
      returnTarget(opener)?.focus({ preventScroll: true })
    }
  }, [opener])
  return (
    <div
      {...rest}
      ref={box}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}
