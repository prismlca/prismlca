/**
 * What Claude's web search left in a reply, read from its content blocks: each search with its search
 * text and the pages it returned (`server_tool_use` + `web_search_tool_result`), and the pages the reply's
 * text cites (`web_search_result_location`). The transport hands both on as stream events; the blocks
 * themselves go back in the replay, untouched (anthropic.ts).
 */
import type { ChatMessage, Citation, WebSearch } from './types'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The search text of each web-search call among these blocks, by call id. */
function queriesOf(blocks: unknown[], into = new Map<string, string>()): Map<string, string> {
  for (const b of blocks)
    if (isObj(b) && b.type === 'server_tool_use' && isObj(b.input) && typeof b.input.query === 'string')
      into.set(String(b.id), b.input.query)
  return into
}

/** The search texts of the web searches the request's replayed rounds made. */
export function askedBefore(messages: ChatMessage[]): Map<string, string> {
  const asked = new Map<string, string>()
  for (const m of messages)
    if (m.role === 'assistant' && m.replay?.provider === 'anthropic' && Array.isArray(m.replay.steps))
      queriesOf(m.replay.steps, asked)
  return asked
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

/** Every page the search returned, cited ones first with the passage the model cited; a page no sentence
 *  cites is marked as such. */
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
  return [...pages.values()]
}
