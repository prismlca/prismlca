import { useState } from 'react'
import UnitCombo from './UnitCombo'
import EscapeCloser from './EscapeCloser'
import DialogBox from './DialogBox'
import { useDialogSubmit } from './useDialogSubmit'

export interface Field {
  key: string
  label: string
  type?: string
  value: string
  options?: { value: string; label: string }[] // when set, render a <select>
  suggestions?: string[] // free mode: input autocompletes from these (editable dropdown)
  restrict?: boolean // strict mode: renders a plain dropdown of `suggestions` only
  describe?: (s: string) => string | undefined // free mode: a name beside each suggestion ("DE · Germany")
  unit?: string | null // shown after the input, e.g. the unit an amount is counted in
  placeholder?: string // plain text inputs: an example of what belongs in the field
  required?: boolean // the submit button stays disabled while this field is blank
}

/** A read-only line above the fields: what the dialog acts on, so the numbers below have a referent. */
export interface Fact {
  label: string
  value: string
}

/**
 * Small generic form modal: a titled list of text/number/select fields with Cancel/Submit.
 *
 * The modal never closes itself on submit. When `onSubmit` returns a promise, the dialog waits for it:
 * a rejection is shown under the fields and everything typed stays, so a taken name costs one edit
 * instead of the whole form; the caller closes the dialog once its write went through.
 */
export default function Modal(props: {
  title: string
  fields: Field[]
  submitLabel: string
  facts?: Fact[]
  /** One short line under the fields — what this dialog deliberately does not ask for, and where that lives. */
  note?: string
  /** A refusal to show from the start, for a dialog that is reopened with the reason it came back for. */
  error?: string
  onSubmit: (values: Record<string, string>) => void | Promise<unknown>
  onClose: () => void
}): JSX.Element {
  const [vals, setVals] = useState<Record<string, string>>(
    Object.fromEntries(props.fields.map((f) => [f.key, f.value]))
  )
  const [errors, setErrors] = useState<Record<string, string>>({})
  const sent = useDialogSubmit()
  const [initialError, setInitialError] = useState(props.error ?? null)
  const refusal = sent.error ?? initialError
  const missing = props.fields.some((f) => f.required && !(vals[f.key] ?? '').trim())
  // While the write is out, the dialog neither submits again nor closes: a refusal must find it open.
  const close = (): void => {
    if (!sent.busy) props.onClose()
  }
  // Nor does it take edits then: the write carries the values as they were, and a success closes the
  // dialog — a change typed in between would be dropped without a word. The fields keep the focus, so a
  // refused name is corrected right where the cursor is.
  const edit = (key: string, value: string): void => {
    if (!sent.busy) setVals((v) => ({ ...v, [key]: value }))
  }

  const submit = (): void => {
    if (missing || sent.busy) return
    // Strict fields render as a constrained <select>, so no free text can slip through —
    // validation only guards the (theoretical) case of a prefilled value outside the list.
    const errs: Record<string, string> = {}
    for (const f of props.fields) {
      const v = (vals[f.key] ?? '').trim()
      if (f.restrict && f.suggestions?.length && v && !f.suggestions.includes(v)) {
        errs[f.key] =
          'Unknown unit — pick a known one from the list (free entry can be allowed under Settings → Modelling).'
      }
    }
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    setInitialError(null)
    sent.settle(props.onSubmit(vals))
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <EscapeCloser onClose={close} />
      <DialogBox
        className="modal"
        label={props.title}
        aria-busy={sent.busy || undefined}
        onKeyDown={(e) => {
          // A name typed and Enter pressed used to do nothing — the hand had to go to the mouse (V333).
          // Only from a text input: a textarea keeps Enter for a new line, a select for opening.
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
            e.preventDefault()
            submit()
          }
        }}
      >
        <h3>{props.title}</h3>
        {props.facts?.length ? (
          <dl className="modal-facts">
            {props.facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {props.fields.map((f, i) => (
          <label key={f.key} className="mfield">
            <span>{f.label}</span>
            {f.options ? (
              <select value={vals[f.key]} onChange={(e) => edit(f.key, e.target.value)}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === 'textarea' ? (
              <textarea
                rows={3}
                value={vals[f.key]}
                autoFocus={i === 0}
                onChange={(e) => edit(f.key, e.target.value)}
              />
            ) : f.restrict && f.suggestions?.length ? (
              // Strict mode: a plain dropdown of the known values (nothing else enterable).
              <select value={vals[f.key]} onChange={(e) => edit(f.key, e.target.value)}>
                {!f.suggestions.includes(vals[f.key]) ? (
                  <option value={vals[f.key]}>{vals[f.key]}</option>
                ) : null}
                {f.suggestions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            ) : f.suggestions ? (
              // Hybrid mode: editable combo whose suggestions open from the first character. Rendered
              // while the list is still empty too, so its arrival does not swap the input under the cursor.
              <UnitCombo
                value={vals[f.key]}
                units={f.suggestions}
                describe={f.describe}
                autoFocus={i === 0}
                onChange={(v) => edit(f.key, v)}
              />
            ) : f.unit ? (
              <div className="mfield-with-unit">
                <input
                  type={f.type ?? 'text'}
                  value={vals[f.key]}
                  autoFocus={i === 0}
                  onChange={(e) => edit(f.key, e.target.value)}
                />
                <span className="mfield-unit">{f.unit}</span>
              </div>
            ) : (
              <input
                type={f.type ?? 'text'}
                value={vals[f.key]}
                placeholder={f.placeholder}
                aria-required={f.required || undefined}
                autoFocus={i === 0}
                onChange={(e) => edit(f.key, e.target.value)}
              />
            )}
            {errors[f.key] ? <span className="mfield-err">{errors[f.key]}</span> : null}
          </label>
        ))}
        {props.note ? <p className="modal-note">{props.note}</p> : null}
        {refusal ? (
          <p className="modal-err" role="alert">
            {refusal}
          </p>
        ) : null}
        <div className="modal-actions">
          <button className="btn" onClick={close} disabled={sent.busy}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={missing || sent.busy}>
            {props.submitLabel}
          </button>
        </div>
      </DialogBox>
    </div>
  )
}
