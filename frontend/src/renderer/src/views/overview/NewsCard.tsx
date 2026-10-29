/**
 * "Latest news" — the project news from prismlca.com, and the way to the Substack.
 *
 * The one rule this card is built around: **nothing is fetched from the internet unless the user
 * allowed it.** Allowed means either the `newsAutoLoad` setting (Settings → General, or the tour's
 * last card), which loads once per app session, or a click on the card's own button, which loads
 * once for this session and changes no setting. The fetch itself happens in main (`news:fetch`);
 * this side only decides whether to ask, and shows plain text — never markup from the feed.
 *
 * The session state lives in module scope, like the Overview's open folders: the Overview unmounts
 * whenever you go to a model and back, and coming back must not fetch again.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { useAppSettings } from '../../lib/appSettings'
import { NEWS_URL, SUBSTACK_URL, openLink } from '../../lib/links'
import { fmtDay } from '../../lib/format'
import { ipcErrorReason } from '../../../../shared/ipc'
import { NEWS_SOURCE_LABEL, type NewsFeed } from '../../../../shared/news'
import { ChevronIcon, ExternalLinkIcon, MailIcon, NewsIcon } from '../../components/icons'

/** Rows the card shows; main sends up to ten. Three, not five: with five the start page needed a
 *  scrollbar on a 1920×1080 screen — the page is meant to fit without one. */
export const NEWS_SHOWN = 3

type NewsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; feed: NewsFeed }

let session: NewsState = { status: 'idle' }
const subscribers = new Set<() => void>()

function publish(next: NewsState): void {
  session = next
  for (const fn of subscribers) fn()
}

const subscribe = (fn: () => void): (() => void) => {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}
const getSession = (): NewsState => session

const UNREACHABLE = `${NEWS_SOURCE_LABEL} could not be reached.`

/** Ask main for the feed — once: a second call while loading, or after it loaded, does nothing. */
export function loadNews(): void {
  if (session.status === 'loading' || session.status === 'loaded') return
  publish({ status: 'loading' })
  window.prism.news
    .fetch()
    .then((feed) => publish({ status: 'loaded', feed }))
    .catch((e) => publish({ status: 'error', message: ipcErrorReason(e, UNREACHABLE) }))
}

/** Test seam: forget this session's feed, as a restart would. */
export function resetNewsSession(): void {
  session = { status: 'idle' }
}

export default function NewsCard(): JSX.Element {
  const state = useSyncExternalStore(subscribe, getSession, getSession)
  const { newsAutoLoad } = useAppSettings()

  // Only on an explicit true: the store's pre-answer seed reads false, so nothing goes out before
  // main has said what the user chose.
  useEffect(() => {
    if (newsAutoLoad === true && getSession().status === 'idle') loadNews()
  }, [newsAutoLoad])

  return (
    <section className="ov-card" aria-label="Latest news">
      <div className="ov-card-h">
        <div className="ov-box-icon">
          <NewsIcon />
        </div>
        <div className="ov-card-title">
          <h2>Latest news</h2>
          <p>Stay informed about PrismLCA &amp; AI.</p>
        </div>
        <button
          className="btn sm ico-label"
          onClick={() => openLink(NEWS_URL)}
          title="Open the news page in your browser"
        >
          <ExternalLinkIcon /> Open in browser
        </button>
      </div>

      <div className="ov-newsfeed">
        {state.status === 'idle' ? (
          <div className="ov-newsfeed-ask">
            <button className="btn ico-label" onClick={loadNews}>
              <NewsIcon /> Load news from {NEWS_SOURCE_LABEL}
            </button>
            <p>
              Nothing is loaded until you click. To load the news at every start, switch it on under Settings
              → General.
            </p>
          </div>
        ) : null}
        {state.status === 'loading' ? (
          <div className="ov-card-empty" role="status">
            Loading news from {NEWS_SOURCE_LABEL}…
          </div>
        ) : null}
        {state.status === 'error' ? (
          <div className="ov-newsfeed-ask" role="alert">
            <p className="ov-newsfeed-err">{state.message}</p>
            <button className="btn sm" onClick={loadNews}>
              Try again
            </button>
          </div>
        ) : null}
        {state.status === 'loaded' && state.feed.items.length === 0 ? (
          <div className="ov-card-empty">No news on {NEWS_SOURCE_LABEL} yet.</div>
        ) : null}
        {state.status === 'loaded'
          ? state.feed.items.slice(0, NEWS_SHOWN).map((item) => (
              <button
                key={item.link}
                className="ov-newsfeed-row"
                onClick={() => openLink(item.link)}
                title="Open this article in your browser"
              >
                <span className="ov-newsfeed-date">{fmtDay(item.date)}</span>
                <span className="ov-newsfeed-text">
                  <span className="ov-newsfeed-title">{item.title}</span>
                  {item.teaser ? <span className="ov-newsfeed-teaser">{item.teaser}</span> : null}
                </span>
                <ChevronIcon />
              </button>
            ))
          : null}
      </div>

      {/* A link, not an address field: the Substack profile has no way to take an e-mail address from
          us, so a field here would only mean typing it twice. */}
      <div className="ov-substack">
        <div className="ov-box-icon substack">
          <MailIcon />
        </div>
        <div className="ov-substack-text">
          <div className="ov-substack-title">Get more with our Substack</div>
          <div className="ov-substack-sub">Product updates and AI insights.</div>
        </div>
        <button
          className="btn sm ico-label"
          onClick={() => openLink(SUBSTACK_URL)}
          title="Open the Substack page in your browser"
        >
          <ExternalLinkIcon /> Subscribe
        </button>
      </div>
    </section>
  )
}
