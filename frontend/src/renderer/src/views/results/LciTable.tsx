import { useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { copyNumber } from '../../lib/copyNumber'
import { deliverBase64, XLSX_MIME } from '../../lib/download'
import { errMsg } from '../../lib/errors'
import { usePersisted } from '../../lib/persist'
import { fmtSig, useSettings } from '../../lib/settings'
import { useSortState } from '../../lib/useSortState'
import { ChevronIcon, ExcelIcon } from '../../components/icons'
import { filterLciRows, lciExport, lciRows, sortLciRows, type LciSortKey } from './lciRows'
import type { Matrix } from './types'

/** Rows drawn until "Show all" is pressed. A system on ecoinvent exchanges a few thousand flows, and drawing
 *  all of them made opening the table and every sort click take seconds; the filter and the sort still work on
 *  every row, so the first rows are always the ones asked for, and the export writes them all. */
export const LCI_ROWS_SHOWN = 200

/**
 * The life cycle inventory of the compared subjects, folded away at the foot of the Results page: one row per
 * elementary flow, one amount column per subject — the baseline and each scenario side by side.
 *
 * The amounts come from the same run as the scores above (see `useCompareRun`). Every header sorts with the
 * click cycle of the score table (ascending, descending, back to name order); a double-click copies an amount
 * unrounded, as in the score table; the export writes the rows as they are shown, filtered and sorted — all of
 * them, also those past the first `LCI_ROWS_SHOWN` drawn.
 */
export function LciTable({
  matrix,
  onError
}: {
  matrix: Matrix
  onError: (message: string) => void
}): JSX.Element | null {
  // Folded by default: a few thousand rows are the reference beneath the results, not the first thing to read.
  const [open, setOpen] = usePersisted('prism.res.lciOpen', false)
  const [query, setQuery] = useState('')
  const { sort, sortClick, sortMark } = useSortState<LciSortKey>()
  const { round } = useSettings()
  const rows = useMemo(() => lciRows(matrix), [matrix])
  const shown = useMemo(() => sortLciRows(filterLciRows(rows, query), sort), [rows, query, sort])
  // "Show all" holds for the run it was pressed on; the next run starts short again.
  const [allFor, setAllFor] = useState<Matrix | null>(null)
  const drawn = allFor === matrix ? shown : shown.slice(0, LCI_ROWS_SHOWN)

  if (!matrix.flows) return null

  const exportXlsx = (): void => {
    void (async () => {
      try {
        const r = await api<{ filename: string; base64: string }>('POST', '/api/v1/export/lci', {
          ...lciExport(matrix, shown),
          filename: 'prism-lci'
        })
        deliverBase64(r.base64, r.filename, XLSX_MIME)
      } catch (e) {
        onError(errMsg(e))
      }
    })()
  }

  const ariaSort = (key: LciSortKey): 'ascending' | 'descending' | undefined =>
    sort?.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined
  // A real button in the header, so the sort is reachable by Tab and Enter as well as by the mouse.
  const head = (key: LciSortKey, label: string, title: string, className?: string): JSX.Element => (
    <th key={key} aria-sort={ariaSort(key)} className={className}>
      <button type="button" className="th-sort-btn" title={title} onClick={() => sortClick(key)}>
        {label}
        {sortMark(key)}
      </button>
    </th>
  )

  return (
    <section className={`res-lci${open ? ' open' : ''}`}>
      <button className="res-lci-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="car" aria-hidden="true">
          <ChevronIcon />
        </span>
        <span className="t">Life cycle inventory (LCI)</span>
        <span className="s">
          {rows.length} elementary flow{rows.length === 1 ? '' : 's'}
        </span>
      </button>
      {open ? (
        <div className="res-lci-body">
          <div className="res-lci-tools">
            <input
              className="flowpick-search"
              placeholder="Filter flows…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="res-lci-count">
              {shown.length} of {rows.length}
            </span>
            <button
              className="btn sm res-lci-export"
              onClick={exportXlsx}
              disabled={!shown.length}
              title="Export the inventory to Excel, filtered and sorted as shown"
            >
              <ExcelIcon /> Export LCI
            </button>
          </div>
          {rows.length ? (
            <div className="res-lci-scroll">
              <table className="lci-table" aria-label="Life cycle inventory">
                <thead>
                  <tr>
                    {head('flow', 'Flow', 'Sort by flow')}
                    {head('compartment', 'Compartment', 'Sort by compartment')}
                    {head('unit', 'Unit', 'Sort by unit')}
                    {matrix.subjects.map((s, j) =>
                      head(`s:${j}`, s.label, `${s.label} — click to sort by this amount`, 'lci-amt-th')
                    )}
                  </tr>
                </thead>
                <tbody>
                  {drawn.map((r) => (
                    <tr key={r.id}>
                      <td className="lci-flow" title={r.flow}>
                        {r.flow}
                      </td>
                      <td className="lci-cats">{r.categories.join(' / ')}</td>
                      <td>{r.unit}</td>
                      {r.amounts.map((v, j) => (
                        <td
                          key={j}
                          className="lci-amt"
                          // The full amount, unrounded, to the clipboard (lib/copyNumber).
                          onDoubleClick={(e) => void copyNumber(v, e)}
                        >
                          {fmtSig(v, round.results)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {drawn.length < shown.length ? (
                <button className="btn sm res-lci-more" onClick={() => setAllFor(matrix)}>
                  Show all {shown.length}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="hint">No subject exchanges an elementary flow.</p>
          )}
          <p className="res-lci-note">
            Elementary flows per functional unit of each subject, over the whole supply chain. Double-click an
            amount to copy it.
          </p>
        </div>
      ) : null}
    </section>
  )
}
