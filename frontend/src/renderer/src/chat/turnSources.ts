/**
 * What a finished turn's web lookups add up to, read from its trace: the pages the answer cites, the pages
 * it opened and the searches behind it (main/ai/webLookups.ts writes them on the provider's web lookups
 * row). The trace is what is stored with the answer, so the list survives a reload without a field of its
 * own.
 */
import type { CitedPage, ToolTrace, WebFetch, WebSearch } from '../lib/ai'

/** The trace row of the provider's own web lookups (main/ai/webLookups.ts WEB_LOOKUPS_ROW). */
export const WEB_LOOKUPS_ROW = 'web_lookups'

/** The turn's cited pages (each once, in the order cited), the pages it opened (each once, the ones that
 *  could not be opened left out) and its searches, in the order run. */
export function webSourcesOf(traces: ToolTrace[] | undefined): {
  cited: CitedPage[]
  opened: WebFetch[]
  searches: WebSearch[]
} {
  const cited = new Map<string, CitedPage>()
  const opened = new Map<string, WebFetch>()
  const searches: WebSearch[] = []
  for (const t of traces ?? []) {
    if (t.name !== WEB_LOOKUPS_ROW) continue
    for (const c of t.cited ?? []) if (c?.url && !cited.has(c.url)) cited.set(c.url, c)
    for (const f of t.fetched ?? []) if (f?.url && !f.error && !opened.has(f.url)) opened.set(f.url, f)
    for (const s of t.searches ?? []) if (s) searches.push(s)
  }
  return { cited: [...cited.values()], opened: [...opened.values()], searches }
}

/** Only a web address opens in the browser; anything else a provider might hand over stays text. */
export const openable = (url: string): boolean => /^https?:\/\//i.test(url)

/** The site a page is on, as a reader recognises it: the host without `www.`. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
