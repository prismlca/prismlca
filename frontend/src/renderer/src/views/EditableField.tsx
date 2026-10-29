import { useEffect, useState } from 'react'
import UnitCombo from '../components/UnitCombo'

/**
 * One field of a process in the inspector: read-only text, or an input that saves on blur (Enter
 * commits). With a vocabulary it becomes a unit field — a strict dropdown, or a combo that suggests from
 * the first character. Without a label it sits inside a composite line (the reference product's).
 */
export default function EditableField({
  label,
  value,
  readOnly,
  onSave,
  suggestions,
  restrict,
  multiline,
  hint,
  action,
  placeholder,
  ariaLabel
}: {
  label?: string
  value: string | null
  readOnly: boolean
  onSave: (v: string) => void
  suggestions?: string[] // autocomplete vocabulary (e.g. known units)
  restrict?: boolean // strict mode: values outside `suggestions` are rejected
  multiline?: boolean // several sentences rather than a line — the process description
  hint?: string // shown under the field while it is editable
  action?: JSX.Element // a FieldLink on the label line, right-aligned
  placeholder?: string // single-line text field: what belongs in it
  ariaLabel?: string // the field's name when it has no visible label
}): JSX.Element {
  const [v, setV] = useState(value ?? '')
  const [err, setErr] = useState(false)
  useEffect(() => {
    setV(value ?? '')
    setErr(false)
  }, [value])
  const commit = (): void => {
    if (v === (value ?? '')) return
    if (restrict && suggestions?.length && v.trim() && !suggestions.includes(v.trim())) {
      setErr(true) // unknown unit in strict mode: keep editing, don't save
      return
    }
    setErr(false)
    onSave(v)
  }
  return (
    <div className={`efield${action ? ' has-action' : ''}`}>
      {label !== undefined ? <label>{label}</label> : null}
      {action}
      {readOnly ? (
        <div className="val">{value ?? '—'}</div>
      ) : restrict && suggestions?.length ? (
        // Strict mode: constrained dropdown, saved on change.
        <select
          value={v}
          aria-label={ariaLabel}
          onChange={(e) => {
            setV(e.target.value)
            if (e.target.value !== (value ?? '')) onSave(e.target.value)
          }}
        >
          {v && !suggestions.includes(v) ? <option value={v}>{v}</option> : null}
          {suggestions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      ) : suggestions?.length ? (
        // Hybrid mode: editable combo, suggestions from the first character; saves on blur.
        <>
          <UnitCombo value={v} units={suggestions} ariaLabel={ariaLabel} onChange={setV} onCommit={commit} />
          {err ? (
            <span className="mfield-err">
              Unknown unit — pick a known one (free entry: Settings → Modelling).
            </span>
          ) : null}
        </>
      ) : multiline ? (
        // Enter has to make a paragraph here, so — unlike the single-line fields — it does not commit.
        // Four rows rather than three: a process comment is where the reason for a number goes, and
        // three lines made every one of them look like an afterthought.
        <textarea rows={4} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} />
      ) : (
        <input
          value={v}
          placeholder={placeholder}
          aria-label={ariaLabel}
          onChange={(e) => setV(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      )}
      {hint && !readOnly ? <span className="efield-hint">{hint}</span> : null}
    </div>
  )
}
