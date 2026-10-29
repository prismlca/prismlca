import type { Dispatch, SetStateAction } from 'react'
import { methodFamilyInfo } from '../../lib/methodInfo'
import { familyToOpen, indicatorLabel } from '../../lib/methods'
import type { MethodInfo, Picked } from './types'

/**
 * The body of the Results rail's "Indicators" group: the picked chips, and the family → indicator
 * picker. Its state (open, filter, family) stays with the page and comes in as props: the accordion
 * unmounts a closed group, and state held here would reset whenever the group is collapsed.
 */
export function IndicatorPicker({
  picked,
  setPicked,
  groups,
  pickedKeys,
  families,
  familyNames,
  labels,
  family,
  setFamily,
  indQuery,
  setIndQuery,
  pickerOpen,
  setPickerOpen
}: {
  picked: Picked[]
  setPicked: (next: Picked[] | ((prev: Picked[]) => Picked[])) => void
  groups: { family: string; items: Picked[] }[]
  pickedKeys: Set<string>
  families: Map<string, MethodInfo[]>
  familyNames: string[]
  labels: Map<string, string>
  family: string
  setFamily: Dispatch<SetStateAction<string>>
  indQuery: string
  setIndQuery: Dispatch<SetStateAction<string>>
  pickerOpen: boolean
  setPickerOpen: Dispatch<SetStateAction<boolean>>
}): JSX.Element {
  const toPicked = (meth: MethodInfo): Picked => ({
    key: meth.method.join(' · '),
    method: meth.method,
    family: meth.method[0],
    label: indicatorLabel(meth.method, labels) || meth.method[0],
    detail: meth.method[2] ?? '',
    unit: meth.unit
  })
  const toggleIndicator = (meth: MethodInfo): void => {
    const key = meth.method.join(' · ')
    setPicked((ps) =>
      ps.some((p) => p.key === key) ? ps.filter((p) => p.key !== key) : [...ps, toPicked(meth)]
    )
  }

  const famList = families.get(family) ?? []
  const filteredInd = indQuery
    ? famList.filter((mi) => indicatorLabel(mi.method, labels).toLowerCase().includes(indQuery.toLowerCase()))
    : famList
  const shownKeys = filteredInd.map((mi) => mi.method.join(' · '))
  const allShownSelected = filteredInd.length > 0 && shownKeys.every((k) => pickedKeys.has(k))
  const anyShownSelected = shownKeys.some((k) => pickedKeys.has(k))
  const selectAllShown = (): void =>
    setPicked((ps) => {
      const have = new Set(ps.map((p) => p.key))
      return [...ps, ...filteredInd.filter((mi) => !have.has(mi.method.join(' · '))).map(toPicked)]
    })
  const deselectAllShown = (): void => {
    const rm = new Set(shownKeys)
    setPicked((ps) => ps.filter((p) => !rm.has(p.key)))
  }

  return (
    <>
      <div className="ind-chips">
        {picked.length ? (
          groups.map((g) => (
            <span className="ind-chip-group" key={g.family}>
              <span className="ind-fam-label" title={g.family}>
                {g.family}
              </span>
              {g.items.map((p) => (
                <span className="ind-chip" key={p.key} title={`${p.family} · ${p.detail || p.label}`}>
                  {p.label}
                  <button onClick={() => setPicked((ps) => ps.filter((x) => x.key !== p.key))}>×</button>
                </span>
              ))}
            </span>
          ))
        ) : (
          <span className="empty" style={{ padding: 0 }}>
            None selected.
          </span>
        )}
        <button
          className="add-flow-btn inline"
          onClick={() => {
            if (!pickerOpen)
              setFamily(
                familyToOpen(
                  family,
                  groups.map((g) => g.family),
                  familyNames
                )
              )
            setPickerOpen((v) => !v)
          }}
        >
          {pickerOpen ? 'Done' : '+ Add indicator'}
        </button>
      </div>
      {pickerOpen ? (
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
                <button
                  className="linklike"
                  onClick={selectAllShown}
                  disabled={allShownSelected || !filteredInd.length}
                >
                  Select all
                </button>
                <button className="linklike" onClick={deselectAllShown} disabled={!anyShownSelected}>
                  Deselect all
                </button>
                <span>
                  {filteredInd.length} indicator{filteredInd.length === 1 ? '' : 's'}
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
      ) : null}
    </>
  )
}
