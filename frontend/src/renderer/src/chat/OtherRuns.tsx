import { useState } from 'react'
import { listChats } from '../lib/ai'

/** A run in flight in a chat other than the one on screen. `database` is null for the model on screen. */
export interface OtherRun {
  chatId: string
  database: string | null
  /** The chat's title when the panel knows it (this model's chats); other models' titles are fetched. */
  title?: string
}

const runLabel = (run: OtherRun, titles: Record<string, string>): string => {
  const title = run.title || titles[run.chatId] || 'Untitled chat'
  return run.database ? `${run.database} · ${title}` : title
}

/**
 * The chat header's "1 other run": the one place the user is told that an assistant they started
 * elsewhere is still going — and the way there. One run opens on click; several open a list first,
 * because two chats in the same model would otherwise be one name twice. Opening a chat in another
 * model switches the model too (`onOpen` decides how).
 */
export default function OtherRuns({
  runs,
  onOpen
}: {
  runs: OtherRun[]
  onOpen: (run: OtherRun) => void
}): JSX.Element | null {
  const [listing, setListing] = useState(false)
  // Titles of chats in other models, read when the list opens: the panel only holds its own model's.
  const [titles, setTitles] = useState<Record<string, string>>({})
  if (!runs.length) return null
  const places = runs.map((r) => (r.database ? `“${r.database}”` : 'another chat here'))
  const where = [...new Set(places)].join(', ')
  const open = (): void => {
    if (runs.length === 1) {
      onOpen(runs[0])
      return
    }
    setListing(!listing)
    if (listing) return
    const models = [...new Set(runs.flatMap((r) => (r.database && !r.title ? [r.database] : [])))]
    for (const db of models)
      void listChats(db)
        .then((r) => setTitles((t) => ({ ...t, ...Object.fromEntries(r.chats.map((c) => [c.id, c.title])) })))
        .catch(() => {})
  }
  return (
    <>
      <button
        type="button"
        className="chat-head-elsewhere"
        onClick={open}
        title={`The assistant is still working in ${where}. ${runs.length === 1 ? 'Open that chat' : 'Choose a chat'} to follow it.`}
      >
        <span className="chat-trace-pulse" aria-hidden />
        {runs.length === 1 ? '1 other run' : `${runs.length} other runs`}
      </button>
      {listing && runs.length > 1 ? (
        <div className="chat-list" onMouseLeave={() => setListing(false)}>
          {runs.map((r) => (
            <div key={r.chatId} className="chat-list-item">
              <button
                type="button"
                className="chat-list-open"
                onClick={() => {
                  setListing(false)
                  onOpen(r)
                }}
              >
                {runLabel(r, titles)}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}
