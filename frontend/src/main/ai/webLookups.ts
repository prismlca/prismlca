/**
 * The provider-side web lookups of one reply: in words, and as the chat records them.
 *
 * The provider runs its web search (and OpenRouter and Anthropic their page fetch) inside a reply.
 * OpenRouter reports only counters; Anthropic and OpenAI also name what was searched for, and Anthropic
 * which pages came back and which it opened. The chat's trace row, the round's log line and the log line of a research or review request all
 * name them the same way, from here; the round's record (`WebRecord`) rides on its message, where a later
 * request reads it back (providers/searchNote.ts) and the review dossier lists it.
 */
import type { ToolTrace } from '../../shared/ipc'
import type { CitedPage, Citation, WebFetch, WebRecord, WebSearch } from './providers/types'

/** Trace-row name for the provider-side web lookups of a round. Not a tool: nothing dispatches on it. */
export const WEB_LOOKUPS_ROW = 'web_lookups'

/** Longest cited passage kept: enough to show the sentence a figure came from. */
const EXCERPT_CHARS = 300

/**
 * Put a provider's `server_tool_use` counters into words. `web_search_requests` and
 * `web_fetch_requests` are the two known kinds; any other `*_requests` counter is named as it comes.
 * Returns null when nothing ran, so a round without lookups adds no row.
 */
export function describeWebLookups(
  use: Record<string, number> | undefined
): { short: string; preview: string; total: number } | null {
  if (!use || typeof use !== 'object') return null
  const parts: string[] = []
  let total = 0
  for (const [key, raw] of Object.entries(use)) {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n) || n <= 0) continue
    total += n
    const kind = key.replace(/_requests$/, '')
    const noun =
      kind === 'web_search'
        ? n === 1
          ? 'web search'
          : 'web searches'
        : kind === 'web_fetch'
          ? n === 1
            ? 'page fetched'
            : 'pages fetched'
          : `${kind.replace(/_/g, ' ')} ${n === 1 ? 'call' : 'calls'}`
    parts.push(`${n} ${noun}`)
  }
  if (!total) return null
  const short = parts.join(', ')
  const preview =
    `${short} — run by the provider inside this reply. Every lookup makes the model read the whole ` +
    `conversation again, so this round's input tokens and cost cover ${total + 1} passes, not one. ` +
    `Settings → AI → Chat caps how many lookups one reply may run.`
  return { short, preview, total }
}

/**
 * One round's web lookups as they stream in — the counters from its usage reports, the searches and the
 * pages it cites from the reply — handed over once when the round's reply is complete. A paused reply that
 * is continued reports each pass; they add up to one round.
 */
export class RoundLookups {
  private counts: Record<string, number> = {}
  private searches: WebSearch[] = []
  private fetched: WebFetch[] = []
  private cited = new Map<string, CitedPage>()

  count(use: Record<string, number> | undefined): void {
    for (const [key, raw] of Object.entries(use ?? {})) {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (Number.isFinite(n) && n > 0) this.counts[key] = (this.counts[key] ?? 0) + n
    }
  }

  searched(list: WebSearch[]): void {
    this.searches.push(...list)
  }

  opened(list: WebFetch[]): void {
    this.fetched.push(...list)
  }

  /** The pages the reply cites, once each — a page the search only returned is not a citation. */
  cite(list: Citation[]): void {
    for (const c of list) {
      if (c.uncited || !c.url || this.cited.has(c.url)) continue
      const excerpt = c.excerpt?.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)
      this.cited.set(c.url, {
        url: c.url,
        ...(c.title ? { title: c.title } : {}),
        ...(excerpt ? { excerpt } : {})
      })
    }
  }

  /** The round's record and its trace row, or null when the provider looked nothing up and the reply
   *  cites nothing; either way the next round starts empty. */
  take(): { record: WebRecord; row: ToolTrace } | null {
    const counts = Object.keys(this.counts).length ? this.counts : undefined
    const searches = this.searches
    const fetched = this.fetched
    const cited = [...this.cited.values()]
    this.counts = {}
    this.searches = []
    this.fetched = []
    this.cited = new Map()
    const described = describeWebLookups(counts)
    if (!described && !searches.length && !fetched.length && !cited.length) return null
    const n = searches.length
    const preview =
      described?.preview ??
      (n
        ? `${n} web ${n === 1 ? 'search' : 'searches'} — run by the provider inside this reply.`
        : 'No lookup in this reply — it cites pages an earlier search returned.')
    const record: WebRecord = {
      ...(counts ? { counts } : {}),
      ...(n ? { searches } : {}),
      ...(fetched.length ? { fetched } : {}),
      ...(cited.length ? { cited } : {})
    }
    const row: ToolTrace = {
      name: WEB_LOOKUPS_ROW,
      status: 'ok',
      preview,
      resultChars: preview.length,
      ...(n ? { searches } : {}),
      ...(fetched.length ? { fetched } : {}),
      ...(cited.length ? { cited } : {})
    }
    return { record, row }
  }
}
