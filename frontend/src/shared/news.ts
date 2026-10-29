/**
 * The project news on the start page: where it comes from and what one item looks like.
 *
 * Fetched in the MAIN process, never in the renderer: the renderer's CSP allows no remote origin,
 * and the page that shows the news should not be the one that talks to the internet. Main hands
 * over plain text only (title, teaser, link) — no HTML from the feed ever reaches the DOM.
 */

/**
 * The RSS 2.0 feed the start page reads — written by `Website2/tools/build_news.py` and served with the
 * site. Read live, even before the site itself is up: until the feed is deployed the
 * card says the source could not be reached, which is the truth. The placeholder copy the app used to
 * ship is gone, so nothing on the card can claim to come from prismlca.com without having come from there.
 */
export const NEWS_FEED_URL = 'https://www.prismlca.com/feed.xml'

/** What the user reads the news "from" — the only name the UI ever gives the source. */
export const NEWS_SOURCE_LABEL = 'prismlca.com'

export interface NewsItem {
  title: string
  /** Always https — anything else is dropped by the parser. */
  link: string
  /** ISO timestamp, or '' when the feed gave no (readable) date. */
  date: string
  /** Plain text, no markup, at most ~200 characters. */
  teaser: string
}

export interface NewsFeed {
  items: NewsItem[]
  source: typeof NEWS_SOURCE_LABEL
  fetchedAt: string
}
