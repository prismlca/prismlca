import GeoCombo from '../views/GeoCombo'
import { type useActivitySearch } from '../lib/search'
import UnitFilter from './UnitFilter'

type FilterState = Pick<
  ReturnType<typeof useActivitySearch>,
  | 'typeSel'
  | 'toggleType'
  | 'regionSel'
  | 'addRegion'
  | 'removeRegion'
  | 'regionOptions'
  | 'loadRegions'
  | 'unitSel'
  | 'addUnit'
  | 'removeUnit'
  | 'unitOptions'
  | 'loadUnits'
  | 'listing'
>

/** Activity-type chips (P/M/G), region multi-filter and unit filter, shared by both search UIs.
 * Purely presentational — all state lives in useActivitySearch. A change takes effect at once: the hook
 * repeats the last search with it. */
export default function SearchFilters({ s }: { s: FilterState }): JSX.Element {
  const listing = s.listing !== null
  const anyFilter = s.typeSel.length > 0 || s.regionSel.length > 0 || s.unitSel.length > 0
  return (
    <div className="filters">
      <div className="type-chips">
        {[
          ['P', 'Production'],
          ['M', 'Market'],
          ['G', 'Market group']
        ].map(([k, label]) => (
          <button
            key={k}
            className={`tchip t-${k}${s.typeSel.includes(k) ? ' on' : ''}`}
            onClick={() => s.toggleType(k)}
            title="Filter by activity type (multi-select)"
          >
            {label}
          </button>
        ))}
      </div>
      <div className="region-box">
        <GeoCombo
          items={s.regionOptions.filter((r) => !s.regionSel.includes(r)).map((r) => ({ value: r, geo: r }))}
          placeholder="Filter regions… (type to find)"
          onPick={(code) => s.addRegion(code)}
          onFocus={s.loadRegions}
        />
        {s.regionSel.length ? (
          <>
            <div className="region-chips">
              {s.regionSel.map((r) => (
                <span key={r} className="rchip">
                  {r}
                  <button onClick={() => s.removeRegion(r)}>×</button>
                </span>
              ))}
            </div>
            {/* A region decides, it does not merely nudge — and the two cases do different things.
                Said here because it is the one place where you can see what you asked for: with one
                region a poor match inside it is listed above a better one outside, and with several
                the others are gone entirely. Without this the first case reads as a bad search. */}
            {listing ? null : (
              <div className="region-note">
                {s.regionSel.length === 1
                  ? `${s.regionSel[0]} first — before better matches from other regions. Nothing is hidden; keep scrolling.`
                  : `Only ${s.regionSel.join(', ')} — hits from other regions are hidden.`}
              </div>
            )}
          </>
        ) : null}
      </div>
      <UnitFilter
        unitSel={s.unitSel}
        unitOptions={s.unitOptions}
        addUnit={s.addUnit}
        removeUnit={s.removeUnit}
        loadUnits={s.loadUnits}
        listing={listing}
      />
      {/* A listing shows a whole database as it is; saying what the filters do would describe a search
          that is not on screen. */}
      {listing && anyFilter ? (
        <div className="region-note">Filters apply to searches, not to this list.</div>
      ) : null}
    </div>
  )
}
