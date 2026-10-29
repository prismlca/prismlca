import EscapeCloser from '../components/EscapeCloser'
/** In-app confirmation window (replaces window.confirm), styled like the other modals. */
export interface ConfirmSpec {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  /** Cancel, Escape or a click beside the dialog — for a caller that is waiting on the answer either way
   *  (the assistant's remove_from_canvas reported success before the question was even shown). */
  onCancel?: () => void
  /** A second way to proceed, rendered between Cancel and the main action — for the questions with
   *  two legitimate answers ("the whole assistant turn, or only the last change?"). Cancel remains
   *  the way out; this is never a disguised second Cancel. */
  secondary?: { label: string; onClick: () => void }
  /** A notice, not a question: something already happened and has to be said out loud (replaces
   *  window.alert). Only the confirm button is rendered, labelled "OK" unless overridden. */
  notice?: boolean
}

export default function ConfirmDialog({
  spec,
  onClose
}: {
  spec: ConfirmSpec
  onClose: () => void
}): JSX.Element {
  const dismiss = (): void => {
    spec.onCancel?.()
    onClose()
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      <EscapeCloser onClose={dismiss} />
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{spec.title}</h3>
        <p className="confirm-msg">{spec.message}</p>
        <div className="modal-actions">
          {spec.notice ? null : (
            <button className="btn sm" onClick={dismiss}>
              Cancel
            </button>
          )}
          {spec.secondary ? (
            <button
              className="btn sm"
              onClick={() => {
                spec.secondary!.onClick()
                onClose()
              }}
            >
              {spec.secondary.label}
            </button>
          ) : null}
          <button
            className={`btn sm ${spec.danger ? 'danger' : 'primary'}`}
            onClick={() => {
              spec.onConfirm()
              onClose()
            }}
            autoFocus
          >
            {spec.confirmLabel ?? (spec.notice ? 'OK' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
