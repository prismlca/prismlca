import type { ReactNode } from 'react'
import EscapeCloser from './EscapeCloser'
import DialogBox from './DialogBox'

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
  label,
  children
}: {
  onClose: () => void
  children: ReactNode
} & (
  | {
      /** Class for the content box (e.g. "modal rsec-plan"), which is then the dialog (DialogBox). */
      className: string
      /** The dialog's accessible name. */
      label: string
    }
  | {
      /** Absent: a bare wrapper, and the child is the dialog itself (Setup renders its own box). */
      className?: undefined
      label?: undefined
    }
)): JSX.Element {
  return (
    // Mousedown on the backdrop itself, like .modal-backdrop: a text selection dragged out of the
    // sheet and released beside it used to count as a click and close the window.
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={onClose} />
      {className === undefined ? (
        <div onClick={(e) => e.stopPropagation()}>{children}</div>
      ) : (
        <DialogBox className={className} label={label}>
          {children}
        </DialogBox>
      )}
    </div>
  )
}
