/**
 * The project news feed: read it from prismlca.com and turn RSS 2.0 into a handful of plain-text items.
 *
 * A parser of our own rather than a dependency: the feed is ours, RSS 2.0 items are five flat tags,
 * and a full XML library in the main bundle for that would be the larger risk. What it guarantees is
 * what the renderer relies on — plain text only (markup stripped, entities decoded), https links
 * only, newest first, at most `MAX_ITEMS`.
 */
import { DistanceHttpError, fetchJson } from '../distance/http'
import { NEWS_FEED_URL, NEWS_SOURCE_LABEL, type NewsFeed, type NewsItem } from '../../shared/news'

/** At most this many items cross the bridge; the card shows three of them (NEWS_SHOWN). */
export const MAX_ITEMS = 10
/** A teaser is one line on the card; the rest is what the link is for. */
export const TEASER_CHARS = 200

/** Refused unread past this size: the feed is a few kilobytes, and the parse runs synchronously in main. */
export const MAX_FEED_BYTES = 512 * 1024
/** Items looked at before sorting. A feed lists its newest first; nothing past this could matter. */
export const MAX_SCANNED_ITEMS = 50
/** A description is cut to this many characters BEFORE its markup is stripped — the teaser needs 200. */
const MAX_DESCRIPTION_CHARS = 8 * 1024

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** One pass, so `&amp;lt;` becomes `&lt;` and not `<`. Every repetition is bounded, so a run of
 *  `&aaaa…` without a semicolon costs a constant per character, not the rest of the string. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z]{1,10});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

/*
 * The scanner. No regular expression runs over the feed or over a field: a hostile feed (a
 * description of 100 KB of '<') made the first, regex-based version quadratic.
 * Everything below moves forward with indexOf, and every search starts where the last one ended or
 * is remembered, so the cost is linear in the input.
 */

const CDATA_OPEN = '<![CDATA['
const CDATA_CLOSE = ']]>'

const isNameEnd = (ch: string | undefined): boolean =>
  ch === undefined || ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'

/** Where `<tag …>` starts at or after `from`, outside CDATA and comments; -1 if nowhere. */
function nextOpen(s: string, tag: string, from: number): number {
  let pos = from
  for (;;) {
    const lt = s.indexOf('<', pos)
    if (lt < 0) return -1
    if (s.startsWith(CDATA_OPEN, lt)) {
      const e = s.indexOf(CDATA_CLOSE, lt + CDATA_OPEN.length)
      if (e < 0) return -1
      pos = e + CDATA_CLOSE.length
    } else if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4)
      if (e < 0) return -1
      pos = e + 3
    } else if (s.startsWith(tag, lt + 1) && isNameEnd(s[lt + 1 + tag.length])) {
      return lt
    } else {
      pos = lt + 1
    }
  }
}

/** Where `</tag>` starts at or after `from`, skipping CDATA sections; -1 if never closed. */
function nextClose(s: string, tag: string, from: number): number {
  const needle = `</${tag}`
  let pos = from
  let close = s.indexOf(needle, pos)
  let cdata = s.indexOf(CDATA_OPEN, pos)
  for (;;) {
    if (close < 0) return -1
    if (cdata < 0 || cdata > close) return close
    const e = s.indexOf(CDATA_CLOSE, cdata + CDATA_OPEN.length)
    if (e < 0) return -1
    pos = e + CDATA_CLOSE.length
    if (close < pos) close = s.indexOf(needle, pos)
    cdata = s.indexOf(CDATA_OPEN, pos)
  }
}

/** A field's raw content as text: CDATA sections verbatim, everything else entity-decoded. */
function cdataText(raw: string): string {
  let out = ''
  let at = 0
  for (;;) {
    const c = raw.indexOf(CDATA_OPEN, at)
    if (c < 0) break
    const e = raw.indexOf(CDATA_CLOSE, c + CDATA_OPEN.length)
    if (e < 0) break
    out += decodeEntities(raw.slice(at, c)) + raw.slice(c + CDATA_OPEN.length, e)
    at = e + CDATA_CLOSE.length
  }
  return out + decodeEntities(raw.slice(at))
}

type Field = 'title' | 'link' | 'pubDate' | 'description'

/** One field's raw content — the first `<name>` of the item, outside CDATA — or '' if absent. Four
 *  forward scans of the item per item; no generic walk over child elements, whose closing tags would
 *  each have to be searched for (a run of distinct unclosed elements made that quadratic). */
function fieldOf(block: string, name: Field): string {
  const open = nextOpen(block, name, 0)
  if (open < 0) return ''
  const gt = block.indexOf('>', open)
  if (gt < 0 || block[gt - 1] === '/') return ''
  const close = nextClose(block, name, gt + 1)
  return close < 0 ? '' : block.slice(gt + 1, close)
}

