import { useEffect, useState } from 'react'
import { api, type DatabaseInfo } from '../lib/api'
import {
  bgChipClass,
  clipName,
  groupKey,
  NAME_CLIP,
  searchTargets,
  useActivitySearch,
  type SearchHit,
  shortDbLabel,
  VARIANT_PICKER_PINS
} from '../lib/search'
import type { ConfirmSpec } from '../views/ConfirmDialog'
import type { IndexBuildStatus } from '../workbench/useSearchIndexStatus'
import GeoCombo from '../views/GeoCombo'
import { PencilIcon, SearchIcon } from './icons'
import GeoQueryNote from './GeoQueryNote'
import SearchFilters from './SearchFilters'
import { errMsg } from '../lib/errors'
import { fmtInt } from '../lib/format'
import { useIndexEta } from '../lib/indexEta'
import SearchedAs from './SearchedAs'

interface IndexInfo {
  database: string
  indexed: boolean
  indexed_count: number | null
  activities: number
  stale: boolean
  building: boolean
}

/** The canvas sidebar: semantic search over the ticked databases, with draggable results.
 *
 * Checkboxes rather than a dropdown, because the answer to "what do I put here" can come from more
 * than one place: ecoinvent and your own library are both valid, and picking one of them at a time
 * meant the library was only ever found by somebody who remembered to go looking for it. The lists
 * are merged by rank in the backend, so ticking a second box never reorders the first.
 *
 * Owns the full search state (via useActivitySearch); the host supplies the database list and the
 * ticked set, and receives resolved picks (add to canvas, show details, errors). */
