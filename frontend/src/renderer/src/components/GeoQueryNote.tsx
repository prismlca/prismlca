import { geoTermsInQuery } from '../lib/geoInQuery'

/**
 * The line under the search field: the rule before anything is typed, the caught place name after.
 *
 * One slot, two tones — so the panel does not jump when it changes, and so the remark is read where
 * the mistake is made rather than further down among the filters. It never
 * blocks anything: the query goes out exactly as typed, and the line says so.
 */
export default function GeoQueryNote({
  query,
  sentQuery,
  regionOptions
}: {
  query: string
  /** The query as last SENT — a word under the cursor is not judged until it is finished. */
  sentQuery: string
  regionOptions: string[]
}): JSX.Element {
  const places = geoTermsInQuery(query, regionOptions, query.trim() === sentQuery.trim())
  if (!places.length) {
    return <div className="geo-note">A region/country is a filter, not a search word.</div>
  }
  return (
    <div className="geo-hint" role="note">
      <b>{places.map((p) => `“${p}”`).join(', ')}</b> {places.length > 1 ? 'are places' : 'is a place'}, and
      places are not part of the search text. Pick the region in the filter below, or on a hit that has
      several. Your search ran unchanged.
    </div>
  )
}
