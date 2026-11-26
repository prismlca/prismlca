/**
 * The research eval's check of what a result cites (research-eval.test.ts): does a cited page answer at all, and
 * does it carry the claim? Used by the eval only — nothing in the app imports it — because it fetches the pages
 * itself and asks a judge model, both of which the app never does on its own.
 */
import { streamChat } from '../client'
import type { ChatMessage } from '../providers/types'
import { extractJson } from '../subagent'

export interface UrlProbe {
  url: string
  alive: boolean
  status?: number
}

/**
 * Does the URL answer at all? 403/405/429 and friends count as ALIVE — a bot wall proves the server
 * and the path exist, which is all this probe can honestly claim. Dead is 404/410 or no answer.
 */
export async function probeUrl(url: string): Promise<UrlProbe> {
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(10_000) })
      if (res.status === 404 || res.status === 410) return { url, alive: false, status: res.status }
      // HEAD is often refused outright where GET works; only a 4xx/5xx on HEAD warrants the retry.
      if (method === 'HEAD' && res.status >= 400) continue
      return { url, alive: true, status: res.status }
    } catch {
      if (method === 'GET') return { url, alive: false }
    }
  }
  return { url, alive: false }
}

/** Fetch a cited page and reduce it to judgeable text. Best-effort — an unreadable page is a verdict. */
async function fetchPageText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    // A PDF (or image, or archive) read as text is byte noise, and on the first run the judge dutifully
    // ruled "not_on_page" against two claims whose cited PDF very likely carries them. Unreadable is
    // the honest verdict for anything this harness cannot actually read.
    const kind = res.headers.get('content-type') ?? ''
    if (kind && !/text|html|xml|json/i.test(kind)) return null
    const raw = await res.text()
    const text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return text.length > 200 ? text.slice(0, 15_000) : null
  } catch {
    return null
  }
}

export interface SupportCheck {
  claim: string
  url: string
  verdict: string
  quote?: string
  /** Why the judge gave no verdict ("judge_failed"): the provider's message, so a run says what to fix. */
  error?: string
}

/** Ask the judge model whether the cited page actually carries the claim (the "carries" axis). */
export async function supportCheck(
  claim: string,
  url: string,
  judge: string,
  onCost: (usd: number) => void
): Promise<SupportCheck> {
  const page = await fetchPageText(url)
  if (!page) return { claim, url, verdict: 'page_unreadable' }
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'You verify citations. You are given a CLAIM from a research result and the TEXT of the web ' +
        'page it cites. Answer with JSON only: {"verdict": "supports" | "partly" | "contradicts" | ' +
        '"not_on_page", "quote": "<the shortest passage that decides it, or empty>"}. A page giving ' +
        'the same figure within rounding supports the claim; a page about something else entirely is ' +
        '"not_on_page". If the researcher\'s note says the figure is their own estimate or calculation, do not ' +
        'look for the figure itself: answer "partly" when the page states inputs the note names (dimensions, ' +
        'densities, other figures), "not_on_page" when it states none of them.'
    },
    { role: 'user', content: `CLAIM: ${claim}\n\nPAGE TEXT (truncated): ${page}` }
  ]
  try {
    let text = ''
    for await (const ev of streamChat({ model: judge, messages, temperature: null })) {
      if (ev.type === 'delta') text += ev.text
      else if (ev.type === 'usage') onCost(ev.usage.cost ?? 0)
    }
    const parsed = extractJson(text) as { verdict?: unknown; quote?: unknown }
    const verdict = String(parsed.verdict ?? '')
    if (!['supports', 'partly', 'contradicts', 'not_on_page'].includes(verdict))
      return { claim, url, verdict: 'judge_unparseable' }
    return { claim, url, verdict, ...(parsed.quote ? { quote: String(parsed.quote).slice(0, 300) } : {}) }
  } catch (e) {
    return { claim, url, verdict: 'judge_failed', error: e instanceof Error ? e.message : String(e) }
  }
}
