import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { usePersisted } from '../lib/persist'
import { methodFamilyInfo } from '../lib/methodInfo'
import { groupMethodsByFamily, indicatorLabel, indicatorLabels } from '../lib/methods'
import { invalidate, useQuery } from '../lib/server/useQuery'
import LciaMethods from './LciaMethods'
import LciaCompareTable from './LciaCompareTable'
import { MAX_COMPARED as MAX, type CfResponse } from './lciaCompare'
import { errMsg } from '../lib/errors'

interface MethodInfo {
  method: string[]
  name: string
  unit: string
  recommended?: boolean
}
interface Picked {
  key: string
  method: string[]
  label: string // impact category (method[1])
  detail: string // specific indicator (method[2])
  unit: string
}
/**
 * LCIA page: inspect and compare the characterisation factors of LCIA indicators. Pick a family
 * (with the same mini-info + method link as Results), then up to three concrete indicators; the table
 * (`LciaCompareTable`) lists every flow characterised by ANY chosen indicator, with each indicator's
 * factor in its own column (blank/greyed where a method doesn't cover that flow).
 */
export default function Lcia({
  methods,
  tab
}: {
  methods: MethodInfo[]
  tab: 'compare' | 'methods'
}): JSX.Element {
  const [family, setFamily] = usePersisted('prism.lcia.family', '')
  const [picked, setPicked] = usePersisted<Picked[]>('prism.lcia.picked', [])
  const [indQuery, setIndQuery] = useState('')
  const [data, setData] = useState<CfResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // Live method list off the shared cache, so custom methods created under "Manage methods" show
  // up here too (the editor invalidates the key on every write).
  const cachedMethods = useQuery('/api/v1/calc/methods').data
  const allMethods: MethodInfo[] = cachedMethods ?? methods
  const refreshMethods = useCallback(() => {
    invalidate('/api/v1/calc/methods')
  }, [])
  // Returning to the compare tab: pull a fresh method list so newly created customs appear.
  useEffect(() => {
    if (tab === 'compare') refreshMethods()
  }, [tab, refreshMethods])

  const families = useMemo(() => groupMethodsByFamily(allMethods), [allMethods])
  const familyNames = useMemo(() => [...families.keys()], [families])
  // What a row is called: `method[1]` where that names one indicator, the whole path below the
  // family where it does not (ReCiPe endpoint names its damage category second — V203).
  const labels = useMemo(() => indicatorLabels(allMethods), [allMethods])
  useEffect(() => {
    if (!family && familyNames.length) setFamily(familyNames[0])
  }, [familyNames, family, setFamily])

  // A selection stored while four could be compared keeps its first three.
  useEffect(() => {
    if (picked.length > MAX) setPicked((prev) => prev.slice(0, MAX))
  }, [picked.length, setPicked])
  const pickedKeys = useMemo(() => new Set(picked.map((p) => p.key)), [picked])
  const atMax = picked.length >= MAX

  const filteredInd = useMemo(() => {
    const list = families.get(family) ?? []
    const q = indQuery.trim().toLowerCase()
    return q
      ? list.filter(
          (m) =>
            m.name.toLowerCase().includes(q) || indicatorLabel(m.method, labels).toLowerCase().includes(q)
        )
      : list
  }, [families, family, indQuery, labels])

  const toggleIndicator = (m: MethodInfo): void => {
    const key = m.method.join(' · ')
    setPicked((prev) => {
      if (prev.some((p) => p.key === key)) return prev.filter((p) => p.key !== key)
      if (prev.length >= MAX) return prev // capped at MAX indicators
      return [
        ...prev,
        { key, method: m.method, label: m.method[1] ?? m.name, detail: m.method[2] ?? '', unit: m.unit }
      ]
    })
  }
  const removePicked = (key: string): void => setPicked((prev) => prev.filter((p) => p.key !== key))

  // Load characterisation factors whenever the indicator selection changes.
  useEffect(() => {
    if (!picked.length) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setErr(null)
    void api<CfResponse>('POST', '/api/v1/calc/characterization-factors', {
      methods: picked.map((p) => p.method)
    })
      .then((r) => {
        if (!cancelled) setData(r)
      })
      .catch((e) => {
        if (!cancelled) setErr(errMsg(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `cachedMethods` too: the editor invalidates the method list on every factor write, and the table
    // of factors has to follow it — it kept the values from before the edit.
  }, [picked, cachedMethods])

  if (tab === 'methods') {
    return (
      <div className="view lcia-view">
        <div className="lcia-main">
          <div className="view-head">
            <h2>LCIA</h2>
          </div>
          <LciaMethods onMethodsChanged={refreshMethods} />
        </div>
        <LciaSide tab={tab} />
      </div>
    )
  }

  return (
    <div className="view lcia-view">
      <div className="lcia-main">
        <div className="view-head">
          <h2>LCIA</h2>
        </div>
        {err ? (
          <div className="wb-error" onClick={() => setErr(null)}>
            {err}
          </div>
        ) : null}

        <div className="ind-picker">
          <div className="ind-picker-cols">
            <select
              className="ind-family"
              size={8}
              value={family}
              onChange={(e) => setFamily(e.target.value)}
            >
              {familyNames.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <div className="ind-detail">
              <input
                className="flowpick-search"
                placeholder="Filter indicators…"
                value={indQuery}
                onChange={(e) => setIndQuery(e.target.value)}
              />
              <div className="ind-detail-actions">
                <span>
                  {filteredInd.length} indicator{filteredInd.length === 1 ? '' : 's'}
                </span>
                <span className={atMax ? 'cs-warn' : undefined}>
                  {picked.length}/{MAX} selected
                </span>
              </div>
              <div className="ind-detail-list">
                {filteredInd.map((mi) => {
                  const key = mi.method.join(' · ')
                  const on = pickedKeys.has(key)
                  return (
                    <button
                      key={key}
                      className={`ind-row${on ? ' on' : ''}`}
                      onClick={() => toggleIndicator(mi)}
                      disabled={!on && atMax}
                      title={mi.method.slice(1).join(' · ')}
                    >
                      <span className="ind-check">{on ? '✓' : '+'}</span>
                      <span className="ind-name">
                        {mi.recommended ? (
                          <span className="ind-star" title="Standard reporting indicator (recommended)">
                            ★{' '}
                          </span>
                        ) : null}
                        {indicatorLabel(mi.method, labels) || mi.name}
                      </span>
                      <span className="ind-unit">{mi.unit}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="ind-info">
              {(() => {
                const info = methodFamilyInfo(family)
                if (!info)
                  return (
                    <p className="empty" style={{ padding: 0 }}>
                      No description available for this family.
                    </p>
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
          </div>
        </div>

        {picked.length ? (
          <div className="lcia-chips">
            {picked.map((p) => (
              <span key={p.key} className="lcia-chip" title={p.key}>
                {indicatorLabel(p.method, labels) || p.detail || p.label}{' '}
                <span className="lcia-chip-unit">[{p.unit}]</span>
                <button
                  className="lcia-chip-x"
                  onClick={() => removePicked(p.key)}
                  aria-label="Remove indicator"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {!picked.length ? (
          <p className="empty" style={{ marginTop: 14 }}>
            Pick up to {MAX} indicators above to list and compare their characterization factors.
          </p>
        ) : (
          <>
            {loading ? (
              <p className="empty" style={{ marginTop: 14 }}>
                Loading characterization factors…
              </p>
            ) : null}
            {/* Kept mounted while the next indicator's factors load: the table holds the flow filter and
                the sort, and adding a column should not throw them away. */}
            {data ? <LciaCompareTable data={data} onError={setErr} /> : null}
          </>
        )}
      </div>
      <LciaSide tab={tab} />
    </div>
  )
}

/**
 * Help panel shared by both LCIA tabs (the inspector-style side column Parameters and Scenarios
 * have). It says what the page is for, and just as clearly that a study on the shipped methods
 * never needs to touch it.
 */
function LciaSide({ tab }: { tab: 'compare' | 'methods' }): JSX.Element {
  return (
    <aside className="lcia-side">
      <div className="scen-help">
        <div className="rp-title">What is this page for?</div>
        <p>
          Every LCIA method is a table of <b>characterisation factors</b>: for each elementary flow, how much
          it counts towards an impact — kg CO₂-eq per kg methane, for instance. This page lets you look at
          those tables and, if you need to, make your own.
        </p>
        <p>
          <b>Compare factors</b> — pick up to {MAX} indicators from one family and see their factors side by
          side, flow by flow. Useful when two methods give different results for the same model and you want
          to know which flows are behind the gap. Export the table to Excel to keep it.
        </p>
        <p>
          <b>Manage methods</b> — the shipped methods are read-only. Duplicate an indicator into a family of
          your own, then change factors, add flows or drop them. Custom methods show up in Results and reports
          just like the shipped ones, and stay with this workspace.
        </p>
        <p>
          <b>Working with the standard methods only?</b> Then there is nothing to do here — EF, ReCiPe, IPCC
          and the rest are ready to use in Results as they are. This page is for looking behind them and for
          the rare case where a study needs its own factors.
        </p>
        <p className="hint-sm">
          {tab === 'compare'
            ? 'Blank cells mean an indicator does not characterise that flow at all — that is a difference in scope, not a factor of zero.'
            : 'A custom method is a copy: later updates to the shipped method do not flow into it. Note in the family description where its factors come from.'}
        </p>
      </div>
    </aside>
  )
}
