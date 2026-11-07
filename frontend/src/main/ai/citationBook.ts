/**
 * The evidence book of the research sub-agents: the pages the provider's web search actually cited,
 * one entry per page, and the matching of what a leg WROTE as its source against them — the engine's
 * record against the model's (BomItem.cited_by_search). One comparable key per URL, and the provider's
 * own links to a page (Google's citation redirects) known as aliases of it.
 */
import type { Citation } from './providers/types'

/** A cited page as the result hands it on: the engine's URL, and the excerpt the model read when
 *  the engine supplied one (Exa highlights; a direct OpenAI search carries none). */
export interface Evidence {
  url: string
  title?: string
  excerpt?: string
}

/** Longest excerpt kept per evidence entry — enough to show the table row a figure came from. */
const EXCERPT_CHARS = 400
/** Evidence entries per result; the legs cite a handful, the cap only stops a runaway listing. */
const MAX_EVIDENCE = 12

/** One comparable key per URL: scheme, `www.`, trailing slash and fragment do not make a different page. */
export function urlKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/#.*$/, '')
    .replace(/[.,;)]+$/, '')
    .replace(/\/+$/, '')
}

/** Collect citations across a leg's passes, one entry per page, first excerpt wins. */
export class CitationBook {
  private readonly byKey = new Map<string, Evidence>()
  /** A provider's own link to a page (`Citation.via`) → that page's key. */
  private readonly aliases = new Map<string, string>()
  add(citations: Citation[]): void {
    for (const c of citations) {
      const key = urlKey(c.url)
      if (!key) continue
      for (const v of c.via ?? []) if (urlKey(v)) this.aliases.set(urlKey(v), key)
      const cur = this.byKey.get(key)
      const excerpt = c.excerpt?.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)
      if (!cur) {
        this.byKey.set(key, {
          url: c.url,
          ...(c.title ? { title: c.title } : {}),
          ...(excerpt ? { excerpt } : {})
        })
      } else if (!cur.excerpt && excerpt) cur.excerpt = excerpt
    }
  }
  get size(): number {
    return this.byKey.size
  }
  has(url: string): boolean {
    return this.byKey.has(this.keyOf(url))
  }
  /**
   * The page a URL stands for. A model grounded by Google quotes the redirect link it was shown, not
   * the page (measured: every `source_url` of a research_bom run on Gemini) — this turns such a link
   * back into the page the engine resolved it to, so the item is matched, evidenced and stored under
   * an address that still works next month. Any other URL comes back unchanged.
   */
  canonical(url: string): string {
    const key = urlKey(url)
    const alias = this.aliases.get(key)
    return !this.byKey.has(key) && alias ? (this.byKey.get(alias)?.url ?? url) : url
  }
  private keyOf(url: string): string {
    const key = urlKey(url)
    return this.byKey.has(key) ? key : (this.aliases.get(key) ?? key)
  }
  /** The cited pages behind these URLs, in the order the URLs are given, each page once. */
  evidenceFor(urls: string[]): Evidence[] {
    const out: Evidence[] = []
    const seen = new Set<string>()
    for (const u of urls) {
      const key = this.keyOf(u)
      const e = this.byKey.get(key)
      if (e && !seen.has(key)) {
        seen.add(key)
        out.push(e)
      }
      if (out.length >= MAX_EVIDENCE) break
    }
    return out
  }
}

/** Hosts a provider cites THROUGH: Google grounds with redirect links that only it can resolve. */
const PROVIDER_LINK_HOSTS = new Set(['vertexaisearch.cloud.google.com'])

/**
 * Is this a provider's citation link rather than a page? One the book could not turn into a page leads
 * nowhere — measured: a model copying Google's ~200-character link tokens mangles some, and Google
 * answers those with 404. Such a link is no address to store or to send a reader to.
 */
export function isProviderLink(url: string): boolean {
  try {
    return PROVIDER_LINK_HOSTS.has(new URL(url).host)
  } catch {
    return false
  }
}
