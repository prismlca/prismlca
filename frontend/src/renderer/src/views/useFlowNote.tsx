import { useEffect, useRef, useState } from 'react'
import { CommentIcon } from '../components/icons'

/**
 * The comment on one flow of the inspector: why this amount, this sign, this dataset. A speech bubble in
 * the row opens it under the row — as a field on the user's own processes, as text on a read-only dataset,
 * where ecoinvent and BAFU keep their notes on the exchange (where a value comes from, how it was derived).
 *
 * The bubble and what it opens sit in different places of the row's grid — the bubble in its column, the
 * field across the full width below the remove button — so the hook keeps the state and hands both back
 * for FlowRow to place. A read-only flow without a comment has no bubble (`button` is null).
 */
export function useFlowNote({
  comment,
  readOnly,
  onSave
}: {
  comment: string | null
  readOnly: boolean
  onSave: (comment: string) => void
}): { button: JSX.Element | null; body: JSX.Element | null } {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(comment ?? '')
  useEffect(() => setText(comment ?? ''), [comment])
  const field = useRef<HTMLTextAreaElement>(null)
  // Escape puts the stored comment back and leaves the field; the blur that follows still sees the typed
  // text in its render, so this flag keeps it from writing what was just abandoned.
  const abandoning = useRef(false)

  const button =
    readOnly && !comment ? null : (
      <button
        className={`flow-note-btn${comment && !readOnly ? ' on' : ''}${open ? ' open' : ''}`}
        title={
          readOnly
            ? (comment ?? undefined)
            : comment
              ? `Why: ${comment}`
              : 'Note why this amount is what it is — the sign of a waste flow, a proxy dataset, what a formula expresses'
        }
        aria-label={readOnly ? (open ? 'Hide comment' : 'Show comment') : 'Comment on this flow'}
        aria-expanded={open}
        // A press on the bubble would take the open field's focus, and its blur would close the field
        // before the click opened it again — the bubble could open the field but never close it. So the
        // press leaves the focus where it is, and the click closes through the same blur that writes.
        onMouseDown={(e) => {
          if (open && !readOnly) e.preventDefault()
        }}
        onClick={() => {
          if (!open) return setOpen(true)
          if (field.current && document.activeElement === field.current) field.current.blur()
          else setOpen(false)
        }}
      >
        <CommentIcon />
      </button>
    )

  const body = !open ? null : readOnly ? (
    comment ? (
      <div className="flow-note-text">{comment}</div>
    ) : null
  ) : (
    <textarea
      ref={field}
      className="fx-expand note"
      value={text}
      autoFocus
      placeholder="Why this amount, this sign, this dataset — the sentence a reviewer would ask for"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setOpen(false)
        if (abandoning.current) {
          abandoning.current = false
          return
        }
        if (text.trim() !== (comment ?? '').trim()) onSave(text.trim())
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          abandoning.current = true
          setText(comment ?? '')
          e.currentTarget.blur()
        }
      }}
    />
  )

  return { button, body }
}
