/**
 * The news parser's promises to the renderer: plain text only, https links only, newest first,
 * capped — and the website's own feed is one it can read.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeEntities,
  fetchNewsFeed,
  MAX_FEED_BYTES,
  MAX_ITEMS,
  parseRss,
  plainText,
  TEASER_CHARS
} from './feed'

const item = (fields: Record<string, string>): string =>
  `<item>${Object.entries(fields)
    .map(([k, v]) => `<${k}>${v}</${k}>`)
    .join('')}</item>`

const rss = (...items: string[]): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items.join('\n')}</channel></rss>`

describe('parseRss', () => {
  it('reads CDATA verbatim and decodes entities outside it', () => {
    const [a] = parseRss(
      rss(
        item({
          title: '<![CDATA[Fish & Chips <3]]>',
          link: 'https://prismlca.com/a?x=1&amp;y=2',
          pubDate: 'Thu, 24 Sep 2026 09:00:00 GMT',
          description: 'Caf&#233; &#x2014; &quot;quoted&quot; &amp; &#39;single&#39; &lt;tag&gt;'
        })
      )
    )
    expect(a.title).toBe('Fish & Chips <3')
    expect(a.link).toBe('https://prismlca.com/a?x=1&y=2')
    expect(a.date).toBe('2026-09-24T09:00:00.000Z')
    // `&lt;tag&gt;` is escaped HTML in the description — markup, and stripped with the rest.
    expect(a.teaser).toBe('Café — "quoted" & \'single\'')
  })

  it('turns HTML in a description into one plain line', () => {
    const [a] = parseRss(
      rss(
        item({
          title: 'T',
          link: 'https://prismlca.com/b',
          description:
            '<![CDATA[<p>New <b>start</b> page</p>\n<script>alert(1)</script><ul><li>fast&nbsp;import</li></ul>]]>'
        })
      )
    )
    expect(a.teaser).toBe('New start page fast import')
    expect(a.teaser).not.toMatch(/[<>]|alert/)
  })

  it('shortens a long teaser on a word and marks the cut', () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')
    const [a] = parseRss(rss(item({ title: 'T', link: 'https://prismlca.com/c', description: long })))
    expect(a.teaser.length).toBeLessThanOrEqual(TEASER_CHARS + 1)
    expect(a.teaser.endsWith('…')).toBe(true)
    expect(a.teaser).toMatch(/word\d+…$/)
  })

  it('drops items without an https link or without a title', () => {
    const got = parseRss(
      rss(
        item({ title: 'plain http', link: 'http://prismlca.com/x' }),
        item({ title: 'script', link: 'javascript:alert(1)' }),
        item({ title: 'no link' }),
        item({ title: '', link: 'https://prismlca.com/untitled' }),
        item({ title: 'kept', link: 'https://prismlca.com/kept' })
      )
    )
    expect(got.map((i) => i.title)).toEqual(['kept'])
  })

  it('orders newest first and puts undated items last, in feed order', () => {
    const got = parseRss(
      rss(
        item({ title: 'undated 1', link: 'https://p.com/u1' }),
        item({ title: 'old', link: 'https://p.com/o', pubDate: 'Wed, 12 Aug 2026 09:00:00 GMT' }),
        item({ title: 'undated 2', link: 'https://p.com/u2', pubDate: 'not a date' }),
        item({ title: 'new', link: 'https://p.com/n', pubDate: 'Thu, 24 Sep 2026 09:00:00 GMT' })
      )
    )
    expect(got.map((i) => i.title)).toEqual(['new', 'old', 'undated 1', 'undated 2'])
    expect(got[2].date).toBe('')
  })

  it('caps the list', () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      item({
        title: `n${i}`,
        link: `https://p.com/${i}`,
        pubDate: new Date(Date.UTC(2026, 0, i + 1)).toUTCString()
      })
    )
    const got = parseRss(rss(...many))
    expect(got).toHaveLength(MAX_ITEMS)
    expect(got[0].title).toBe('n14')
  })

  it('decodes in one pass and leaves unknown entities alone', () => {
    expect(decodeEntities('&amp;lt; &bogus; &#0; &#128512;')).toBe('&lt; &bogus; &#0; 😀')
    expect(plainText('<p>a</p><p>b</p>')).toBe('a b')
  })
})

// The website lives in its own repository; checked out next to the code as Website2/, its feed is tested here.
const SITE_FEED = resolve(__dirname, '../../../../Website2/feed.xml')

describe('fetchNewsFeed', () => {
  it.skipIf(!existsSync(SITE_FEED))(
    'reads the website’s own feed.xml (built from Website2/content/news.html): newest first',
    async () => {
      // The file the server delivers, through the same path a live answer takes — so a change to the
      // website's feed that the app could not read fails here, not on the start page.
      const xml = readFileSync(SITE_FEED, 'utf8')
      const fetchImpl = (async () => new Response(xml, { status: 200 })) as unknown as typeof fetch
      const feed = await fetchNewsFeed({ fetchImpl })
      expect(feed.source).toBe('prismlca.com')
      expect(feed.items.length).toBeGreaterThanOrEqual(3)
      expect(feed.items.length).toBeLessThanOrEqual(MAX_ITEMS)
      const dates = feed.items.map((i) => i.date)
      expect([...dates].sort().reverse()).toEqual(dates)
      for (const i of feed.items) {
        expect(i.link.startsWith('https://www.prismlca.com/news.html#')).toBe(true)
        expect(i.teaser).not.toMatch(/[<>]/)
        expect(i.title).not.toMatch(/&amp;/)
      }
    }
  )

  it('reads the remote feed as text', async () => {
    const body = rss(
      item({ title: 'Remote', link: 'https://prismlca.com/r', pubDate: 'Thu, 24 Sep 2026 09:00:00 GMT' })
    )
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch
    const feed = await fetchNewsFeed({ fetchImpl })
    expect(feed.items.map((i) => i.title)).toEqual(['Remote'])
  })

  it('says only that prismlca.com could not be reached when the request fails', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(fetchNewsFeed({ fetchImpl })).rejects.toThrow(/^prismlca\.com could not be reached\.$/)
  })

  it('refuses a body that is not a feed', async () => {
    const fetchImpl = (async () =>
      new Response('<html>hi</html>', { status: 200 })) as unknown as typeof fetch
    await expect(fetchNewsFeed({ fetchImpl })).rejects.toThrow(/could not be read/)
  })
})

/**
 * A hostile feed must not stall main: the first, regex-based parser went quadratic on a description
 * full of '<' (890 ms at 40 KB, seconds beyond). The bound is generous for CI; the
 * measured times are printed.
 */
