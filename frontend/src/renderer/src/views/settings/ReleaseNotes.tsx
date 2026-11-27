import type { ReactNode } from 'react'
import type { NoteBlock, NoteSpan, ReleaseNotes as Notes } from '../../../../shared/updates'
import { openLink } from '../../lib/links'

/**
 * A newer version's release notes, under "What is new in …" on the About page. Main has read them from the
 * release feed into blocks (main/releaseNotes.ts); this builds the elements, so the feed's HTML never
 * reaches the window. Headings are h5 because the page's h4 is its sticky section head. Links open in the
 * browser like every other link in the app.
 */
export function ReleaseNotes({ notes, releaseUrl }: { notes: Notes; releaseUrl: string }): JSX.Element {
  return (
    <div className="release-notes">
      <Blocks blocks={notes.blocks} />
      {notes.cut ? (
        <p className="release-notes-cut">
          Shortened here — the full notes are on the{' '}
          <button type="button" className="link-btn" onClick={() => openLink(releaseUrl)}>
            release page
          </button>
          .
        </p>
      ) : null}
    </div>
  )
}

function Blocks({ blocks }: { blocks: NoteBlock[] }): JSX.Element {
  return (
    <>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </>
  )
}

function Block({ block }: { block: NoteBlock }): JSX.Element {
  if (block.kind === 'heading')
    return (
      <h5>
        <Spans spans={block.spans} />
      </h5>
    )
  if (block.kind === 'paragraph')
    return (
      <p>
        <Spans spans={block.spans} />
      </p>
    )
  if (block.kind === 'code')
    return (
      <pre>
        <code>{block.text}</code>
      </pre>
    )
  const items = block.items.map((item, i) => (
    <li key={i}>
      <Blocks blocks={item} />
    </li>
  ))
  return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>
}

function Spans({ spans }: { spans: NoteSpan[] }): JSX.Element {
  return (
    <>
      {spans.map((s, i) => (
        <Span key={i} span={s} />
      ))}
    </>
  )
}

function Span({ span }: { span: NoteSpan }): JSX.Element {
  let el: ReactNode = span.text
  if (span.code) el = <code>{el}</code>
  if (span.em) el = <em>{el}</em>
  if (span.strong) el = <strong>{el}</strong>
  const href = span.href
  if (href)
    el = (
      <button type="button" className="link-btn" title={`Open ${href}`} onClick={() => openLink(href)}>
        {el}
      </button>
    )
  return <>{el}</>
}
