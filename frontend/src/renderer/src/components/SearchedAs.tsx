/**
 * What the search added to the query, and the way back — the "Showing results for … · Search instead for …"
 * line of a web search engine. ecoinvent spells polymers out and carries "PET" only in
 * the names of waste streams, so the backend also searches an abbreviation spelled out the way the
 * database names the material. It ADDS that reading rather than replacing the query, hence "also"; and
 * because a reading can be wrong ("pet food"), the link repeats the search with the text exactly as typed —
 * for that one search, not as a setting. Says nothing when nothing was added.
 */
export default function SearchedAs({
  alsoSearchedAs,
  searchedLiterally,
  sentQuery,
  onLiteral
}: {
  alsoSearchedAs: string | null
  searchedLiterally: string | null
  sentQuery: string
  onLiteral: () => void
}): JSX.Element | null {
  if (searchedLiterally)
    return <div className="search-asked">Searched only for “{searchedLiterally}”, as typed.</div>
  if (!alsoSearchedAs) return null
  return (
    <div className="search-asked">
      Also searched as <b>{alsoSearchedAs}</b> ·{' '}
      <button type="button" className="link-btn" onClick={onLiteral}>
        Search only for “{sentQuery}”
      </button>
    </div>
  )
}
