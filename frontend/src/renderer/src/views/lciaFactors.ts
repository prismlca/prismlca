/** The rows of a custom LCIA method's factor table: their shape, their key, and how the editor filters
 *  and sorts them. */

/** A node id as a string (64-bit — a number would round it) or a [db, code] pair. */
export type Ref = number | string | string[]

export interface Flow {
  ref: Ref
  flow: string
  categories: string[]
  unit: string
  cf: number
}

export interface MethodDetail {
  method: string[]
  name: string
  unit: string
  editable: boolean
  flows: Flow[]
}

export type FactorSortKey = 'flow' | 'categories' | 'cf'

export const refKey = (r: Ref): string => (Array.isArray(r) ? r.join('/') : String(r))

/** The flows whose name or category contains the query, ignoring case; an empty query keeps all. */
export function filterFactorFlows(rows: Flow[], query: string): Flow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => [r.flow, ...r.categories].some((s) => s.toLowerCase().includes(q)))
}

/** The rows ordered by one column, or as stored when there is no sort. Names and categories compare
 *  by locale and ignore case, factors by value; ties keep their stored order. */
export function sortFactorFlows(rows: Flow[], sort: { key: FactorSortKey; dir: 1 | -1 } | null): Flow[] {
  if (!sort) return rows
  const text = (r: Flow): string => (sort.key === 'flow' ? r.flow : r.categories.join(' / '))
  const cmp =
    sort.key === 'cf'
      ? (a: Flow, b: Flow): number => a.cf - b.cf
      : (a: Flow, b: Flow): number => text(a).localeCompare(text(b), undefined, { sensitivity: 'base' })
  return [...rows].sort((a, b) => sort.dir * cmp(a, b))
}
