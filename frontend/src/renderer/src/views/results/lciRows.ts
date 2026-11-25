import type { Matrix } from './types'

/** The rows of the life cycle inventory table on the Results page: their shape, their order, and the
 *  payload the Excel export takes. */

export interface LciRow {
  /** The flow's id, as the run named it. */
  id: string
  flow: string
  categories: string[]
  unit: string
  /** One per subject of the matrix, in its order. A flow a subject does not exchange is a 0 there — that is
   *  its amount, not a missing value. */
  amounts: number[]
}

/** A text column, or the amount column of the subject at that position. */
export type LciSortKey = 'flow' | 'compartment' | 'unit' | `s:${number}`

const compartment = (r: LciRow): string => r.categories.join(' / ')
const byText = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' })

/** One row per flow any subject exchanges, by name and then compartment — the order an inventory is looked
 *  up in. Empty when the run computed no inventory. */
export function lciRows(matrix: Matrix): LciRow[] {
  const flows = matrix.flows
  if (!flows) return []
  const ids = new Set<string>()
  for (const s of matrix.subjects) for (const id of Object.keys(s.inventory ?? {})) ids.add(id)
  const rows = [...ids].map((id) => {
    const f = flows[id]
    return {
      id,
      flow: f?.name ?? id,
      categories: f?.categories ?? [],
      unit: f?.unit ?? '',
      amounts: matrix.subjects.map((s) => s.inventory?.[id] ?? 0)
    }
  })
  return rows.sort((a, b) => byText(a.flow, b.flow) || byText(compartment(a), compartment(b)))
}

/** The rows whose flow name or compartment holds `query`, ignoring case. */
export function filterLciRows(rows: LciRow[], query: string): LciRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter((r) => r.flow.toLowerCase().includes(q) || compartment(r).toLowerCase().includes(q))
}

/** The rows ordered by one column, or as they came when there is no sort. Text compares by locale and ignores
 *  case; an amount by its value, sign included. */
export function sortLciRows(rows: LciRow[], sort: { key: LciSortKey; dir: 1 | -1 } | null): LciRow[] {
  if (!sort) return rows
  if (sort.key.startsWith('s:')) {
    const j = Number(sort.key.slice(2))
    return [...rows].sort((a, b) => sort.dir * ((a.amounts[j] ?? 0) - (b.amounts[j] ?? 0)))
  }
  const text = (r: LciRow): string =>
    sort.key === 'flow' ? r.flow : sort.key === 'unit' ? r.unit : compartment(r)
  return [...rows].sort((a, b) => sort.dir * byText(text(a), text(b)))
}

/** The inventory as `/export/lci` and the LCI sheet of `/export/compare-matrix` take it. */
export function lciExport(
  matrix: Matrix,
  rows: LciRow[]
): { subjects: string[]; flows: { flow: string; categories: string[]; unit: string; amounts: number[] }[] } {
  return {
    subjects: matrix.subjects.map((s) => s.label),
    flows: rows.map((r) => ({ flow: r.flow, categories: r.categories, unit: r.unit, amounts: r.amounts }))
  }
}
