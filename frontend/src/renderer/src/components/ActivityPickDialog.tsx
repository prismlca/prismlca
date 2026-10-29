import { useState } from 'react'
import EscapeCloser from './EscapeCloser'

/**
 * Add one of THIS model's own processes to the comparison.
 *
 * The results view used to list every foreground process with a tick box, all of them selected — so a
 * packaging study opened by comparing its bottle, its label and its shrink film against each other.
 * Only the reference process is selected now, and its sub-processes are added on purpose, the same way
 * activities from ecoinvent already were. (Another model comes in whole, by its reference process.)
 */
export default function ActivityPickDialog({
  activities,
  onPick,
  onClose
}: {
  activities: { code: string; name: string }[]
  onPick: (code: string) => void
  onClose: () => void
}): JSX.Element {
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const shown = query.trim()
    ? activities.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase()))
    : activities
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={() => onClose()} />
      <div className="modal sheet search-modal subjpick-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>Add processes from this model</h3>
            <p>Add this model’s own processes as comparison subjects.</p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">
          {activities.length > 8 ? (
            <div className="srow">
              <input
                autoFocus
                placeholder="Find a process…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          ) : null}
          <div className="subjpick">
            {shown.map((a) => (
              <span key={a.code} className="subjrow bg-subj" title={a.name}>
                <span>{a.name}</span>
                <button
                  className="btn sm"
                  disabled={added.has(a.code)}
                  onClick={() => {
                    onPick(a.code)
                    setAdded((s) => new Set(s).add(a.code))
                  }}
                >
                  {added.has(a.code) ? 'Added' : '+ Add'}
                </button>
              </span>
            ))}
            {!shown.length ? <p className="empty">Nothing left to add.</p> : null}
          </div>
        </div>
        <div className="sheet-foot">
          <div className="acts">
            <button className="btn sm" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