/** HTML to one line of text, in one forward pass: scripts and styles dropped whole, every other tag
 *  replaced by a space, entities decoded. A '<' that no '>' follows is kept as text. */
export function plainText(html: string): string {
  const lower = html.toLowerCase()
  let out = ''
  let pos = 0
  while (pos < html.length) {
    const lt = html.indexOf('<', pos)
    if (lt < 0) {
      out += html.slice(pos)
      break
    }
    out += html.slice(pos, lt)
    const gt = html.indexOf('>', lt + 1)
    if (gt < 0) {
      out += html.slice(lt) // a '<' that opens no tag ("<3") is text, as it was
      break
    }
    out += ' '
    const name = html
      .slice(lt + 1, Math.min(gt, lt + 8))
      .toLowerCase()
      .replace(/[^a-z].*$/s, '')
    if (name === 'script' || name === 'style') {
      const end = lower.indexOf(`</${name}`, gt + 1)
      if (end < 0) break
      const endGt = html.indexOf('>', end)
      if (endGt < 0) break
      pos = endGt + 1
    } else {
      pos = gt + 1
    }
  }
  return squash(decodeEntities(out))
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

function teaserOf(text: string): string {
  if (text.length <= TEASER_CHARS) return text
  const cut = text.slice(0, TEASER_CHARS)
  const space = cut.lastIndexOf(' ')
  return `${(space > TEASER_CHARS * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`
}

function httpsLink(raw: string): string | null {
  const s = raw.trim()
  if (s.length > 2048 || !/^https:\/\//i.test(s)) return null
  try {
    return new URL(s).href
  } catch {
    return null
  }
}

/**
 * RSS 2.0 → items. Items without a title or without an https link are dropped; an item without a
 * readable date is kept (date '') and sorts after every dated one. At most `MAX_SCANNED_ITEMS` are
 * looked at, at most `MAX_ITEMS` returned.
 */
export function parseRss(xml: string): NewsItem[] {
  const found: Array<NewsItem & { t: number; n: number }> = []
  let pos = 0
  let n = 0
  while (n < MAX_SCANNED_ITEMS) {
    const open = nextOpen(xml, 'item', pos)
    if (open < 0) break
    const gt = xml.indexOf('>', open)
    if (gt < 0) break
    const close = xml[gt - 1] === '/' ? gt : nextClose(xml, 'item', gt + 1)
    if (close < 0) break
    pos = close + 1
    n++
    const block = xml.slice(gt + 1, close)
    const title = plainText(cdataText(fieldOf(block, 'title')).slice(0, 1000))
    const link = httpsLink(plainText(cdataText(fieldOf(block, 'link')).slice(0, 4096)))
    if (!title || !link) continue
    const t = Date.parse(squash(cdataText(fieldOf(block, 'pubDate')).slice(0, 200)))
    found.push({
      title,
      link,
      date: Number.isFinite(t) ? new Date(t).toISOString() : '',
      teaser: teaserOf(plainText(cdataText(fieldOf(block, 'description')).slice(0, MAX_DESCRIPTION_CHARS))),
      t: Number.isFinite(t) ? t : -Infinity,
      n
    })
  }
  found.sort((a, b) => (b.t === a.t ? a.n - b.n : b.t - a.t))
  return found.slice(0, MAX_ITEMS).map(({ title, link, date, teaser }) => ({ title, link, date, teaser }))
}

export interface FetchNewsDeps {
  fetchImpl?: typeof fetch
}

/** The sentence the renderer may show. Deliberately no URL, status line or header in it. */
const UNREACHABLE = `${NEWS_SOURCE_LABEL} could not be reached.`
const UNREADABLE = `The news from ${NEWS_SOURCE_LABEL} could not be read.`

/** Read the feed and parse it. Throws a short, user-facing sentence on any failure. */
export async function fetchNewsFeed(deps: FetchNewsDeps = {}): Promise<NewsFeed> {
  let xml: string
  try {
    const { data } = await fetchJson<unknown>(
      NEWS_FEED_URL,
      { method: 'GET', headers: { Accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' } },
      { timeoutMs: 15_000, fetchImpl: deps.fetchImpl, maxBytes: MAX_FEED_BYTES }
    )
    if (typeof data !== 'string') throw new Error('not a feed')
    xml = data
  } catch (err) {
    throw new Error(err instanceof DistanceHttpError && err.code === 'too_large' ? UNREADABLE : UNREACHABLE)
  }
  if (!/<rss[\s>]/i.test(xml) && !/<channel[\s>]/i.test(xml)) throw new Error(UNREADABLE)
  return { items: parseRss(xml), source: NEWS_SOURCE_LABEL, fetchedAt: new Date().toISOString() }
}
