import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { useSettings, fmtSig } from '../lib/settings'
import { methodFamilyInfo } from '../lib/methodInfo'
import { groupMethodsByFamily } from '../lib/methods'
import { asReferenceRow } from '../lib/referenceProduct'
import { CommentIcon, LockIcon } from '../components/icons'
import { useFlowListTools } from './useFlowListTools'
import FlowProperties from './FlowProperties'
import FieldLink from './FieldLink'
import SourceChip from '../components/SourceChip'
import { errMsg } from '../lib/errors'
import EscapeCloser from '../components/EscapeCloser'

const enc = encodeURIComponent

/**
 * Read-only process-details window for a (background) activity, opened from the search results.
 * Three tabs: (1) comments + metadata, (2) flows split into process links vs. environment
 * (emissions/withdrawals) with a shortcut to the reference product's flow properties, and
 * (3) tabular LCIA results for chosen method families/indicators.
 */
interface MethodInfo {
  method: string[]
  name: string
  unit: string
  recommended?: boolean // standard reporting indicator (vs specialist variant)
}
interface FlowInput {
  database: string
  code: string
  name: string | null
  unit: string | null
  location: string | null
  categories?: string[]
}
interface Exchange {
  uid: string
  type: string
  direction: 'input' | 'output'
  amount: number
  formula: string | null
  comment?: string | null
  input: FlowInput
}
interface Detail {
  activity: {
    database: string
    code: string
    name: string | null
    product: string | null
    location: string | null
    unit: string | null
    read_only: boolean
    isic?: string | null
    cpc?: string | null
    cpc_name?: string | null
    /** Flows the import could not link, parked with the dataset — see the import wizard. */
    unmatched_from_import?: number
  }
  exchanges: Exchange[]
}
interface Metadata {
  activity: Detail['activity']
  comment: string | null
  classifications: { system: string; value: string }[]
  fields: Record<string, unknown>
  exchange_comments: { flow: string | null; type: string; comment: string }[]
}

const HIDE_FIELDS = new Set([
  'name',
  'reference product',
  'unit',
  'location',
  'comment',
  'type',
  'code',
  'database'
])

