import { useState } from 'react'
import { type DatabaseInfo } from '../lib/api'
import {
  bgChipClass,
  clipName,
  defaultSearchDbs,
  groupKey,
  NAME_CLIP,
  searchTargets,
  shortDbLabel,
  useActivitySearch,
  type SearchHit,
  VARIANT_PICKER_PINS
} from '../lib/search'
import GeoQueryNote from '../components/GeoQueryNote'
import SearchFilters from '../components/SearchFilters'
import GeoCombo from './GeoCombo'
import { SearchIcon } from '../components/icons'
import EscapeCloser from '../components/EscapeCloser'
import SearchedAs from '../components/SearchedAs'

/**
 * Reusable semantic-search popup — the same search as the modelling canvas panel (lib/search): one
 * checkbox per background database and one for the library, largest background pre-ticked, hits
 * merged by rank, source chips. Opened from both Results tabs by one button, no dropdown. Picking a result
 * calls onPick with the resolved activity; the dialog stays open so
 * several datasets can be added in a row.
 */
export interface PickedActivity {
  database: string
  code: string
  name: string
  geography: string | null
  unit: string | null
  amount: number
}

export default function SearchDialog({
  databases,
  onPick,
  onClose,
  title = 'Pick from a database',
  searchDbs: sharedDbs,
  onSearchDbs
}: {
  databases: DatabaseInfo[]
  onPick: (a: PickedActivity) => void
  onClose: () => void
  title?: string
  /** The ticked databases of the model view's search panel, when the caller shares them: one set of
   *  checkboxes for the whole app — a box ticked here is ticked there. */
  searchDbs?: string[]
  onSearchDbs?: (dbs: string[]) => void
}): JSX.Element {
  // Controlled by the caller when it shares the model view's ticks; own state otherwise.
  const [ownDbs, setOwnDbs] = useState<string[]>(() => defaultSearchDbs(databases))
  const searchDbs = sharedDbs && onSearchDbs ? sharedDbs : ownDbs
  const setSearchDbs = (next: string[]): void => {
    if (sharedDbs && onSearchDbs) onSearchDbs(next)
    else setOwnDbs(next)
  }
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [added, setAdded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const s = useActivitySearch(searchDbs, setError)
  const offered = searchTargets(databases)
  const libraries = new Set(offered.filter((d) => d.kind === 'library').map((d) => d.name))
  const multiBackground =
    offered.filter((d) => d.kind === 'background' && searchDbs.includes(d.name)).length > 1
  const toggleDb = (name: string): void =>
    setSearchDbs(searchDbs.includes(name) ? searchDbs.filter((n) => n !== name) : [...searchDbs, name])

  const pick = (h: SearchHit): void => {
    const v = s.pickedVariant(h)
    if (!v) return
    const amount = Number(amounts[`${h.database}/${h.code}`] ?? '1')
    onPick({
      database: v.database,
      code: v.code,
      name: h.name,
      geography: v.geography,
      unit: h.unit ?? null,
      amount: Number.isFinite(amount) && amount !== 0 ? amount : 1
    })
    setAdded((prev) => new Set(prev).add(`${v.database}/${v.code}`))
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={() => onClose()} />
      <div className="modal sheet search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>{title}</h3>
            <p>Search the ticked databases, set the amount, and add what you need.</p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">
          <div className="search">
            <SearchIcon />
            <input
              autoFocus
              placeholder="e.g. electricity, medium voltage"
              value={s.query}
              onChange={(e) => s.setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && s.doSearch()}
              disabled={s.searching}
            />
          </div>
          <GeoQueryNote query={s.query} sentQuery={s.sentQuery} regionOptions={s.regionOptions} />
          <div className="search-dbs">
            {offered.map((d) => (
              <label className="search-db" key={d.name}>
                <input
                  type="checkbox"
                  checked={searchDbs.includes(d.name)}
                  onChange={() => toggleDb(d.name)}
                />
                <span className="search-db-name" title={d.name}>
                  {d.name}
                </span>
                {d.kind === 'library' ? (
                  <a
                    className="search-db-all"
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.preventDefault()
                      s.listAll(d.name)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && s.listAll(d.name)}
                  >
                    (list all)
                  </a>
                ) : null}
              </label>
            ))}
          </div>
          <div className="srow">
            <button
              className="btn sm primary"
              onClick={s.doSearch}
              disabled={s.searching || !s.query.trim() || !searchDbs.length}
            >
              {s.searching ? '…' : 'Search'}
            </button>
          </div>
          <SearchFilters
            typeSel={s.typeSel}
            toggleType={s.toggleType}
            regionSel={s.regionSel}
            addRegion={s.addRegion}
            removeRegion={s.removeRegion}
            regionOptions={s.regionOptions}
          />

          <div className="search-results">
            <SearchedAs
              alsoSearchedAs={s.alsoSearchedAs}
              searchedLiterally={s.searchedLiterally}
              sentQuery={s.sentQuery}
              onLiteral={s.searchLiteral}
            />
            {s.notes.length ? (
              <ul className="search-notes">
                {s.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            ) : null}
            {s.searching ? (
              <div className="search-status">
                <span className="spinner" />
                <span>
                  Searching… <em>the first search loads the language model (~1–2 min)</em>
                </span>
              </div>
            ) : s.searched && s.hits.length === 0 ? (
              <p className="empty">No matches. Try different words or filters.</p>
            ) : null}
            {s.hits.map((h) => {
              const variants = h.variants ?? []
              const multi = variants.length > 1
              const v = s.pickedVariant(h)
              const ready = v !== undefined
              const isAdded = v ? added.has(`${v.database}/${v.code}`) : false
              return (
                <div key={`${h.database}/${h.code}`} className="res">
                  <div className="nm" title={h.name.length > NAME_CLIP ? h.name : undefined}>
                    {clipName(h.name)}
                  </div>
                  <div className="chips">
                    <span className={`chip t-${h.activity_type}`}>{h.activity_type}</span>
                    {h.weak ? (
                      <span
                        className="chip weak"
                        title="Below the similarity threshold — a neighbour, not a match"
                      >
                        weak
                      </span>
                    ) : null}
                    {libraries.has(h.database) ? (
                      <span className="chip lib">{h.database}</span>
                    ) : multiBackground ? (
                      <span className={bgChipClass(h.database)} title={h.database}>
                        {shortDbLabel(h.database)}
                      </span>
                    ) : null}
                    {multi ? (
                      <GeoCombo
                        items={variants.map((vr) => ({ value: vr.code, geo: vr.geography ?? '' }))}
                        selected={s.pickedGeo[groupKey(h)]}
                        placeholder={`${variants.length} regions`}
                        pinned={VARIANT_PICKER_PINS}
                        onPick={(code) => s.pickGeo(groupKey(h), code)}
                      />
                    ) : h.geography ? (
                      <span className="chip">{h.geography}</span>
                    ) : null}
                    <span className="sd-amount" style={{ marginLeft: 'auto' }}>
                      <input
                        type="number"
                        className="fp-amt"
                        title="Amount of reference product"
                        value={amounts[`${h.database}/${h.code}`] ?? '1'}
                        onChange={(e) =>
                          setAmounts((m) => ({ ...m, [`${h.database}/${h.code}`]: e.target.value }))
                        }
                      />
                      <span className="fp-unit">{h.unit}</span>
                    </span>
                    <button
                      className="btn sm"
                      disabled={!ready}
                      title={ready ? 'Add as a comparison subject' : 'Pick a region first'}
                      onClick={() => pick(h)}
                    >
                      {isAdded ? '✓ Added' : 'Add'}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {error ? <div className="editor-err">{error}</div> : null}
        </div>
        <div className="sheet-foot">
          <div className="acts">
            <button className="btn sm" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
