/**
 * What Claude's web search and page fetch left in a reply, read from its content blocks: each search with
 * its search text and the pages it returned (`server_tool_use` + `web_search_tool_result`), each page it
 * opened (`web_fetch_tool_result`), and the pages the reply's text cites (`web_search_result_location`).
 * The transport hands them on as stream events; the blocks themselves go back in the replay, untouched
 * (anthropic.ts).
 */
import type { ChatMessage, Citation, WebFetch, WebSearch } from './types'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** What each server-tool call among these blocks asked for, by call id: the search text of a web search,
 *  the address of a page fetch. */
function queriesOf(blocks: unknown[], into = new Map<string, string>()): Map<string, string> {
  for (const b of blocks) {
    if (!isObj(b) || b.type !== 'server_tool_use' || !isObj(b.input)) continue
    const asked = typeof b.input.query === 'string' ? b.input.query : b.input.url
    if (typeof asked === 'string') into.set(String(b.id), asked)
  }
  return into
}

/** What the server-tool calls of the request's replayed rounds asked for — search texts, addresses. */
export function askedBefore(messages: ChatMessage[]): Map<string, string> {
  const asked = new Map<string, string>()
  for (const m of messages)
    if (m.role === 'assistant' && m.replay?.provider === 'anthropic' && Array.isArray(m.replay.steps))
      queriesOf(m.replay.steps, asked)
  return asked
}

/** An opened page's result as the API puts it (`web_fetch_result`, or an error object). */
const fetchResult = (b: Record<string, unknown>): Record<string, unknown> =>
  isObj(b.content) ? b.content : {}

/** The title of an opened page, where the fetch names one (a PDF often has none). */
function fetchTitle(result: Record<string, unknown>): string | undefined {
  const doc = isObj(result.content) ? result.content : {}
  return typeof doc.title === 'string' && doc.title.trim() ? doc.title.trim() : undefined
}

/**
 * Every page this reply opened, or tried to: its address and title, or the provider's reason it could not
 * be opened. The address comes from the result, and for a failed fetch from its call — in this reply, or
 * in the one before it when the fetch ran on the next request, as a search does (searchesOf).
 */
export function fetchesOf(blocks: Record<string, unknown>[], asked: Map<string, string>): WebFetch[] {
  const calls = queriesOf(blocks, new Map(asked))
  const out: WebFetch[] = []
  for (const b of blocks) {
    if (b.type !== 'web_fetch_tool_result') continue
    const r = fetchResult(b)
    const url = typeof r.url === 'string' && r.url ? r.url : calls.get(String(b.tool_use_id))
    if (!url) continue
    const title = fetchTitle(r)
    const error = typeof r.error_code === 'string' && r.error_code ? r.error_code : undefined
    out.push({ url, ...(title ? { title } : {}), ...(error ? { error } : {}) })
  }
  return out
}

/**
 * Every web search this reply holds a result for, with its search text and the pages it returned. The
 * text comes from the call: in this reply, or in the one before it when Claude searched beside one of
 * our tools and the API ran the search on the next request — or on the continuation of a paused reply.
 */
export function searchesOf(blocks: Record<string, unknown>[], asked: Map<string, string>): WebSearch[] {
  const queries = queriesOf(blocks, new Map(asked))
  const out: WebSearch[] = []
  for (const b of blocks) {
    if (b.type !== 'web_search_tool_result') continue
    const query = queries.get(String(b.tool_use_id))
    const results = (Array.isArray(b.content) ? b.content : [])
      .filter((r) => isObj(r) && r.type === 'web_search_result' && typeof r.url === 'string' && r.url)
      .map((r: Record<string, unknown>) => ({
        url: String(r.url),
        ...(typeof r.title === 'string' && r.title ? { title: r.title } : {})
      }))
    const error = isObj(b.content) && typeof b.content.error_code === 'string' ? b.content.error_code : ''
    out.push({ ...(query ? { query } : {}), results, ...(error ? { error } : {}) })
  }
  return out
}

/** Every page the search returned or the fetch opened, cited ones first with the passage the model cited;
 *  a page no sentence cites is marked as such. */
export function citationsOf(blocks: Record<string, unknown>[]): Citation[] {
  const pages = new Map<string, Citation>()
  for (const b of blocks)
    if (b.type === 'text' && Array.isArray(b.citations))
      for (const c of b.citations)
        if (isObj(c) && c.type === 'web_search_result_location' && typeof c.url === 'string' && c.url) {
          const page = pages.get(c.url) ?? { url: c.url }
          if (typeof c.title === 'string' && c.title) page.title = c.title
          if (!page.excerpt && typeof c.cited_text === 'string' && c.cited_text) page.excerpt = c.cited_text
          pages.set(c.url, page)
        }
  for (const b of blocks)
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content))
      for (const r of b.content)
        if (
          isObj(r) &&
          r.type === 'web_search_result' &&
          typeof r.url === 'string' &&
          r.url &&
          !pages.has(r.url)
        )
          pages.set(r.url, {
            url: r.url,
            ...(typeof r.title === 'string' && r.title ? { title: r.title } : {}),
            uncited: true
          })
  // An opened page was delivered as much as a search result: a research leg may name it as its source.
  for (const b of blocks) {
    if (b.type !== 'web_fetch_tool_result') continue
    const r = fetchResult(b)
    if (r.type !== 'web_fetch_result' || typeof r.url !== 'string' || !r.url || pages.has(r.url)) continue
    const title = fetchTitle(r)
    pages.set(r.url, { url: r.url, ...(title ? { title } : {}), uncited: true })
  }
  return [...pages.values()]
}
