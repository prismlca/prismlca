import GeoCombo from '../views/GeoCombo'

/** Activity-type chips (P/M/G) + region multi-filter, shared by both search UIs.
 * Purely presentational — all state lives in useActivitySearch. */
export default function SearchFilters({
  typeSel,
  toggleType,
  regionSel,
  addRegion,
  removeRegion,
  regionOptions
}: {
  typeSel: string[]
  toggleType: (t: string) => void
  regionSel: string[]
  addRegion: (r: string) => void
  removeRegion: (r: string) => void
  regionOptions: string[]
}): JSX.Element {
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
            className={`tchip t-${k}${typeSel.includes(k) ? ' on' : ''}`}
            onClick={() => toggleType(k)}
            title="Filter by activity type (multi-select)"
          >
            {label}
          </button>
        ))}
      </div>
      <div className="region-box">
        <GeoCombo
          items={regionOptions.filter((r) => !regionSel.includes(r)).map((r) => ({ value: r, geo: r }))}
          placeholder="Filter regions… (type to find)"
          onPick={(code) => addRegion(code)}
        />
        {regionSel.length ? (
          <>
            <div className="region-chips">
              {regionSel.map((r) => (
                <span key={r} className="rchip">
                  {r}
                  <button onClick={() => removeRegion(r)}>×</button>
                </span>
              ))}
            </div>
            {/* A region decides, it does not merely nudge — and the two cases do different things.
                Said here because it is the one place where you can see what you asked for: with one
                region a poor match inside it is listed above a better one outside, and with several
                the others are gone entirely. Without this the first case reads as a bad search. */}
            <div className="region-note">
              {regionSel.length === 1
                ? `${regionSel[0]} first — before better matches from other regions. Nothing is hidden; keep scrolling.`
                : `Only ${regionSel.join(', ')} — hits from other regions are hidden.`}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