describe('hostile input', () => {
  const timed = <T>(label: string, fn: () => T): { value: T; ms: number } => {
    const t0 = performance.now()
    const value = fn()
    const ms = performance.now() - t0
    console.log(`[feed timing] ${label}: ${ms.toFixed(1)} ms`)
    return { value, ms }
  }

  it('parses a 200 KB CDATA description full of "<" in linear time', () => {
    const lts = '<'.repeat(200 * 1024)
    const xml = rss(item({ title: 'T', link: 'https://p.com/x', description: `<![CDATA[${lts}]]>` }))
    const { value, ms } = timed('200 KB of < in CDATA', () => parseRss(xml))
    expect(ms).toBeLessThan(1000)
    expect(value).toHaveLength(1)
    expect(value[0].title).toBe('T')
  })

  it('parses a 200 KB raw description of "<" and "<x>" runs in linear time', () => {
    const junk = '<'.repeat(100 * 1024) + '<x>'.repeat(30 * 1024) + '&aaaaaaaaaaaaaaaaaaaa'.repeat(1000)
    const xml = rss(item({ title: 'T', link: 'https://p.com/x', description: junk }))
    const { value, ms } = timed('raw < / <x> / & runs', () => parseRss(xml))
    expect(ms).toBeLessThan(1000)
    expect(value).toHaveLength(1)
    expect(value[0].teaser.length).toBeLessThanOrEqual(TEASER_CHARS + 1)
  })

  it('reads the first items of a feed with 10 000 and stops', () => {
    const many = Array.from({ length: 10_000 }, (_, i) =>
      item({ title: `n${i}`, link: `https://p.com/${i}`, description: '<![CDATA[<p>x</p>]]>' })
    )
    const xml = rss(...many)
    const { value, ms } = timed('10 000 items', () => parseRss(xml))
    expect(ms).toBeLessThan(1000)
    expect(value).toHaveLength(MAX_ITEMS)
    expect(value[0].title).toBe('n0')
  })

  it('skips an <item> written inside a CDATA section', () => {
    const got = parseRss(
      rss(
        item({
          title: 'real',
          link: 'https://p.com/r',
          description: '<![CDATA[<item><title>fake</title><link>https://p.com/f</link></item>]]>'
        })
      )
    )
    expect(got.map((i) => i.title)).toEqual(['real'])
  })

  it('refuses a body over the byte limit, by its Content-Length and while it streams', async () => {
    const big = rss(item({ title: 'T', link: 'https://p.com/x', description: 'a'.repeat(MAX_FEED_BYTES) }))
    const declared = (async () =>
      new Response(big, {
        status: 200,
        headers: { 'content-length': String(big.length) }
      })) as unknown as typeof fetch
    await expect(fetchNewsFeed({ fetchImpl: declared })).rejects.toThrow(
      /^The news from prismlca\.com could not be read\.$/
    )
    let pulled = 0
    const streamed = (async () =>
      new Response(
        new ReadableStream({
          pull(ctrl) {
            pulled++
            ctrl.enqueue(new TextEncoder().encode('<'.repeat(64 * 1024)))
          }
        }),
        { status: 200 }
      )) as unknown as typeof fetch
    await expect(fetchNewsFeed({ fetchImpl: streamed })).rejects.toThrow(/could not be read/)
    // Stopped just past the limit, and asked once — too large is not retried.
    expect(pulled).toBeLessThan(MAX_FEED_BYTES / (64 * 1024) + 4)
  })
})
