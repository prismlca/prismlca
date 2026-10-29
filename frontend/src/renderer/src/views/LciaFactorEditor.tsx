import { useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { parseAmount } from '../lib/numberFormat'
import { useSortState } from '../lib/useSortState'
import { TrashIcon } from '../components/icons'
import FlowSearchControl from './FlowSearch'
import { FLOW_TOOLS_MIN } from './FlowSort'
import {
  filterFactorFlows,
  refKey,
  sortFactorFlows,
  type FactorSortKey,
  type MethodDetail,
  type Ref
} from './lciaFactors'

interface FlowHit {
  ref: Ref
  flow: string
  categories: string[]
  unit: string
}

/**
 * The factor table of one custom method: add a biosphere flow, edit a factor in place, remove a flow.
 * Like the flow lists of the process details window, a list of FLOW_TOOLS_MIN or more flows gets a
 * magnifier that filters it; every column sorts by a click on its header.
 */
export default function LciaFactorEditor({
  editing,
  onClose,
  onSetFactor,
  onRemoveFlow
}: {
  editing: MethodDetail
  onClose: () => void
  onSetFactor: (ref: Ref, cf: number) => void
  onRemoveFlow: (ref: Ref) => void
}): JSX.Element {
  const [flowQuery, setFlowQuery] = useState('')
  const [flowHits, setFlowHits] = useState<FlowHit[]>([])
  const [filter, setFilter] = useState<string | null>(null)
  const { sort, sortClick, sortMark } = useSortState<FactorSortKey>()

  // add-flow search (debounced-ish: fires on each change, cheap server-side scan)
  const searchTimer = useRef<ReturnType<typeof setTimeout>>()
  const onFlowQuery = (q: string): void => {
    setFlowQuery(q)
    clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      void api<{ flows: FlowHit[] }>(
        'GET',
        `/api/v1/lcia/flow-search?query=${encodeURIComponent(q)}&limit=30`
      )
        .then((r) => setFlowHits(r.flows))
        .catch(() => setFlowHits([]))
    }, 200)
  }
  const editingRefs = useMemo(() => new Set(editing.flows.map((f) => refKey(f.ref))), [editing])

  // Below the threshold the magnifier is gone, and so is its filter — no list stays quietly shortened.
  const filtering = editing.flows.length >= FLOW_TOOLS_MIN
  const rows = useMemo(
    () => sortFactorFlows(filtering ? filterFactorFlows(editing.flows, filter ?? '') : editing.flows, sort),
    [editing.flows, filtering, filter, sort]
  )
  const hidden = editing.flows.length - rows.length

  return (
    <>
      <div className="lcia-ed-head">
        <div>
          <div className="lcia-ed-name">{editing.name}</div>
          <div className="lcia-ed-unit">
            {hidden ? `${rows.length} of ` : ''}
            {editing.flows.length} flows · {editing.unit}
          </div>
        </div>
        <button className="btn sm" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="lcia-addflow">
        <div className="lcia-addflow-row">
          <input
            className="flowpick-search"
            placeholder="Add a flow — search biosphere…"
            value={flowQuery}
            onChange={(e) => onFlowQuery(e.target.value)}
          />
          {filtering ? <FlowSearchControl query={filter} onChange={setFilter} /> : null}
        </div>
        {flowHits.length && flowQuery ? (
          <div className="lcia-addflow-hits">
            {flowHits.map((h) => {
              const already = editingRefs.has(refKey(h.ref))
              return (
                <button
                  key={refKey(h.ref)}
                  className="lcia-hit"
                  disabled={already}
                  onClick={() => {
                    onSetFactor(h.ref, 0)
                    setFlowQuery('')
                    setFlowHits([])
                  }}
                >
                  <span className="lcia-hit-name">{h.flow}</span>
                  <span className="lcia-hit-cat">{h.categories.join(' / ')}</span>
                  <span className="lcia-hit-add">{already ? '✓' : '+'}</span>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="lcia-ed-scroll">
        <table className="lcia-table">
          <thead>
            <tr>
              <th className="th-sortable" title="Sort by flow" onClick={() => sortClick('flow')}>
                Flow{sortMark('flow')}
              </th>
              <th className="th-sortable" title="Sort by categories" onClick={() => sortClick('categories')}>
                Categories{sortMark('categories')}
              </th>
              <th className="lcia-cf-th th-sortable" title="Sort by factor" onClick={() => sortClick('cf')}>
                Factor [{editing.unit}]{sortMark('cf')}
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => (
              <tr key={refKey(f.ref)}>
                <td>{f.flow}</td>
                <td className="lcia-cats">{f.categories.join(' / ')}</td>
                <td className="lcia-cf">
                  <input
                    className="lcia-cf-input"
                    type="text"
                    inputMode="decimal"
                    defaultValue={f.cf}
                    key={`${refKey(f.ref)}:${f.cf}`}
                    onBlur={(e) => {
                      // A characterisation factor is typed by hand and is usually a small
                      // decimal, which is exactly the value a locale-dependent number field
                      // got wrong. Unreadable text puts the stored factor back rather than
                      // writing the 0 that `Number('')` used to produce.
                      const v = parseAmount(e.target.value)
                      if (v === null) e.target.value = String(f.cf)
                      else if (v !== f.cf) onSetFactor(f.ref, v)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                  />
                </td>
                <td className="lcia-cf">
                  <button
                    className="act-icon danger"
                    title="Remove flow"
                    aria-label="Remove flow"
                    onClick={() => onRemoveFlow(f.ref)}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
            {!rows.length ? (
              <tr>
                <td colSpan={4} className="lcia-fam-empty">
                  {editing.flows.length ? 'No flow matches the filter.' : 'No flows — add one above.'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  )
}