export default function ProcessDetails({
  database,
  code,
  methods,
  kind,
  onClose
}: {
  database: string
  code: string
  methods: MethodInfo[]
  /** `background` | `library` | `foreground` — names the source at the head of the product line. */
  kind?: string
  onClose: () => void
}): JSX.Element {
  const { round } = useSettings()
  const [tab, setTab] = useState<'meta' | 'flows' | 'results'>('meta')
  const [meta, setMeta] = useState<Metadata | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showProps, setShowProps] = useState(false)
  const [openComments, setOpenComments] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setError(null)
    void api<Metadata>('GET', `/api/v1/model/activities/${enc(database)}/${enc(code)}/metadata`)
      .then(setMeta)
      .catch((e) => setError(errMsg(e)))
    void api<Detail>('GET', `/api/v1/model/activities/${enc(database)}/${enc(code)}`)
      .then(setDetail)
      .catch((e) => setError(errMsg(e)))
  }, [database, code])

  const a = meta?.activity ?? detail?.activity ?? null
  const dirOf = (e: Exchange): 'input' | 'output' => e.direction ?? (e.amount < 0 ? 'output' : 'input')
  const ex = detail?.exchanges ?? []
  const production = ex
    .filter((e) => e.type === 'production')
    .map((e) => (detail ? asReferenceRow(e, detail.activity) : e))
  const techIn = ex.filter((e) => e.type === 'technosphere' && dirOf(e) === 'input')
  const techOut = ex.filter((e) => e.type === 'technosphere' && dirOf(e) === 'output')
  const envIn = ex.filter((e) => e.type === 'biosphere' && dirOf(e) === 'input')
  const envOut = ex.filter((e) => e.type === 'biosphere' && dirOf(e) === 'output')

  // --- results tab ---------------------------------------------------------
  const familyMap = useMemo(() => groupMethodsByFamily(methods), [methods])
  const families = useMemo(() => [...familyMap.keys()], [familyMap])
  const [family, setFamily] = useState('')
  useEffect(() => {
    if (!family && families.length) setFamily(families[0])
  }, [families, family])
  const familyMethods = familyMap.get(family) ?? []
  const [indQuery, setIndQuery] = useState('')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [scores, setScores] = useState<{ method: string[]; unit: string; score: number }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const filtered = indQuery
    ? familyMethods.filter((m) => (m.method[1] ?? '').toLowerCase().includes(indQuery.toLowerCase()))
    : familyMethods
  const shownKeys = filtered.map((m) => m.method.join(' · '))
  const allShownSelected = shownKeys.length > 0 && shownKeys.every((k) => picked[k])
  const anyShownSelected = shownKeys.some((k) => picked[k])
  const toggle = (key: string): void => setPicked((p) => ({ ...p, [key]: !p[key] }))
  const selectAllShown = (): void =>
    setPicked((p) => ({ ...p, ...Object.fromEntries(shownKeys.map((k) => [k, true])) }))
  const deselectAllShown = (): void =>
    setPicked((p) => {
      const next = { ...p }
      shownKeys.forEach((k) => delete next[k])
      return next
    })
  const selectedCount = Object.values(picked).filter(Boolean).length
  const compute = (): void => {
    const chosen = methods.filter((m) => picked[m.method.join(' · ')]).map((m) => m.method)
    if (!chosen.length) return
    setBusy(true)
    setScores(null)
    void api<{ results: { method: string[]; unit: string; score: number }[] }>('POST', '/api/v1/calc/lcia', {
      database,
      code,
      methods: chosen
    })
      .then((r) => setScores(r.results))
      .catch((e) => setError(errMsg(e)))
      .finally(() => setBusy(false))
  }

  // Filter and sort per section, in the section's heading once its list is long enough to need them.
  const flowTools = useFlowListTools()

  // Plain function (not a nested component) so it's part of this render — a nested <Component>
  // would get a new identity each render and remount, which broke the comment toggle.
  const flowList = (rows: Exchange[], empty: string): JSX.Element =>
    rows.length ? (
      <div className="pdet-flows">
        {rows.map((f) => {
          const key = f.uid || `${f.input.code}-${f.amount}`
          const open = !!openComments[key]
          return (
            <div className="pdet-flow-wrap" key={key}>
              <div className="pdet-flow">
                <span className="pdet-flow-left">
                  <span className="pdet-flow-nm" title={f.input.name ?? ''}>
                    {f.input.name ?? f.input.code}
                  </span>
                  {f.input.location ? <span className="pdet-flow-geo">{f.input.location}</span> : null}
                  {f.input.categories?.length ? (
                    <span className="pdet-flow-cat">{f.input.categories.join(' / ')}</span>
                  ) : null}
                  {f.comment ? (
                    <button
                      className={`pdet-flow-cmt${open ? ' on' : ''}`}
                      title={open ? 'Hide comment' : 'Show comment'}
                      onClick={() => setOpenComments((s) => ({ ...s, [key]: !s[key] }))}
                    >
                      <CommentIcon />
                    </button>
                  ) : null}
                </span>
                <span className="pdet-flow-amt">{fmtSig(f.amount, round.io)}</span>
                <span className="pdet-flow-unit">{f.input.unit ?? ''}</span>
              </div>
              {open && f.comment ? <div className="pdet-flow-comment">{f.comment}</div> : null}
            </div>
          )
        })}
      </div>
    ) : (
      <p className="empty">{empty}</p>
    )

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={() => onClose()} />
      <div className="modal sheet pdet-modal" onClick={(e) => e.stopPropagation()}>
        {/* The standard sheet head: the kind of dataset as eyebrow, the name as title, source, product,
            region and unit as the subtitle line — and the ✕ every other window has. */}
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <div className="eyebrow">
              {/* Say what kind of dataset this is: a My-processes dataset is the user's own and writable,
                  and stood here under a padlock as "Background". */}
              {kind === 'library' ? (
                'My processes'
              ) : kind === 'foreground' ? (
                'Model process'
              ) : (
                <>
                  <LockIcon /> Background
                </>
              )}
            </div>
            <h3 className="pdet-title">{a?.name ?? 'Process'}</h3>
            {/* The source leads the product line — before product, region and unit. */}
            <div className="pdet-sub">
              <SourceChip database={database} kind={kind ?? 'background'} />
              {a?.product ? <span>{a.product}</span> : null}
              {a?.location ? <span className="chip">{a.location}</span> : null}
              {a?.unit ? <span className="th-unit">{a.unit}</span> : null}
            </div>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="pdet-tabs" role="tablist">
          <button className={`pdet-tab${tab === 'meta' ? ' on' : ''}`} onClick={() => setTab('meta')}>
            Metadata
          </button>
          <button className={`pdet-tab${tab === 'flows' ? ' on' : ''}`} onClick={() => setTab('flows')}>
            Inputs / Outputs
          </button>
          <button className={`pdet-tab${tab === 'results' ? ' on' : ''}`} onClick={() => setTab('results')}>
            Results
          </button>
        </div>

        <div className="sheet-body pdet-body">
          {error ? <div className="editor-err">{error}</div> : null}

          {tab === 'meta' ? (
            <>
              {meta?.comment ? (
                <div className="pdet-section">
                  <div className="pdet-section-h">Comment</div>
                  <div className="pdet-comment">
                    {meta.comment
                      .split(/\n+/)
                      .map((p) => p.trim())
                      .filter(Boolean)
                      .map((para, i) => (
                        <p className="pdet-para" key={i}>
                          {para}
                        </p>
                      ))}
                  </div>
                </div>
              ) : null}
              {meta?.classifications.length ? (
                <div className="pdet-section">
                  <div className="pdet-section-h">Classification</div>
                  <table className="pdet-table pdet-kv">
                    <tbody>
                      {meta.classifications.map((c, i) => (
                        <tr key={i}>
                          <td>{c.system}</td>
                          <td>{c.value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {meta && Object.keys(meta.fields).filter((k) => !HIDE_FIELDS.has(k)).length ? (
                <div className="pdet-section">
                  <div className="pdet-section-h">Fields</div>
                  <table className="pdet-table pdet-kv">
                    <tbody>
                      {Object.entries(meta.fields)
                        .filter(([k, v]) => !HIDE_FIELDS.has(k) && v !== null && v !== '')
                        .map(([k, v]) => (
                          <tr key={k}>
                            <td>{k}</td>
                            <td>{String(v)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {!meta ? <p className="empty">Loading…</p> : null}
            </>
          ) : null}

          {tab === 'flows' ? (
            <>
              {detail?.activity.unmatched_from_import ? (
                <p className="settings-hint warn">
                  {detail.activity.unmatched_from_import} flow
                  {detail.activity.unmatched_from_import === 1 ? '' : 's'} from the import{' '}
                  {detail.activity.unmatched_from_import === 1 ? 'is' : 'are'} not linked and not listed
                  below.
                </p>
              ) : null}
              <div className="pdet-section">
                <div className="pdet-section-h">
                  Reference product
                  <FieldLink
                    label="Properties"
                    title="View flow properties"
                    onClick={() => setShowProps(true)}
                  />
                </div>
                {flowList(production, 'No production exchange.')}
              </div>
              <div className="pdet-section">
                <div className="pdet-section-h">Inputs from processes{flowTools.bar(techIn, 'in')}</div>
                {flowList(flowTools.rows(techIn, 'in'), flowTools.empty(techIn, 'in', 'No process inputs.'))}
              </div>
              {techOut.length ? (
                <div className="pdet-section">
                  <div className="pdet-section-h">
                    Outputs to processes (co-products / waste){flowTools.bar(techOut, 'out')}
                  </div>
                  {flowList(flowTools.rows(techOut, 'out'), flowTools.empty(techOut, 'out', ''))}
                </div>
              ) : null}
              <div className="pdet-section">
                <div className="pdet-section-h">
                  Emissions to the environment{flowTools.bar(envOut, 'em')}
                </div>
                {flowList(flowTools.rows(envOut, 'em'), flowTools.empty(envOut, 'em', 'No emissions.'))}
              </div>
              <div className="pdet-section">
                <div className="pdet-section-h">
                  Resources from the environment{flowTools.bar(envIn, 'res')}
                </div>
                {flowList(
                  flowTools.rows(envIn, 'res'),
                  flowTools.empty(envIn, 'res', 'No resource withdrawals.')
                )}
              </div>
              {!detail ? <p className="empty">Loading…</p> : null}
            </>
          ) : null}

          {tab === 'results' ? (
            <div className="pdet-res-tab">
              <div className="pdet-res">
                <div className="pdet-res-top">
                  <label className="pdet-field">
                    <span>Method family</span>
                    <select value={family} onChange={(e) => setFamily(e.target.value)}>
                      {families.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </label>
                  <input
                    className="pdet-filter"
                    placeholder="Filter indicators…"
                    value={indQuery}
                    onChange={(e) => setIndQuery(e.target.value)}
                  />
                </div>
                <div className="pdet-res-cols">
                  <div className="pdet-res-info">
                    {(() => {
                      const info = methodFamilyInfo(family)
                      if (!info)
                        return (
                          <p className="empty pdet-empty-flush">No description available for this family.</p>
                        )
                      return (
                        <>
                          <div className="ind-info-name">{info.name}</div>
                          <p className="ind-info-text">{info.text}</p>
                          <ul className="ind-info-facts">
                            {info.facts.map((f) => (
                              <li key={f}>{f}</li>
                            ))}
                          </ul>
                          {info.url ? (
                            <a
                              className="ind-info-link"
                              href={info.url}
                              onClick={(e) => {
                                e.preventDefault()
                                void window.prism.openExternal(info.url as string)
                              }}
                            >
                              Method reference ↗
                            </a>
                          ) : null}
                        </>
                      )
                    })()}
                  </div>
                  <div className="pdet-res-right">
                    <div className="pdet-res-actions">
                      <button
                        className="linklike"
                        onClick={selectAllShown}
                        disabled={allShownSelected || !filtered.length}
                      >
                        Select all
                      </button>
                      <button className="linklike" onClick={deselectAllShown} disabled={!anyShownSelected}>
                        Deselect all
                      </button>
                      <span className="th-unit">
                        {filtered.length} indicator{filtered.length === 1 ? '' : 's'} · {selectedCount}{' '}
                        selected
                      </span>
                    </div>
                    <div className="pdet-res-list">
                      {filtered.length ? (
                        filtered.map((m) => {
                          const key = m.method.join(' · ')
                          const on = !!picked[key]
                          return (
                            <button
                              key={key}
                              className={`ind-row${on ? ' on' : ''}`}
                              onClick={() => toggle(key)}
                              title={m.method.slice(1).join(' · ')}
                            >
                              <span className="ind-check">{on ? '✓' : '+'}</span>
                              <span className="ind-name">
                                {m.recommended ? (
                                  <span
                                    className="ind-star"
                                    title="Standard reporting indicator (recommended)"
                                  >
                                    ★{' '}
                                  </span>
                                ) : null}
                                {m.method[1] ?? m.name}
                              </span>
                              <span className="ind-unit">{m.unit}</span>
                            </button>
                          )
                        })
                      ) : (
                        <p className="empty">No indicators.</p>
                      )}
                    </div>
                  </div>
                </div>
                <div className="pdet-picker-foot">
                  <button className="btn sm primary" onClick={compute} disabled={busy || !selectedCount}>
                    {busy ? 'Calculating…' : `Calculate${selectedCount ? ` (${selectedCount})` : ''}`}
                  </button>
                </div>
              </div>
              {scores?.length ? (
                <div className="pdet-res-scores">
                  <table className="pdet-table pdet-scores-table">
                    <thead>
                      <tr>
                        <th>Indicator</th>
                        <th className="td-score">Score</th>
                        <th>Unit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scores.map((s) => {
                        const label = s.method.slice(1).join(' · ') || s.method[0]
                        return (
                          <tr key={s.method.join(' · ')}>
                            <td className="pdet-score-name" title={label}>
                              {label}
                            </td>
                            <td className="td-score">{fmtSig(s.score, round.results)}</td>
                            <td className="pdet-score-unit" title={s.unit}>
                              {s.unit}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="hint-sm">Pick one or more indicators and Calculate.</p>
              )}
            </div>
          ) : null}
        </div>

        {showProps ? (
          <FlowProperties
            database={database}
            code={code}
            onClose={() => setShowProps(false)}
            onChanged={() => {}}
          />
        ) : null}
      </div>
    </div>
  )
}
