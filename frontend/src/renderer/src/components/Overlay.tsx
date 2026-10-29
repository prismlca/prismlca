import type { ReactNode } from 'react'
import EscapeCloser from './EscapeCloser'

/**
 * The full-screen backdrop + click-shield pair seven views had each hand-rolled: clicking the
 * backdrop closes, clicking the content does not (stopPropagation), and nothing else. The `.overlay`
 * styling stays in index.css — this is the behaviour, written once.
 *
 * Escape too: the four report dialogs built on this had no EscapeCloser, so the key left them standing
 * — or closed a registered dialog underneath instead.
 */
export default function Overlay({
  onClose,
  className,
  children
}: {
  onClose: () => void
  /** Class for the content wrapper (e.g. "modal rsec-plan"); absent = bare wrapper, as before. */
  className?: string
  children: ReactNode
}): JSX.Element {
  return (
    // Mousedown on the backdrop itself, like .modal-backdrop: a text selection dragged out of the
    // sheet and released beside it used to count as a click and close the window.
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={onClose} />
      <div className={className} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  )
}
