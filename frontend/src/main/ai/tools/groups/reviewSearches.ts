/**
 * The WEB SEARCHES section of the review dossier: what the provider's web search looked for inside the
 * assistant's replies in this chat, which pages came back, which pages a reply opened, and the passages a
 * reply cited.
 *
 * A figure taken from such a search reaches the model as a number in an exchange and as a source in a
 * comment, and the reviewer saw only those: "whether the 24 kg is a retailer's figure is not visible in
 * the dossier". It cannot open a page either way; what it can see here is whether a page a comment names
 * came back from a search, and what kind of page that was.
 */
import { describeWebLookups } from '../../webLookups'
import type { WebRecord, WebSearch } from '../../providers/types'

/** The whole section stays below this — the process list it is read beside is the larger part. */
const SECTION_CHARS = 6_000
/** Pages per search while the section fits; a long one names fewer of each (`fit`). */
const RESULTS = [10, 5, 2]
const EXCERPT_CHARS = 200

const page = (p: { url: string; title?: string }): string =>
  p.title ? `${p.title.replace(/\s+/g, ' ').trim().slice(0, 80)} (${p.url})` : p.url

function searchLine(s: WebSearch, perSearch: number): string {
  const asked = s.query ? `"${s.query}"` : '(search text not reported)'
  if (!s.results) return `- ${asked} → pages not reported by the provider`
  if (!s.results.length) return `- ${asked} → no pages${s.error ? ` (${s.error})` : ''}`
  const more = s.results.length - perSearch
  return `- ${asked} → ${s.results.slice(0, perSearch).map(page).join('; ')}${more > 0 ? `; ${more} more` : ''}`
}

/** The dossier section, or '' when no reply of this chat looked anything up or cited a page. */
export function searchesSection(records: WebRecord[]): string {
  const searches = records.flatMap((r) => r.searches ?? [])
  const cited = new Map<string, { url: string; title?: string; excerpt?: string }>()
  for (const r of records) for (const c of r.cited ?? []) if (!cited.has(c.url)) cited.set(c.url, c)
  const opened = new Map<string, { url: string; title?: string }>()
  for (const r of records)
    for (const f of r.fetched ?? []) if (!f.error && !opened.has(f.url)) opened.set(f.url, f)
  // Lookups only counted, never named (OpenRouter's server tools): the kinds a reply did not name.
  const named = (r: WebRecord, kind: string): boolean =>
    kind === 'web_search_requests'
      ? !!r.searches?.length
      : kind === 'web_fetch_requests' && !!r.fetched?.length
  const unnamed = describeWebLookups(
    records.reduce<Record<string, number>>((all, r) => {
      for (const [k, n] of Object.entries(r.counts ?? {})) if (!named(r, k)) all[k] = (all[k] ?? 0) + n
      return all
    }, {})
  )?.short
  if (!searches.length && !opened.size && !cited.size && !unnamed) return ''
  const head =
    'WEB SEARCHES IN THIS CHAT (run by the provider inside the assistant’s replies — titles and ' +
    'addresses only, you cannot open them): a source a process comment names that is listed here came ' +
    'back from one of these searches or was opened in a reply, and the title says what kind of page it ' +
    'is (a manufacturer, a retailer, a study). Nothing follows from a source that is not listed: it may come from the research ' +
    'tools (their record is under RESEARCH ON RECORD when the model has one), from the user, or from a ' +
    'search this list no longer holds.'
  const quoted = [...cited.values()]
    .filter((c) => c.excerpt)
    .map((c) => `- "${c.excerpt!.slice(0, EXCERPT_CHARS)}" — ${page(c)}`)
  const fit = (perSearch: number): string =>
    [
      head,
      ...searches.map((s) => searchLine(s, perSearch)),
      opened.size ? `PAGES THE REPLIES OPENED: ${[...opened.values()].map(page).join('; ')}` : '',
      unnamed ? `Further lookups whose search texts the provider does not report: ${unnamed}.` : '',
      quoted.length ? 'PASSAGES THE REPLIES CITED:' : '',
      ...quoted,
      cited.size > quoted.length
        ? `PAGES THE REPLIES CITED: ${[...cited.values()]
            .filter((c) => !c.excerpt)
            .map(page)
            .join('; ')}`
        : ''
    ]
      .filter(Boolean)
      .join('\n')
  for (const n of RESULTS) {
    const text = fit(n)
    if (text.length <= SECTION_CHARS) return text
  }
  return `${fit(RESULTS[RESULTS.length - 1]).slice(0, SECTION_CHARS)} … [cut]`
}
