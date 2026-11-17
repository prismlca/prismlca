import { useState } from 'react'

/**
 * "Take over the tag groups of another model" — the last row of the Tags window.
 *
 * A model's tag groups are its own, so a new model starts without any. Two models are broken down side by
 * side when their groups share a name and their tags a spelling; this copies another model's groups (names,
 * colours, tags in their order) instead of having them retyped. Nothing the model already has is changed,
 * and the two models stay independent afterwards.
 */
export default function TagAdoptRow({
  models,
  onAdopt
}: {
  /** The other models of the workspace. */
  models: string[]
  onAdopt: (source: string) => void
}): JSX.Element | null {
  const [source, setSource] = useState('')
  if (!models.length) return null
  return (
    <div className="tagman-adopt">
      <span>Take over the tag groups of</span>
      <select
        className="search-sel"
        value={source}
        aria-label="Model to take the tag groups from"
        onChange={(e) => setSource(e.target.value)}
      >
        <option value="">a model…</option>
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <button
        className="btn sm"
        disabled={!source}
        title="Adds that model's groups and tags to this model's. Nothing here is changed or removed. Undoable."
        onClick={() => {
          onAdopt(source)
          setSource('')
        }}
      >
        Take over
      </button>
    </div>
  )
}
