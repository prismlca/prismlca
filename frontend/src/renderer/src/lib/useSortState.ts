import { useState } from 'react'

/** Click-to-sort column state: first click ascending, second descending, third back to the
 *  natural order. Two tables (Results scores, Settings model info) had written the identical
 *  toggle; the generic key keeps each table's own key vocabulary. */
export function useSortState<K extends string>(): {
  sort: { key: K; dir: 1 | -1 } | null
  sortClick: (key: K) => void
  sortMark: (key: K) => string
} {
  const [sort, setSort] = useState<{ key: K; dir: 1 | -1 } | null>(null)
  const sortClick = (key: K): void =>
    setSort((s) => (!s || s.key !== key ? { key, dir: 1 } : s.dir === 1 ? { key, dir: -1 } : null))
  const sortMark = (key: K): string => (sort?.key === key ? (sort.dir === 1 ? ' \u25b2' : ' \u25bc') : '')
  return { sort, sortClick, sortMark }
}
