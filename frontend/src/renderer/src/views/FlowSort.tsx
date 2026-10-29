import { SortIcon } from '../components/icons'

/** How a flow list is ordered; null keeps the exchange order. The values are the labels shown. */
export type FlowSort = 'A–Z' | 'Z–A' | '9–1' | '1–9' | null

/** A list gets its sort (and, in the details window, its filter) from this many entries on: a list of two
 *  or three is read at a glance, and the controls would only crowd its heading. */
export const FLOW_TOOLS_MIN = 4

/** What the list tools read of a flow row — the shape the inspector and the details window share. */
export interface FlowLike {
  amount: number
  input: { name?: string | null; location?: string | null; categories?: string[] | null }
}

/** One label's click cycle: the first click sorts, the second reverses, the third returns to the exchange
 *  order — so the order the process was built in is never more than two clicks away. */
function next(current: FlowSort, first: 'A–Z' | '9–1', second: 'Z–A' | '1–9'): FlowSort {
  return current === first ? second : current === second ? null : first
}

/** What a click does, said in the label's tooltip. `measure` names what 9–1 counts (an exchange's amount,
 *  a result's impact); `origin` is the click that returns to the list's own order. */
function title(to: FlowSort, measure: string, origin: string): string {
  if (to === 'A–Z') return 'Sort by name, A to Z'
  if (to === 'Z–A') return 'Sort by name, Z to A'
  if (to === '9–1') return `Sort by ${measure}, largest first`
  if (to === '1–9') return `Sort by ${measure}, smallest first`
  return origin
}

/** The flows in the chosen order; amounts compare by size, so an output's negative sign does not sort it last. */
export function sortFlows<T extends FlowLike>(rows: T[], by: FlowSort): T[] {
  const name = (x: T, y: T): number => (x.input.name ?? '').localeCompare(y.input.name ?? '')
  const size = (x: T, y: T): number => Math.abs(y.amount) - Math.abs(x.amount)
  if (by === 'A–Z') return [...rows].sort(name)
  if (by === 'Z–A') return [...rows].sort((x, y) => name(y, x))
  if (by === '9–1') return [...rows].sort(size)
  if (by === '1–9') return [...rows].sort((x, y) => size(y, x))
  return rows
}

/** A list that arrives largest first (a result's elementary flows) in the chosen order: as it arrived for
 *  9–1, reversed for 1–9, by name for the other two — so the default never re-sorts what the backend ranked. */
export function sortRanked<T>(rows: T[], by: FlowSort, nameOf: (r: T) => string): T[] {
  if (by === 'A–Z') return [...rows].sort((x, y) => nameOf(x).localeCompare(nameOf(y)))
  if (by === 'Z–A') return [...rows].sort((x, y) => nameOf(y).localeCompare(nameOf(x)))
  if (by === '1–9') return [...rows].reverse()
  return rows
}

/** The sort control at the right of a flow list's heading: a sort glyph that only labels, then the two
 *  orders as text — each label names the order it shows and turns over on the next click. */
export default function FlowSortControl({
  value,
  onChange,
  measure = 'amount',
  origin = 'Back to the exchange order'
}: {
  value: FlowSort
  onChange: (v: FlowSort) => void
  measure?: string
  origin?: string
}): JSX.Element {
  const byName = value === 'A–Z' || value === 'Z–A'
  const byAmount = value === '9–1' || value === '1–9'
  const nameNext = next(value, 'A–Z', 'Z–A')
  const amountNext = next(value, '9–1', '1–9')
  return (
    <span className={`flow-order${value ? ' on' : ''}`}>
      <SortIcon />
      <span className="flow-order-keys">
        <button
          type="button"
          className={`flow-order-btn${byName ? ' on' : ''}`}
          title={title(nameNext, measure, origin)}
          onClick={() => onChange(nameNext)}
        >
          {byName ? value : 'A–Z'}
        </button>{' '}
        <button
          type="button"
          className={`flow-order-btn${byAmount ? ' on' : ''}`}
          title={title(amountNext, measure, origin)}
          onClick={() => onChange(amountNext)}
        >
          {byAmount ? value : '9–1'}
        </button>
      </span>
    </span>
  )
}
