import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AttachmentMeta, ChatMessage } from '../lib/ai'
import { ArrowUpRightIcon, FolderIcon, PaperclipIcon } from '../components/icons'
import { ToolTraceList } from './ToolTraceList'
import { attachExtent } from './chatFormat'

/**
 * One finished message of the transcript.
 *
 * Lifted out of `messages.map` and memoised (11.09.2026). Every render of the panel used to rebuild
 * the whole conversation — and with it re-parse every message's Markdown, see `Markdown` below. The
 * panel renders for reasons that have nothing to do with the history: a tool label arriving, the
 * bottom-of-transcript flag flipping as you scroll, the Workbench above re-rendering. None of those
 * change a message that was written ten minutes ago.
 *
 * This only works because every `setMessages` call appends with `[...m, next]`, so the objects of
 * older messages keep their identity. A future call that rebuilds the array element by element would
 * silently switch this memo off again — if you touch `setMessages`, keep the spread.
 */
export const MessageRow = memo(function MessageRow({
  m,
  labels,
  onJump,
  onReveal
}: {
  m: ChatMessage
  labels: Record<string, string>
  onJump: (code: string) => void
  onReveal: (a: AttachmentMeta, inFolder: boolean) => void
}): JSX.Element {
  return (
    <div className={`chat-msg ${m.role}`}>
      {m.tools?.length ? (
        <ToolTraceList traces={m.tools} labels={labels} summary cost={m.cost} provider={m.provider} />
      ) : null}
      {m.role === 'assistant' ? <Markdown text={m.content} onJump={onJump} /> : m.content}
      {/* The files that travelled with this turn. They are content parts beside the prose, so they
          leave no trace in `content` — without this row a reloaded chat looks as if nothing had been
          attached at all. */}
      {m.attachments?.length ? (
        <div className="chat-attach-list sent">
          {m.attachments.map((a, j) => (
            <span key={a.id || `${a.name}-${j}`} className="chat-attach sent">
              <button
                className="chat-attach-open"
                title={`Open ${a.name} (${attachExtent(a)}) from the workspace's sources`}
                onClick={() => onReveal(a, false)}
              >
                <PaperclipIcon />
                <span className="chat-attach-name">{a.name}</span>
                <span className="chat-attach-note">{attachExtent(a)}</span>
              </button>
              <button
                className="chat-attach-x"
                title="Show this file in the workspace's sources folder"
                onClick={() => onReveal(a, true)}
              >
                <FolderIcon />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
})

/** Module-level, so the array identity never changes. It used to be a literal in the JSX below,
 *  which handed `ReactMarkdown` a new array on every single render. */
const REMARK_PLUGINS = [remarkGfm]

/**
 * Let our own `prism:process/<code>` links through, and keep react-markdown's filter for everything
 * else.
 *
 * Without this the jump-to-canvas links never worked at all: `defaultUrlTransform` allows only
 * http(s), irc(s), mailto and xmpp and returns '' for anything else, so every `prism:` link reached
 * the `a` component below with an EMPTY href — the `startsWith('prism:process/')` branch was dead
 * code, and the model's process references rendered as ordinary links that did nothing when clicked.
 * Found on 11.09.2026 by the first test ever written for this row; nothing on screen said so,
 * because a link that does nothing looks exactly like a link you have not clicked yet.
 *
 * Only this one prefix is exempted, and it ends in a span that calls `jumpToProcess` — the filter is
 * there to stop `javascript:` URLs, and it still does.
 */
const urlTransform = (url: string): string =>
  url.startsWith('prism:process/') ? url : defaultUrlTransform(url)

/**
 * The process name with the arrow glued to its last word, so the arrow never opens a line on its own.
 * Only a plain-text name can be cut; one with markup inside (code, emphasis) keeps its children whole
 * and the arrow simply follows.
 */
function withTrailingArrow(children: ReactNode): ReactNode {
  const text =
    typeof children === 'string'
      ? children
      : Array.isArray(children) && children.length === 1 && typeof children[0] === 'string'
        ? children[0]
        : null
  if (text === null)
    return (
      <>
        {children}
        <span className="chat-proclink-tail">
          <ArrowUpRightIcon />
        </span>
      </>
    )
  const cut = text.lastIndexOf(' ', text.trimEnd().length - 1) + 1
  return (
    <>
      {text.slice(0, cut)}
      <span className="chat-proclink-tail">
        {text.slice(cut)}
        <ArrowUpRightIcon />
      </span>
    </>
  )
}

/**
 * Render assistant Markdown; `prism:process/<code>` links become clickable jumps to the canvas.
 *
 * Memoised, and that is not a micro-optimisation: react-markdown 10 has NO cache. Its body is
 * `createProcessor(options)` → `parse` → `runSync` → build React elements, all synchronous, on every
 * invocation (node_modules/react-markdown/lib/index.js:175). Un-memoised, one render of the panel
 * re-parsed the Markdown of every message in the conversation — forty messages meant forty full
 * parser runs, and the frame that landed in is the hitch a reader feels while scrolling
 * (11.09.2026). `text` is a string and `onJump` is stable (see `jump` in CanvasChat), so the default
 * shallow compare is all this needs.
 */
export const Markdown = memo(function Markdown({
  text,
  onJump
}: {
  text: string
  onJump: (code: string) => void
}): JSX.Element {
  // Rebuilt only when the handler changes, i.e. never — a fresh map here would defeat the memo above
  // by handing ReactMarkdown new component functions on every render.
  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: ReactNode }) => {
        const h = href ?? ''
        if (h.startsWith('prism:process/')) {
          // Guarded, because the text being decoded is written by a MODEL. `decodeURIComponent`
          // throws URIError on a broken escape ('%E9' is not valid UTF-8), and there is no error
          // boundary around the panel — one such link in an answer would take the whole workbench
          // down, and again on every reopen, because chats are persisted and replayed. Until
          // 11.09.2026 this branch was unreachable (see `urlTransform` above), which is why the hole
          // had never opened. A name we cannot read is shown as the plain words the model wrote:
          // nothing to click, and the rest of the answer still readable.
          let code: string | null = null
          try {
            code = decodeURIComponent(h.slice('prism:process/'.length))
          } catch {
            code = null
          }
          if (code === null) return <>{children}</>
          const target = code
          // A span with the button role rather than a <button> (which lays out as an inline block, so
          // a long name could not wrap) or an <a href> (whose middle-click asks Electron for a new
          // window). Enter and Space are a button's keys, so they are wired by hand.
          return (
            <span
              className="chat-proclink"
              role="button"
              tabIndex={0}
              title="Show this process on the canvas"
              onClick={() => onJump(target)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                onJump(target)
              }}
            >
              {withTrailingArrow(children)}
            </span>
          )
        }
        return (
          <a
            href={h}
            onClick={(e) => {
              e.preventDefault()
              if (/^https?:\/\//.test(h)) void window.prism.openExternal(h)
            }}
          >
            {children}
          </a>
        )
      }
    }),
    [onJump]
  )
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  )
})
