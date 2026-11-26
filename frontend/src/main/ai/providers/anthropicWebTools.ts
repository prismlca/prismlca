/**
 * Claude's server-side web tools as a request carries them: web search and page fetch, with the lookup cap, the
 * hosts they may use and the hosts the search leaves out, and how much of an opened page the model reads. The
 * transport (anthropic.ts) adds them beside the function tools; what they left in a reply is read in
 * anthropicSearch.ts.
 */
import type { StreamChatOpts } from './types'

/** The most of one opened page's text the model reads (`max_content_tokens`; Anthropic sets no limit).
 *  An opened page stays in the conversation: the round that read it goes back verbatim in every later
 *  request — a reply's closing round too, where it opened a page (`finish`) — at the cache-read price.
 *  Inside its turn compaction may not drop it; in a later turn it may, and the record then names the
 *  page (searchNote.ts). A large
 *  documentation page is about 25,000 tokens by Anthropic's own example — room for a data sheet or a
 *  statistics page, and a cap on a page that runs on for ten times that. With the lookup cap, which
 *  Anthropic counts across a whole tool loop rather than per request, a turn reads at most cap × this
 *  much page text. The fetch cuts the text at the limit; a PDF it does not cut (the API's PDF limits
 *  hold). */
export const FETCH_MAX_CONTENT_TOKENS = 25_000

/**
 * The two tools for this request. The cap and the allow list hold for each tool on its own, as on OpenRouter.
 * Unlike there, the cap counts across the whole tool loop: a request whose last message holds only tool results
 * continues the turn, and the lookups of its earlier requests count against `max_uses`. A note of ours after the
 * results (plan reminder, screenshot, compaction summary) starts a new turn and a new count, unless a server call
 * is still open and foldIntoOpenTurn moves it into the last result. Sending a fresh cap per request instead would
 * change the tool definition and, per Anthropic's caching rules, throw away the cached conversation each time.
 *
 * The search may leave hosts out (`blocked_domains`, subdomains included), never together with an allow list —
 * the API takes one or the other. The fetch keeps them: a page there may still be opened by its address.
 */
export function webTools(
  opts: Pick<StreamChatOpts, 'webLookupsCap' | 'webDomains' | 'webSearchExcluded'>
): Record<string, unknown>[] {
  const limits = {
    ...(opts.webLookupsCap ? { max_uses: opts.webLookupsCap } : {}),
    ...(opts.webDomains?.length ? { allowed_domains: opts.webDomains } : {})
  }
  const blocked =
    !opts.webDomains?.length && opts.webSearchExcluded?.length
      ? { blocked_domains: opts.webSearchExcluded }
      : {}
  return [
    { type: 'web_search_20250305', name: 'web_search', ...limits, ...blocked },
    { type: 'web_fetch_20250910', name: 'web_fetch', ...limits, max_content_tokens: FETCH_MAX_CONTENT_TOKENS }
  ]
}
