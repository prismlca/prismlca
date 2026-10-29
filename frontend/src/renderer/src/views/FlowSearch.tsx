import { useEffect, useRef } from 'react'
import { SearchIcon } from '../components/icons'
import type { FlowLike } from './FlowSort'

/** The flows whose name, location or category contains the query, ignoring case; an empty query keeps all. */
export function filterFlows<T extends FlowLike>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) =>
    [r.input.name, r.input.location, ...(r.input.categories ?? [])].some((s) => s?.toLowerCase().includes(q))
  )
}

/** A magnifier that slides a small filter field out to its left. `query` null means closed, and closing
 *  clears the filter, so no list is left quietly shortened behind a folded field. Escape closes the field
 *  and leaves the window open. */
export default function FlowSearchControl({
  query,
  onChange
}: {
  query: string | null
  onChange: (q: string | null) => void
}): JSX.Element {
  const open = query !== null
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  return (
    <span className={`flow-search${open ? ' open' : ''}`}>
      <input
        ref={input}
        className="flow-search-input"
        value={query ?? ''}
        placeholder="Filter"
        aria-label="Filter this list"
        tabIndex={open ? 0 : -1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          onChange(null)
        }}
      />
      <button
        type="button"
        className={`flow-search-btn${open ? ' on' : ''}`}
        title={open ? 'Close the filter' : 'Filter this list'}
        aria-expanded={open}
        onClick={() => onChange(open ? null : '')}
      >
        <SearchIcon />
      </button>
    </span>
  )
}
