import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { FilterIcon } from '../../components/icons'
import { compartmentKey, compartmentPaths, type LciFilter, type LciRow } from './lciRows'

/**
 * The filters of the LCI table's first two columns. Neither is in the way until asked for: a funnel beside
 * "Flow" opens a search field under the header, one beside "Compartment" a list of the compartments. Closing a
 * filter clears it, so no filter acts on the rows without its field in sight.
 */

interface ColumnFilter {
  open: boolean
  /** The filter holds a value: its funnel is marked, so a header shows what narrows the rows. */
  active: boolean
  toggle: () => void
  close: () => void
  button: RefObject<HTMLButtonElement>
}

export interface LciFilters {
  filter: LciFilter
  flow: ColumnFilter & { query: string; setQuery: (q: string) => void }
  compartment: ColumnFilter & { key: string; setKey: (k: string) => void; paths: string[][] }
}

export function useLciFilters(rows: LciRow[]): LciFilters {
  const [flowOpen, setFlowOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [compOpen, setCompOpen] = useState(false)
  const [key, setKey] = useState('')
  const flowButton = useRef<HTMLButtonElement>(null)
  const compButton = useRef<HTMLButtonElement>(null)
  const paths = useMemo(() => compartmentPaths(rows), [rows])
  // A compartment the next run no longer has filters nothing, rather than every row away unseen.
  const chosen = useMemo(() => paths.find((p) => compartmentKey(p) === key) ?? null, [paths, key])
  const filter = useMemo(() => ({ flow: query, compartment: chosen }), [query, chosen])
  const closeFlow = (): void => {
    setFlowOpen(false)
    setQuery('')
  }
  const closeComp = (): void => {
    setCompOpen(false)
    setKey('')
  }
  return {
    filter,
    flow: {
      open: flowOpen,
      active: !!filter.flow.trim(),
      toggle: () => (flowOpen ? closeFlow() : setFlowOpen(true)),
      close: closeFlow,
      button: flowButton,
      query,
      setQuery
    },
    compartment: {
      open: compOpen,
      active: !!chosen,
      toggle: () => (compOpen ? closeComp() : setCompOpen(true)),
      close: closeComp,
      button: compButton,
      key: chosen ? key : '',
      setKey,
      paths
    }
  }
}

/** The funnel beside a column's header. Its name stays the same whether the filter is open or not;
 *  `aria-pressed` says which. */
export function FilterToggle({ label, f }: { label: string; f: ColumnFilter }): JSX.Element {
  return (
    <button
      ref={f.button}
      type="button"
      className={`lci-filter-btn${f.open ? ' open' : ''}${f.active ? ' active' : ''}`}
      aria-label={label}
      aria-pressed={f.open}
      title={f.open ? 'Close this filter and show all rows again' : label}
      onClick={f.toggle}
    >
      <FilterIcon />
    </button>
  )
}

/** Escape in a filter's field closes the filter and hands the focus back to its funnel. */
const escapeCloses =
  (f: ColumnFilter) =>
  (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    // The field's own meaning of Escape: a dialog around the page keeps its own.
    e.stopPropagation()
    f.close()
    f.button.current?.focus()
  }

/** The compartment list, opened as soon as it appears: the funnel's click is the click that opens it. Each
 *  compartment comes right before its sub-compartments (`compartmentPaths`). */
function CompartmentSelect({ f }: { f: LciFilters['compartment'] }): JSX.Element {
  const ref = useRef<HTMLSelectElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    try {
      el.showPicker?.()
    } catch {
      // Without the click's activation (or without the method) the list stays shut and one more click opens it.
    }
  }, [])
  return (
    <select
      ref={ref}
      className="lci-filter-field"
      aria-label="Compartment filter"
      value={f.key}
      onChange={(e) => f.setKey(e.target.value)}
      onKeyDown={escapeCloses(f)}
    >
      <option value="">All compartments</option>
      {f.paths.map((p) => (
        // The whole path, as the column writes it: two sub-compartments may share a name under different
        // compartments ("fossil well" under natural resource and under water), and the closed list shows only this.
        <option key={compartmentKey(p)} value={compartmentKey(p)}>
          {p.join(' / ')}
        </option>
      ))}
    </select>
  )
}

/** The header's second row, under the column titles, while a filter is open: its field under its column. */
export function LciFilterRow({
  filters,
  columns
}: {
  filters: LciFilters
  columns: number
}): JSX.Element | null {
  const { flow, compartment } = filters
  if (!flow.open && !compartment.open) return null
  return (
    <tr className="lci-filter-row">
      <td>
        {flow.open ? (
          <input
            className="lci-filter-field"
            aria-label="Flow filter"
            placeholder="Filter flows…"
            autoFocus
            value={flow.query}
            onChange={(e) => flow.setQuery(e.target.value)}
            onKeyDown={escapeCloses(flow)}
          />
        ) : null}
      </td>
      <td>{compartment.open ? <CompartmentSelect f={compartment} /> : null}</td>
      <td colSpan={columns - 2} />
    </tr>
  )
}
