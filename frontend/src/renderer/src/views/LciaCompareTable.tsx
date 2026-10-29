import { useMemo, useState } from 'react'
import { api } from '../lib/api'
import { fmtSig } from '../lib/settings'
import { useSortState } from '../lib/useSortState'
import { ExcelIcon } from '../components/icons'
import { deliverBase64, XLSX_MIME } from '../lib/download'
import { errMsg } from '../lib/errors'
import { agreeingFactors, sortCompareFlows, type CfResponse, type CompareSortKey } from './lciaCompare'

/**
 * The factor comparison: every flow any chosen indicator characterises, one factor column per indicator.
 *
 * Factors that agree within a row are tinted green, because agreement is what the reader is looking for —
 * where two methods state the same factor and where they part. Every column header sorts, the same click
 * cycle as the Results table (ascending, descending, back to the order the flows came in); the export
 * writes the rows as they are shown, filtered and sorted.
 */
export default function LciaCompareTable({
  data,
  onError
}: {
  data: CfResponse
  onError: (message: string) => void
}): JSX.Element {
  const [rowQuery, setRowQuery] = useState('')
  const { sort, sortClick, sortMark } = useSortState<CompareSortKey>()

  const shownFlows = useMemo(() => {
    const q = rowQuery.trim().toLowerCase()
    const rows = q
      ? data.flows.filter(
          (f) => f.flow.toLowerCase().includes(q) || f.categories.join(' / ').toLowerCase().includes(q)
        )
      : data.flows
    return sortCompareFlows(rows, sort)
  }, [data, rowQuery, sort])

  const exportXlsx = (): void => {
    void (async () => {
      try {
        const r = await api<{ filename: string; base64: string }>('POST', '/api/v1/export/lcia-factors', {
          methods: data.methods,
          flows: shownFlows
        })
        deliverBase64(r.base64, r.filename, XLSX_MIME)
      } catch (e) {
        onError(errMsg(e))
      }
    })()
  }

  const ariaSort = (key: CompareSortKey): 'ascending' | 'descending' | undefined =>
    sort?.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined
  // A real button in the header, so the sort is reachable by Tab and Enter as well as by the mouse.
  const sorter = (key: CompareSortKey, label: string, title: string): JSX.Element => (
    <button type="button" className="th-sort-btn" title={title} onClick={() => sortClick(key)}>
      {label}
      {sortMark(key)}
    </button>
  )
  const head = (key: CompareSortKey, label: string, title: string): JSX.Element => (
    <th aria-sort={ariaSort(key)}>{sorter(key, label, title)}</th>
  )

  return (
    <div className="lcia-table-wrap">
      <div className="lcia-table-head">
        <input
          className="flowpick-search"
          placeholder="Filter flows…"
          value={rowQuery}
          onChange={(e) => setRowQuery(e.target.value)}
        />
        <span className="lcia-count">
          {shownFlows.length} of {data.flows.length} flow{data.flows.length === 1 ? '' : 's'}
        </span>
        <button
          className="btn ico-label lcia-export"
          onClick={exportXlsx}
          disabled={!shownFlows.length}
          title="Export the factor table to Excel, filtered and sorted as shown"
        >
          <ExcelIcon /> Export
        </button>
      </div>
      <div className="lcia-table-scroll">
        <table className="lcia-table">
          <thead>
            <tr>
              {head('flow', 'Flow', 'Sort by flow')}
              {head('categories', 'Categories', 'Sort by categories')}
              {head('unit', 'Unit', 'Sort by unit')}
              {data.methods.map((m, j) => (
                <th key={m.method.join(' · ')} className="lcia-cf-th" aria-sort={ariaSort(`cf:${j}`)}>
                  {sorter(
                    `cf:${j}`,
                    m.method[2] || m.method[1] || m.name,
                    `${m.name} — click to sort by this factor`
                  )}
                  <div className="lcia-th-unit">[{m.unit}]</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownFlows.map((f, i) => {
              const agree = agreeingFactors(f.factors)
              return (
                <tr key={`${f.flow}-${f.categories.join('/')}-${i}`}>
                  <td>{f.flow}</td>
                  <td className="lcia-cats">{f.categories.join(' / ')}</td>
                  <td>{f.unit}</td>
                  {f.factors.map((cf, j) => (
                    <td
                      key={j}
                      className={`lcia-cf${cf == null ? ' lcia-na' : ''}${agree[j] ? ' lcia-same' : ''}`}
                      title={agree[j] ? 'The same factor as another indicator in this row' : undefined}
                    >
                      {cf == null ? '–' : fmtSig(cf, 4)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
