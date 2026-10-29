/** The rows of the factor comparison on the LCIA page: their shape, their order and which factors agree. */

export interface CfMethod {
  method: string[]
  name: string
  unit: string
}
export interface CfFlow {
  flow: string
  categories: string[]
  unit: string
  /** One per compared indicator, in the order of `methods`; null where it does not characterise the flow. */
  factors: (number | null)[]
}
export interface CfResponse {
  methods: CfMethod[]
  flows: CfFlow[]
}

/** How many indicators can be compared at once. Three, so each factor column stays wide enough to read. */
export const MAX_COMPARED = 3

/** A text column, or the factor column of the indicator at that position. */
export type CompareSortKey = 'flow' | 'categories' | 'unit' | `cf:${number}`

/** The rows ordered by one column, or as they came when there is no sort. Text compares by locale and
 *  ignores case; a factor by its value, sign included. A blank factor is no value at all — the indicator
 *  does not cover the flow — so it goes last in both directions instead of sorting as a zero. */
export function sortCompareFlows(
  rows: CfFlow[],
  sort: { key: CompareSortKey; dir: 1 | -1 } | null
): CfFlow[] {
  if (!sort) return rows
  if (sort.key.startsWith('cf:')) {
    const j = Number(sort.key.slice(3))
    return [...rows].sort((a, b) => {
      const x = a.factors[j]
      const y = b.factors[j]
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1
      return sort.dir * (x - y)
    })
  }
  const text = (r: CfFlow): string =>
    sort.key === 'flow' ? r.flow : sort.key === 'unit' ? r.unit : r.categories.join(' / ')
  return [...rows].sort(
    (a, b) => sort.dir * text(a).localeCompare(text(b), undefined, { sensitivity: 'base' })
  )
}

/** Equal, allowing for the last bits of floating point: two methods that state the same factor can carry it
 *  as 1 and 0.9999999999999999 after a unit conversion, and those are one number to the reader. */
const same = (a: number, b: number): boolean =>
  a === b || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b))

/** For each factor of a row, whether another factor in the same row has the same value — the cells the table
 *  marks as agreeing. Blanks agree with nothing. */
export function agreeingFactors(factors: (number | null)[]): boolean[] {
  return factors.map((v, i) => v != null && factors.some((w, j) => j !== i && w != null && same(v, w)))
}