export default function SearchPanel({
  databases,
  searchDbs,
  onSearchDbs,
  onAddReference,
  onShowDetails,
  onEditDataset,
  onError,
  confirm,
  buildStatus
}: {
  databases: DatabaseInfo[]
  searchDbs: string[]
  onSearchDbs: (dbs: string[]) => void
  onAddReference: (h: SearchHit) => void
  onShowDetails: (target: { database: string; code: string }) => void
  /** Open a library dataset for editing. Only the library is editable, and only one dataset at a
   *  time — the library is not a study, so it is not opened as one. */
  onEditDataset: (target: { database: string; code: string }) => void
  onError: (message: string | null) => void
  confirm: (spec: ConfirmSpec) => void
  buildStatus: IndexBuildStatus | null
}): JSX.Element {
  const s = useActivitySearch(searchDbs, onError)
  /** Index state per offered database — what decides whether a row needs an Index button at all. */
  const [idxInfo, setIdxInfo] = useState<Record<string, IndexInfo>>({})
  const offered = searchTargets(databases)
  // With two backgrounds ticked (ecoinvent and BAFU) a hit must say whose it is; with one, the chip
  // would only repeat the checkbox above.
  const multiBackground =
    offered.filter((d) => d.kind === 'background' && searchDbs.includes(d.name)).length > 1
  const building = buildStatus?.state === 'running'
  const eta = useIndexEta(buildStatus)

  // Which of the offered databases have a (fresh) index. Re-checked when a build finishes or one is
  // queued, so a row's Index button disappears on its own.
  const queued = buildStatus?.queued ?? []
  const buildPhase = `${buildStatus?.state ?? ''}:${buildStatus?.database ?? ''}:${queued.join('|')}`
  const offeredKey = JSON.stringify(offered.map((d) => d.name))
  useEffect(() => {
    let alive = true
    const names = JSON.parse(offeredKey) as string[]
    void Promise.all(
      names.map((db) =>
        api<IndexInfo>('GET', `/api/v1/search/index-info?database=${encodeURIComponent(db)}`).catch(
          () => null
        )
      )
    ).then((infos) => {
      if (!alive) return
      const next: Record<string, IndexInfo> = {}
      infos.forEach((info, i) => {
        if (info) next[names[i]] = info
      })
      setIdxInfo(next)
    })
    return () => {
      alive = false
    }
  }, [offeredKey, buildPhase])

  const doIndex = (db: string): void => {
    void (async () => {
      try {
        onError(null)
        await api('POST', '/api/v1/search/index', { database: db })
      } catch (e) {
        onError(errMsg(e))
      }
    })()
  }

  // Building embeds every activity from scratch — always confirm first. (An *import* no longer
  // needs this: it carries its own datasets into the index. This is the first build, or a rebuild
  // after the database was changed some other way.)
  const askIndex = (db: string): void => {
    const info = idxInfo[db]
    const n = info?.activities != null ? fmtInt(info.activities) : 'all'
    confirm({
      title: info?.indexed ? 'Rebuild search index' : 'Build search index',
      message: `${
        info?.indexed
          ? `“${db}” already has a search index — rebuilding embeds everything again from scratch.`
          : `“${db}” has no search index yet.`
      } All ${n} datasets are embedded locally on your CPU; for a large database this takes several minutes. Search keeps working on the existing index until the rebuild finishes.`,
      confirmLabel: info?.indexed ? 'Rebuild' : 'Build index',
      onConfirm: () => doIndex(db)
    })
  }

  /** Which of the offered databases can be written to — the library, and nothing else. */
  const editable = new Set(offered.filter((d) => d.kind === 'library').map((d) => d.name))

  /** An empty database has nothing to index — "not indexed" would send its owner looking for a fault. */
  const isEmpty = (db: string): boolean => idxInfo[db]?.activities === 0
  /** Ticked databases whose index cannot answer fully — the reason a search may come back short. */
  const stale = searchDbs.filter(
    (db) => idxInfo[db] && !isEmpty(db) && (!idxInfo[db].indexed || idxInfo[db].stale)
  )
  const emptyTicked = searchDbs.filter(isEmpty)
  // The biosphere holds elementary flows, not datasets; its build follows the background's.
  const buildUnit =
    databases.find((d) => d.name === buildStatus?.database)?.kind === 'biosphere' ? 'flows' : 'datasets'

  const toggleDb = (name: string): void =>
    onSearchDbs(searchDbs.includes(name) ? searchDbs.filter((n) => n !== name) : [...searchDbs, name])

  return (
    <aside className="panel search-panel">
      <div className="panel-h eyebrow">Semantic search</div>
      <div className="search">
        <SearchIcon />
        <input
          placeholder="e.g. electricity"
          value={s.query}
          onChange={(e) => s.setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && s.doSearch()}
          disabled={s.searching}
        />
      </div>
      <GeoQueryNote query={s.query} sentQuery={s.sentQuery} regionOptions={s.regionOptions} />
      <div className="search-dbs">
        {offered.map((d) => {
          const info = idxInfo[d.name]
          // The button appears where it is needed and nowhere else: an indexed, current database
          // has nothing to press, and an "Index" button next to it only invites a long rebuild.
          const needs = info && info.activities > 0 && (!info.indexed || info.stale)
          return (
            <label className="search-db" key={d.name}>
              <input type="checkbox" checked={searchDbs.includes(d.name)} onChange={() => toggleDb(d.name)} />
              <span className="search-db-name" title={d.name}>
                {d.name}
              </span>
              {/* Only for the library. "What have I got in there" is a question with no search
                  term — and for ecoinvent it is not a question, it is 26 533 rows. */}
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
              {info?.building ? (
                <span className="settings-hint">indexing…</span>
              ) : queued.includes(d.name) ? (
                <span className="settings-hint" title="Indexed automatically once the running build is done">
                  queued
                </span>
              ) : needs ? (
                <button
                  className="btn sm"
                  onClick={() => askIndex(d.name)}
                  disabled={building}
                  title={
                    info?.indexed
                      ? 'The index is out of date — rebuild it'
                      : 'This database has no search index yet'
                  }
                >
                  {info?.indexed ? 'Reindex' : 'Index'}
                </button>
              ) : null}
            </label>
          )
        })}
      </div>
      <div className="srow">
        <button
          className="btn sm primary"
          onClick={s.doSearch}
          disabled={s.searching || !s.query.trim() || !searchDbs.length}
          title={searchDbs.length ? undefined : 'Tick at least one database to search in'}
        >
          {s.searching ? '…' : 'Search'}
        </button>
      </div>
      {building && buildStatus ? (
        <div className="idx-progress" title={buildStatus.detail}>
          <div className="idx-progress-bar">
            <span
              style={{
                width:
                  buildStatus.total > 0
                    ? `${Math.round((buildStatus.count / buildStatus.total) * 100)}%`
                    : '100%'
              }}
            />
          </div>
          <div className="idx-progress-num idx-line">
            {buildStatus.total > 0 ? (
              <>
                <span>
                  Indexing <b>{buildStatus.database}</b> · {fmtInt(buildStatus.count)} /{' '}
                  {fmtInt(buildStatus.total)} {buildUnit}
                </span>
                {eta ? <span>{eta}</span> : null}
              </>
            ) : (
              'Indexing… preparing'
            )}
          </div>
          {/* Said while it runs, because it runs long the first time: what it is for, that it is kept,
              and why the app may answer slower meanwhile (the embedding takes every core). */}
          <div className="idx-note">
            Preparing semantic search — the index is saved and reused on later starts. PrismLCA may respond
            more slowly until it finishes.
          </div>
        </div>
      ) : null}
      {/* Said once, about the databases actually ticked — the Index buttons above say *where*, this
          says what it costs you meanwhile. A hint about a database nobody is searching is noise. */}
      {(stale.length || emptyTicked.length) && !building ? (
        <div className="idx-hint">
          {[
            ...stale.map((db) =>
              idxInfo[db]?.indexed
                ? `“${db}” has an out-of-date index (${fmtInt(idxInfo[db]?.indexed_count)} indexed, ${fmtInt(idxInfo[db]?.activities)} datasets) — some results may be missing.`
                : `“${db}” is not indexed, so nothing from it can be found yet.`
            ),
            ...emptyTicked.map((db) => `“${db}” is empty — nothing to find in it yet.`)
          ].join(' ')}
        </div>
      ) : null}
      <SearchFilters
        typeSel={s.typeSel}
        toggleType={s.toggleType}
        regionSel={s.regionSel}
        addRegion={s.addRegion}
        removeRegion={s.removeRegion}
        regionOptions={s.regionOptions}
      />
      <div className="panel-b">
        {/* Says what is on screen when it did not come from a query — without it a list of
            everything looks like a search result for whatever is still in the field. */}
        {s.listing && !s.searching ? <div className="search-listing">{s.listing}</div> : null}
        {/* What the answer says about itself — the backend has computed these signals for a long
            time and the panel used to keep only the hits, so a search that found nothing
            resembling the query looked exactly like one that found the right dataset. */}
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
          <p className="empty">No matches. Try different words, or check the type/region filters.</p>
        ) : null}
        {s.hits.map((h) => {
          const variants = h.variants ?? []
          const multi = variants.length > 1
          const ready = s.pickedVariant(h) !== undefined // multi-region needs an explicit pick first
          return (
            <div
              key={`${h.database}/${h.code}`}
              className="res"
              draggable={ready}
              onDragStart={(e) => {
                if (!ready) {
                  e.preventDefault()
                  return
                }
                e.dataTransfer.setData('application/prism-hit', JSON.stringify(s.resolveHit(h)))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              title={ready ? 'Drag onto the canvas, or click Select' : 'Pick a region first'}
            >
              <div className="nm" title={h.name.length > NAME_CLIP ? h.name : undefined}>
                {clipName(h.name)}
              </div>
              <div className="chips">
                <span className={`chip t-${h.activity_type}`}>{h.activity_type}</span>
                {/* Below the threshold: shown, because the alternative is cutting it away silently,
                    and a cosine cannot tell "not in here" from "named differently". Deliberately
                    quiet — it marks a row, it does not warn about it. */}
                {h.weak ? (
                  <span
                    className="chip weak"
                    title="Below the similarity threshold — a neighbour, not a match"
                  >
                    weak
                  </span>
                ) : null}
                {/* Whose dataset this is. The user's own processes answer to the same names as
                    ecoinvent's, and only the source tells them apart. */}
                {editable.has(h.database) ? (
                  <span className="chip lib">{h.database}</span>
                ) : multiBackground ? (
                  <span className={bgChipClass(h.database)} title={h.database}>
                    {shortDbLabel(h.database)}
                  </span>
                ) : null}
                <button
                  className="res-info"
                  disabled={!ready}
                  title={ready ? 'Process details' : 'Pick a region first'}
                  onClick={() => {
                    const r = s.resolveHit(h)
                    onShowDetails({ database: r.database, code: r.code })
                  }}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 11.5v4.5" />
                    <path d="M12 7.75h.01" />
                  </svg>
                </button>
                {multi ? (
                  <GeoCombo
                    items={variants.map((v) => ({ value: v.code, geo: v.geography ?? '' }))}
                    selected={s.pickedGeo[groupKey(h)]}
                    placeholder={`${variants.length} regions`}
                    pinned={VARIANT_PICKER_PINS}
                    onPick={(code) => s.pickGeo(groupKey(h), code)}
                  />
                ) : h.geography ? (
                  <span className="chip">{h.geography}</span>
                ) : null}
                {/* Your own dataset can be corrected where you found it. A background dataset
                    cannot be edited at all, so the pencil only exists for the library. */}
                {/* Flush with the other chips — a right-flying, larger pencil read as a different
                    kind of control than the tags it sits among. */}
                {editable.has(h.database) ? (
                  <button
                    className="res-info"
                    title="Edit this dataset — every model drawing on it follows the change"
                    onClick={() => onEditDataset({ database: h.database, code: h.code })}
                  >
                    <PencilIcon />
                  </button>
                ) : null}
                <button
                  className="btn sm"
                  style={{ marginLeft: 'auto' }}
                  disabled={!ready}
                  title={ready ? 'Add as a locked reference (Localize to edit)' : 'Pick a region first'}
                  onClick={() => onAddReference(s.resolveHit(h))}
                >
                  Select
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
