import { useState } from 'react'
import { api } from '../lib/api'
import { errMsg } from '../lib/errors'
import { contrastRatio, hexInput } from '../lib/reportColors'
import type { Palette } from './PalettePicker'

const FIELDS = [
  { key: 'accent', label: 'Accent', note: 'Rules, marks, the cover’s colour' },
  { key: 'deep', label: 'Deep', note: 'Headings, table heads, dark bands' },
  { key: 'paper', label: 'Paper', note: 'The page' }
] as const
type Key = (typeof FIELDS)[number]['key']

/**
 * A colour set of your own: a name and three colours, added for every report on this computer.
 *
 * The same three a set's chip shows — accent, deep tone, paper — because they are what a reader sees as the
 * document's colour; the greys and the mark come from the PrismLCA set, as they do under a report's own
 * colours. Each colour has the system's colour well *and* a hex field: the well is how most people choose a
 * colour, the field is how a style guide hands one over, and both edit the same value.
 *
 * Starts from the set the report is in, so "the same, but with our red" is one change rather than three.
 * Inline under the chips rather than in a window: the gallery below repaints when the set is picked, and that
 * is the preview that counts.
 */
export default function NewPaletteForm({
  start,
  onAdded,
  onCancel
}: {
  /** Accent, deep tone and paper to begin from. */
  start: [string, string, string]
  onAdded: (palette: Palette) => void
  onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [text, setText] = useState<Record<Key, string>>({ accent: start[0], deep: start[1], paper: start[2] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const value = {
    accent: hexInput(text.accent),
    deep: hexInput(text.deep),
    paper: hexInput(text.paper)
  }
  const complete = Boolean(value.accent && value.deep && value.paper)
  const ready = complete && name.trim().length > 0 && !busy

  // Two checks worth a sentence, not a refusal: a deep tone that cannot be read on the paper, and an accent
  // the paper swallows. Both are legitimate choices for someone who knows what they want.
  const warnings: string[] = []
  if (value.deep && value.paper && contrastRatio(value.deep, value.paper) < 4.5)
    warnings.push('Deep is hard to read on this paper — headings and table heads are set in it.')
  if (value.accent && value.paper && contrastRatio(value.accent, value.paper) < 1.5)
    warnings.push('The accent barely stands out from the paper.')

  const add = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ palette: Palette }>('POST', '/api/v1/report/palettes', {
        label: name.trim(),
        ...value
      })
      onAdded(r.palette)
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <div
      className="pal-new"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation() // closes this form, not whatever holds it
          onCancel()
        }
      }}
    >
      <label className="pal-new-name">
        <span>Name</span>
        <input
          autoFocus
          value={name}
          maxLength={40}
          placeholder="e.g. House colours"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
      </label>
      {FIELDS.map((f) => {
        const ok = value[f.key]
        return (
          <div className="pal-new-row" key={f.key}>
            <input
              type="color"
              className="pal-new-well"
              aria-label={`${f.label} colour`}
              value={ok ?? '#000000'}
              onChange={(e) => setText({ ...text, [f.key]: e.target.value })}
            />
            <label className="pal-new-f">
              <span>
                {f.label} <em>{f.note}</em>
              </span>
              <input
                className={ok ? undefined : 'bad'}
                value={text[f.key]}
                spellCheck={false}
                aria-invalid={!ok}
                placeholder="#rrggbb"
                onChange={(e) => setText({ ...text, [f.key]: e.target.value })}
                onBlur={() => ok && setText({ ...text, [f.key]: ok })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void add()
                }}
              />
            </label>
          </div>
        )
      })}
      {complete ? (
        <div className="pal-new-preview" aria-hidden="true">
          <span className="pal-sw">
            <i style={{ background: value.accent ?? undefined }} />
            <i style={{ background: value.deep ?? undefined }} />
            <i style={{ background: value.paper ?? undefined }} />
          </span>
          <span className="pal-name">{name.trim() || 'New set'}</span>
        </div>
      ) : null}
      {warnings.map((w) => (
        <p className="settings-hint pal-new-warn" key={w}>
          {w}
        </p>
      ))}
      {error ? <p className="cover-error">{error}</p> : null}
      <div className="pal-new-actions">
        <button className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void add()} disabled={!ready}>
          Add set
        </button>
      </div>
      <p className="settings-hint">
        Kept on this computer and offered to every report. The greys and the mark colour come from the
        PrismLCA set.
      </p>
    </div>
  )
}
