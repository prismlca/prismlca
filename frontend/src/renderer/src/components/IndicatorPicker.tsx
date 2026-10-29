import { useEffect, useMemo, useState } from 'react'
import { familyToOpen, groupMethodsByFamily, indicatorLabel, indicatorLabels } from '../lib/methods'

export interface PickerMethod {
  method: string[]
  name: string
  unit: string
  recommended?: boolean
}

export const methodKey = (method: string[]): string => method.join(' / ')

/**
 * Choose impact indicators: the picked ones as removable chips grouped by family, and behind
 * "+ Add indicator" the family as a one-line dropdown with its indicators beneath, a filter, and
 * Select all / Deselect all over whatever the filter shows.
 *
 * The same control in two places — a short report picks what it computes, a full report stores what it
 * covers — so it lives here rather than being written twice. It works like the picker on Results,
 * because that is where people learn it: the selection in view, the catalogue only on request, so a
 * rail that is mostly settings does not open on a long list. The family sits in a dropdown instead of
 * a list box because these cards are columns, not pages.
 *
 * Selection is the caller's: this component owns only whether the catalogue is open, the family and the
 * filter, which nobody wants remembered.
 */
export default function IndicatorPicker({
  methods,
  picked,
  onChange,
  label = 'Impact indicators'
}: {
  methods: PickerMethod[]
  /** Keys as produced by `methodKey`. */
  picked: string[]
  onChange: (next: string[]) => void
  label?: string
}): JSX.Element {
  const byFamily = useMemo(() => groupMethodsByFamily(methods), [methods])
  // Over `methods` — the whole catalogue — never over `shown` or `picked`: what an indicator is called
  // must not depend on the filter or on the tick beside it (V203).
  const labels = useMemo(() => indicatorLabels(methods), [methods])
  const familyNames = useMemo(() => [...byFamily.keys()], [byFamily])
  const [open, setOpen] = useState(false)
  const [family, setFamily] = useState(familyNames[0] ?? '')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (familyNames.length && !familyNames.includes(family)) setFamily(familyNames[0])
  }, [familyNames, family])

  const shown = useMemo(() => {
    const list = byFamily.get(family) ?? []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((m) => (m.method.join(' ') + ' ' + m.name).toLowerCase().includes(q))
  }, [byFamily, family, query])

  const shownKeys = useMemo(() => shown.map((m) => methodKey(m.method)), [shown])
  const allShownPicked = shownKeys.length > 0 && shownKeys.every((k) => picked.includes(k))
  const anyShownPicked = shownKeys.some((k) => picked.includes(k))

  /**
   * What is selected, across all families — the list behind "+ Add indicator" can only ever show one
   * family, so a report carrying four CML indicators while the dropdown said "EF v3.1" showed a picker
   * with nothing ticked and "4 selected" above it. Seven chapters were then written against indicators
   * the user could not see and had not chosen. The chips stay in view whether the list is open or not,
   * grouped under their family as on Results, and each can be removed where it is.
   */
  const byKey = useMemo(() => new Map(methods.map((m) => [methodKey(m.method), m])), [methods])
  const groups = useMemo(() => {
    const out: {
      family: string
      chips: { key: string; family: string; indicator: string; known: boolean }[]
    }[] = []
    for (const key of picked) {
      const m = byKey.get(key)
      const [head, ...rest] = key.split(' / ')
      const chip = {
        key,
        family: m?.method[0] ?? head,
        // An indicator this workspace does not know keeps its stored path, minus the family its group names.
        indicator: m ? indicatorLabel(m.method, labels) || m.name : rest.join(' / ') || key,
        known: Boolean(m)
      }
      const group = out.find((g) => g.family === chip.family)
      if (group) group.chips.push(chip)
      else out.push({ family: chip.family, chips: [chip] })
    }
    return out
  }, [picked, byKey, labels])

  return (
    <div className="report-methods">
      <div className="report-methods-head">
        {label} <span className="faint">{picked.length ? `· ${picked.length} selected` : ''}</span>
      </div>
      <div className="ind-chips">
        {groups.length ? (
          groups.map((g) => (
            <span className="ind-chip-group" key={g.family}>
              <span className="ind-fam-label" title={g.family}>
                {g.family}
              </span>
              {g.chips.map((c) => (
                <span
                  key={c.key}
                  className={`ind-chip${c.known ? '' : ' unknown'}`}
                  title={
                    c.known
                      ? `${c.family} · ${c.indicator}`
                      : `${c.key} — not in this workspace's method list`
                  }
                >
                  {c.indicator}
                  <button
                    className="ind-chip-x"
                    aria-label={`Remove ${c.indicator}`}
                    title="Remove this indicator"
                    onClick={() => onChange(picked.filter((k) => k !== c.key))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </span>
          ))
        ) : (
          <span className="empty" style={{ padding: 0 }}>
            None selected.
          </span>
        )}
        {picked.length > 1 ? (
          <button className="linklike" onClick={() => onChange([])}>
            Clear all
          </button>
        ) : null}
        <button
          className="add-flow-btn inline"
          aria-expanded={open}
          onClick={() => {
            if (!open)
              setFamily(
                familyToOpen(
                  family,
                  groups.map((g) => g.family),
                  familyNames
                )
              )
            setOpen((v) => !v)
          }}
        >
          {open ? 'Done' : '+ Add indicator'}
        </button>
      </div>
      {open ? (
        <div className="ind-picker">
          <div className="ind-detail">
            <select value={family} aria-label="Method family" onChange={(e) => setFamily(e.target.value)}>
              {familyNames.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <input
              placeholder="Filter indicators…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="report-methods-actions">
              <button
                className="linklike"
                disabled={allShownPicked || !shownKeys.length}
                onClick={() => onChange([...new Set([...picked, ...shownKeys])])}
              >
                Select all
              </button>
              <button
                className="linklike"
                disabled={!anyShownPicked}
                onClick={() => onChange(picked.filter((k) => !shownKeys.includes(k)))}
              >
                Deselect all
              </button>
              <span className="faint">
                {shown.length} indicator{shown.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="report-methods-list">
              {shown.map((m) => {
                const key = methodKey(m.method)
                return (
                  <label key={key} className="report-method">
                    <input
                      type="checkbox"
                      checked={picked.includes(key)}
                      onChange={() =>
                        onChange(picked.includes(key) ? picked.filter((k) => k !== key) : [...picked, key])
                      }
                    />
                    <span>
                      {m.recommended ? (
                        <span className="ind-star" title="Standard reporting indicator (recommended)">
                          ★{' '}
                        </span>
                      ) : null}
                      {indicatorLabel(m.method, labels) || m.name}
                    </span>
                    <span className="faint">{m.unit}</span>
                  </label>
                )
              })}
              {!shown.length ? <p className="settings-hint">No indicator matches the filter.</p> : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
