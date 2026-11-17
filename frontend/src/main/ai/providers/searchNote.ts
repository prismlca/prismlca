/**
 * The line that names a reply's web lookups where its round goes back without them.
 *
 * The provider's web search runs inside a reply, and what it searched for and which pages came back sit
 * in the provider's own blocks. Those go back only where a transport resends the round as it came
 * (Anthropic's replay). Everywhere else the round is rebuilt from its text and its calls — a turn's
 * closing answer, a round whose replay compaction dropped, every round on OpenRouter and OpenAI — and
 * the search vanished with it: asked where a figure came from, a model read its own source notes, found
 * no search behind them and declared them invented. This line keeps the search texts and the pages that
 * came back, as one line per search ahead of the round's text; the pages' text stays out.
 */
import { describeWebLookups } from '../webLookups'
import type { ChatMessage, CitedPage, WebRecord, WebSearch } from './types'

/** Pages named per search: a search returns about ten, and the address is what a later answer cites. */
const MAX_RESULTS = 10
/** A page title beyond this is cut: the address identifies the page, the title only helps to read it. */
const TITLE_CHARS = 100

const titled = (p: { url: string; title?: string }): string => {
  const title = p.title?.replace(/\s+/g, ' ').trim()
  if (!title) return p.url
  return `${title.length > TITLE_CHARS ? `${title.slice(0, TITLE_CHARS - 1)}…` : title} (${p.url})`
}

/** A cited page, with the passage the reply cited where the provider names it. */
const citedLine = (c: CitedPage): string => `- ${c.excerpt ? `"${c.excerpt}" — ` : ''}${titled(c)}`

function searchLine(s: WebSearch, i: number): string {
  const asked = s.query ? `"${s.query}"` : '(search text not reported)'
  if (!s.results) return `${i + 1}. ${asked} → pages not reported by the provider`
  if (!s.results.length) return `${i + 1}. ${asked} → no pages${s.error ? ` (${s.error})` : ''}`
  const more = s.results.length - MAX_RESULTS
  const pages = s.results.slice(0, MAX_RESULTS).map(titled).join('; ')
  return `${i + 1}. ${asked} → ${pages}${more > 0 ? `; ${more} more` : ''}`
}

/**
 * The record of a reply's web lookups in words, or null when the provider looked nothing up. Written to
 * be read by the model as the record of its own reply: what it searched for, which pages it saw, which it
 * cited with the passage it cited — and that only these survive. The passages matter: asked about a
 * statement its reply had cited, a model that found only the page's title withdrew the statement as
 * unsupported, though the passage said exactly that.
 */
export function searchNote(web: WebRecord | undefined): string | null {
  if (!web) return null
  const searches = web.searches ?? []
  const cited: CitedPage[] = web.cited ?? []
  const counted = describeWebLookups(web.counts)?.short
  if (!searches.length && !cited.length && !counted) return null
  const lines: string[] = []
  if (searches.length)
    lines.push(
      `In this reply you searched the web ${searches.length === 1 ? 'once' : `${searches.length} times`} ` +
        'through the provider. Kept are what you searched for, the pages that came back and the passages ' +
        'your reply cited; the rest of the pages’ text is gone:',
      ...searches.map(searchLine)
    )
  else if (counted)
    lines.push(
      `In this reply the provider looked things up on the web for you (${counted}). It reports neither ` +
        'what was searched for nor the pages that came back.'
    )
  if (cited.length) lines.push('Cited in this reply:', ...cited.map(citedLine))
  return `[Web search record kept by PrismLCA. ${lines.join('\n')}]`
}

/** An assistant message's content with the record of its web lookups in front — for a transport that
 *  sends the chat-shaped content on as it is (OpenRouter). Text, a list of parts, or nothing at all. A
 *  list gets the record inside its first text part: the agent's cache breakpoint turns a text into one
 *  such part and back when it moves on, and the message must read the same either way. */
export function withSearchNote(
  content: ChatMessage['content'],
  web: WebRecord | undefined
): ChatMessage['content'] {
  const note = searchNote(web)
  if (!note) return content
  const ahead = (text: string): string => (text.trim() ? `${note}\n\n${text}` : note)
  if (!Array.isArray(content)) return ahead(content ?? '')
  const i = content.findIndex((p) => p?.type === 'text')
  if (i < 0) return [{ type: 'text', text: note }, ...content]
  return content.map((p, j) => (j === i ? { ...p, text: ahead(String(p.text ?? '')) } : p))
}
