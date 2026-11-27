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

/** What the filters of the first two columns hold: part of a flow name, and a compartment as its path of
 *  categories (`['air']`, `['air', 'urban air close to ground']`), or none. */
export interface LciFilter {
  flow: string
  compartment: string[] | null
}

/** A row lies in a compartment when its categories begin with that path: `['air']` holds every air
 *  emission, whatever its sub-compartment. */
const liesIn = (r: LciRow, path: string[]): boolean => path.every((c, i) => r.categories[i] === c)

/** The rows whose flow name holds the text, ignoring case, and that lie in the compartment. */
export function filterLciRows(rows: LciRow[], filter: LciFilter): LciRow[] {
  const q = filter.flow.trim().toLowerCase()
  const path = filter.compartment
  if (!q && !path) return rows
  return rows.filter((r) => (!q || r.flow.toLowerCase().includes(q)) && (!path || liesIn(r, path)))
}

/** A compartment path as one string, for a select's value; the separator is a control character no
 *  category name holds. */
export const compartmentKey = (path: string[]): string => path.join('\u001f')

const byPath = (a: string[], b: string[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = byText(a[i], b[i])
    if (c) return c
  }
  return a.length - b.length
}

/** The compartments the compartment filter offers: every one a row lies in, and every one above it, so
 *  "air" is there to choose although each air flow names a sub-compartment. In name order, each compartment
 *  right before its own sub-compartments. */
export function compartmentPaths(rows: LciRow[]): string[][] {
  const seen = new Map<string, string[]>()
  for (const r of rows)
    for (let depth = 1; depth <= r.categories.length; depth++) {
      const path = r.categories.slice(0, depth)
      seen.set(compartmentKey(path), path)
    }
  return [...seen.values()].sort(byPath)
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
