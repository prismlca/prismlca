import { useRef, useState } from 'react'
import { CheckIcon } from '../../components/icons'
import { KINDS } from '../../lib/report/model'

/**
 * "Add chapter" under the chapter list: one button at rest, the kind picker only once it is asked for.
 *
 * Adding a chapter is occasional, and a standing dropdown beside the button reads as a setting of the
 * list rather than as the first half of an action. So the button opens the picker and a confirm beside
 * it; confirming adds the chapter and folds the picker away again. Escape, or the button pressed a
 * second time, backs out without adding anything — the picker keeps the kind last chosen.
 */
export default function AddChapterControl({ onAdd }: { onAdd: (kind: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState('prose')
  const toggle = useRef<HTMLButtonElement>(null)

  const close = (): void => {
    setOpen(false)
    // Back to the button that opened it, or the keyboard lands on the page's first control.
    toggle.current?.focus()
  }

  return (
    <div
      className="rsec-add"
      onKeyDown={(e) => {
        if (open && e.key === 'Escape') {
          // Handled here and nowhere else: this Escape folds the picker, it closes nothing around it.
          e.preventDefault()
          e.stopPropagation()
          close()
        }
      }}
    >
      <button
        ref={toggle}
        type="button"
        className="btn sm"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Add chapter
      </button>
      {open ? (
        <>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Chapter type" autoFocus>
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="act-icon ok"
            aria-label="Add this chapter"
            title="Add this chapter"
            onClick={() => {
              onAdd(kind)
              close()
            }}
          >
            <CheckIcon />
          </button>
        </>
      ) : null}
    </div>
  )
}
