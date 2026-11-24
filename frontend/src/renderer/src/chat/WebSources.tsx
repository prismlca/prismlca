import type { CitedPage, ToolTrace, WebFetch, WebSearch } from '../lib/ai'
import { hostOf, openable, webSourcesOf } from './turnSources'

/**
 * The provider's web lookups as a reader sees them: the pages an answer cites or opened under the answer,
 * and the searches behind it — what was searched for, which pages came back. Before, a turn that searched
 * four times said "4 web searches" and nothing else, and the provider's citations were thrown away.
 */

/** A page, by its title where the provider gave one, opened in the browser on a click. */
function PageLink({ page }: { page: { url: string; title?: string; excerpt?: string } }): JSX.Element {
  const host = hostOf(page.url)
  const label = page.title?.trim() || host
  // The passage the answer cites, on hover: the list stays one line per page.
  const hint = page.excerpt ? `“${page.excerpt}” — ${page.url}` : page.url
  return (
    <>
      {openable(page.url) ? (
        <a
          href={page.url}
          title={hint}
          onClick={(e) => {
            e.preventDefault()
            void window.prism.openExternal(page.url)
          }}
        >
          {label}
        </a>
      ) : (
        <span title={hint}>{label}</span>
      )}
      {label !== host ? <span className="chat-web-host"> · {host}</span> : null}
    </>
  )
}

/** Each search with what it looked for and the pages that came back. */
export function WebSearchList({ searches }: { searches: WebSearch[] }): JSX.Element {
  return (
    <div className="chat-web">
      {searches.map((s, i) => (
        <div key={i} className="chat-web-search">
          <div className="chat-web-query">{s.query ? `“${s.query}”` : 'Search text not reported'}</div>
          {!s.results ? (
            <div className="chat-web-none">The provider does not report the pages it found.</div>
          ) : !s.results.length ? (
            <div className="chat-web-none">No pages{s.error ? ` (${s.error})` : ''}</div>
          ) : (
            <ul className="chat-web-results">
              {s.results.map((r, j) => (
                <li key={j}>
                  <PageLink page={r} />
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

/** The cited pages of a web lookups trace row, as the expanded row lists them. */
export function CitedList({ cited }: { cited: CitedPage[] }): JSX.Element {
  return (
    <ol className="chat-sources-list">
      {cited.map((c) => (
        <li key={c.url}>
          <PageLink page={c} />
        </li>
      ))}
    </ol>
  )
}

/** The pages a reply opened, each with the provider's reason where it could not be opened. */
export function OpenedList({ fetched }: { fetched: WebFetch[] }): JSX.Element {
  return (
    <ol className="chat-sources-list">
      {fetched.map((f, i) => (
        <li key={i}>
          <PageLink page={f} />
          {f.error ? <span className="chat-web-host"> · not opened ({f.error})</span> : null}
        </li>
      ))}
    </ol>
  )
}

/**
 * Under a finished answer: the pages it cites, the pages it opened that it does not cite, and the
 * searches behind them behind one line. Read from the turn's trace, which is stored with the answer.
 * Nothing when the turn did not search or open a page.
 */
export function AnswerSources({ traces }: { traces?: ToolTrace[] }): JSX.Element | null {
  const { cited, opened, searches } = webSourcesOf(traces)
  const citedUrls = new Set(cited.map((c) => c.url))
  const read = opened.filter((o) => !citedUrls.has(o.url))
  if (!cited.length && !read.length && !searches.length) return null
  const pages = new Set(searches.flatMap((s) => (s.results ?? []).map((r) => r.url))).size
  return (
    <div className="chat-sources">
      {cited.length ? (
        <>
          <div className="chat-sources-h">Sources</div>
          <CitedList cited={cited} />
        </>
      ) : null}
      {read.length ? (
        <>
          <div className="chat-sources-h">Pages opened</div>
          <OpenedList fetched={read} />
        </>
      ) : null}
      {searches.length ? (
        <details className="chat-sources-searches">
          <summary>
            {searches.length} web {searches.length === 1 ? 'search' : 'searches'}
            {pages ? ` · ${pages} ${pages === 1 ? 'page' : 'pages'} found` : ''}
          </summary>
          <WebSearchList searches={searches} />
        </details>
      ) : null}
    </div>
  )
}
