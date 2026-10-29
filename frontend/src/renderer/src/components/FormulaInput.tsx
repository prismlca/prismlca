import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  insertName,
  lintFormula,
  replaceName,
  suggest,
  wordAt,
  type FormulaProblem,
  type ParamName
} from '../lib/formula'

/**
 * A formula field that knows the model's parameters.
 *
 * Two things the plain textarea it replaces could not do. **Completion**: from the first letter of a
 * name, the parameters that match pop up under the field — arrow keys, Enter or Tab to take one, a click
 * works too. A parameter name is the one thing in a formula that has to be typed exactly, and until now
 * it had to be remembered or copied from the Parameters page. **Refusal where it is typed**: the formula
 * is read while it is written (`lintFormula`), and a commit with a problem does not go to the server —
 * the text stays in the field with the sentence under it. Before, the server's answer came back after the
 * write, about a field that had already closed.
 *
 * Commit semantics follow `CellInput` on the Parameters page: Enter (Shift+Enter for a newline in the
 * multi-line form) and blur commit, Escape abandons — and beats the blur it triggers, via a ref, because
 * state is one render too late for that.
 */
export default function FormulaInput({
  value,
  onChange,
  params,
  self,
  placeholder,
  autoFocus,
  className,
  multiline = true,
  onCommit,
  onAbandon,
  commitOnBlur = true,
  isPlainValue
}: {
  value: string
  onChange: (v: string) => void
  /** The parameters to complete; null while unknown (then names are not checked). */
  params: readonly ParamName[] | null
  /** The parameter whose own formula this is — it may not name itself. */
  self?: string
  placeholder?: string
  autoFocus?: boolean
  className?: string
  /** A textarea (default) or a single-line input. */
  multiline?: boolean
  /** Enter, or the field losing focus. `problem` is null when the text may be written; otherwise the
   *  caller keeps the field as it is — the problem is already on screen under it. */
  onCommit?: (problem: FormulaProblem | null) => void
  /** Escape with the completion list closed. */
  onAbandon?: () => void
  /** false = only Enter commits; a blur leaves the text as typed. For a form whose commit CREATES
   *  something (the new-parameter row), where tabbing on must not be the same as pressing Enter. */
  commitOnBlur?: boolean
  /** For a field that takes a number OR a formula (a scenario override): text this accepts as a plain
   *  number is not linted — a decimal comma is a number there, not a formula mistake. */
  isPlainValue?: (v: string) => boolean
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null)
  const [caret, setCaret] = useState(value.length)
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  // A commit was refused: the problem line turns from a note into a refusal, and the field goes red.
  const [tried, setTried] = useState(false)
  const abandoned = useRef(false)
  const pendingCaret = useRef<number | null>(null)

  const problem = useMemo(
    () => (isPlainValue?.(value) ? null : lintFormula(value, params, { self })),
    [value, params, self, isPlainValue]
  )
  const word = wordAt(value, caret)
  const items = useMemo(
    () => (open && params ? suggest(word.prefix, params) : []),
    [open, params, word.prefix]
  )
  // Where the list goes on screen. It used to hang below the combo box in normal flow, absolutely
  // positioned — and the inspector's input list scrolls, so it cut the list off. It showed sometimes and
  // not at others: a formula starting with "(" put the "not closed" note between the field and the
  // list, pushing the list past the scroll box's edge. Now it is fixed to the field,
  // rendered into <body>, and opens upwards when there is no room below.
  const listOpen = open && items.length > 0
  const [place, setPlace] = useState<{
    left: number
    width: number
    top?: number
    bottom?: number
    maxHeight: number
  } | null>(null)
  useLayoutEffect(() => {
    if (!listOpen) return setPlace(null)
    const measure = (): void => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom - 8
      const above = r.top - 8
      setPlace(
        below < 120 && above > below
          ? {
              left: r.left,
              width: r.width,
              bottom: window.innerHeight - r.top + 2,
              maxHeight: Math.min(190, above)
            }
          : { left: r.left, width: r.width, top: r.bottom + 2, maxHeight: Math.min(190, below) }
      )
    }
    measure()
    // Capture: the scroll that moves the field is usually a panel's, not the window's.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [listOpen, value])

  // The unknown name under the caret is still being typed — not said until the caret leaves it.
  const typing = problem?.kind === 'unknown' && problem.name === word.word && caret === word.end && !tried
  const shown = problem && !typing ? problem : null

  // A focused field starts with its caret at the END of the stored formula, not at position 0 where
  // Chromium's autofocus puts it: typing continues the formula, and the "still being typed" rule
  // above only holds when the caret sits where the typing happens.
  useEffect(() => {
    if (!autoFocus || !ref.current) return
    const n = ref.current.value.length
    ref.current.setSelectionRange(n, n)
    setCaret(n)
  }, [autoFocus])

  // The caret after a pick lands after the inserted name — once React has rendered the new value.
  useEffect(() => {
    if (pendingCaret.current != null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current)
      setCaret(pendingCaret.current)
      pendingCaret.current = null
    }
  }, [value])

  const pick = (name: string): void => {
    const r = insertName(value, word.start, word.end, name)
    pendingCaret.current = r.caret
    setOpen(false)
    onChange(r.text)
  }
  const fix = (): void => {
    if (!shown?.name || !shown.suggestion) return
    const next = replaceName(value, shown.name, shown.suggestion)
    pendingCaret.current = next.length
    setTried(false)
    onChange(next)
  }
  const commit = (): void => {
    setOpen(false)
    if (problem) setTried(true)
    onCommit?.(problem)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void => {
    if (open && items.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => (s + 1) % items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (s - 1 + items.length) % items.length)
        return
      }
      const chosen = items[Math.min(sel, items.length - 1)].name
      // The name typed in full is listed too now. Picking it would change nothing, so Enter on it does
      // what Enter did before it was listed — commit — instead of costing a second Enter.
      const done = chosen === word.word && caret === word.end
      if (e.key === 'Tab' || (e.key === 'Enter' && !done)) {
        e.preventDefault()
        pick(chosen)
        return
      }
      if (e.key === 'Enter') setOpen(false)
      if (e.key === 'Escape') {
        // Closes the list only; the dialog behind the field (if any) stays.
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        return
      }
    }
    if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
      e.preventDefault()
      if (problem) {
        // Said, not sent — and the field keeps focus so it can be fixed.
        setTried(true)
        onCommit?.(problem)
        return
      }
      ;(e.target as HTMLElement).blur() // → onBlur → commit
      return
    }
    if (e.key === 'Escape') {
      abandoned.current = true
      onAbandon?.()
      ;(e.target as HTMLElement).blur()
    }
  }

  const field = {
    ref: ref as never,
    className: `${className ?? ''}${tried && problem ? ' refused' : ''}`.trim() || undefined,
    value,
    placeholder,
    autoFocus,
    spellCheck: false,
    'aria-invalid': tried && problem ? true : undefined,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': listOpen,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      onChange(e.target.value)
      setCaret(e.target.selectionStart ?? e.target.value.length)
      setOpen(true)
      setSel(0)
      setTried(false)
    },
    onSelect: (e: React.SyntheticEvent<HTMLTextAreaElement | HTMLInputElement>) =>
      setCaret(e.currentTarget.selectionStart ?? 0),
    onKeyDown: onKey,
    onBlur: () => {
      if (abandoned.current) {
        abandoned.current = false
        setOpen(false)
        return
      }
      if (commitOnBlur === false) {
        setOpen(false)
        return
      }
      commit()
    }
  }

  return (
    <div className={`fx-combo${multiline ? '' : ' one'}`}>
      {multiline ? <textarea {...field} /> : <input type="text" {...field} />}
      {listOpen && place
        ? createPortal(
            <div className="fx-combo-list" role="listbox" style={place}>
              {items.map((p, i) => (
                <button
                  key={p.name}
                  type="button"
                  role="option"
                  aria-selected={i === sel}
                  className={i === sel ? 'sel' : undefined}
                  // mousedown, not click: it fires before the field's blur, so the pick wins.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(p.name)
                  }}
                  onMouseEnter={() => setSel(i)}
                >
                  <span className="fx-combo-name">{p.name}</span>
                  {p.hint ? <span className="fx-combo-hint">{p.hint}</span> : null}
                </button>
              ))}
            </div>,
            document.body
          )
        : null}
      {shown ? (
        <div className={`fx-problem${tried ? ' hard' : ''}`} role={tried ? 'alert' : undefined}>
          {shown.message}
          {shown.suggestion ? (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={fix}>
              Use “{shown.suggestion}”
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
