/**
 * One line per chat that finished or failed out of sight (V406) — see lib/chatNotices.ts. Shown on
 * every view, above the content, because the chat itself exists only under Model.
 */
import { useEffect } from 'react'
import { onAiEvent } from '../lib/ai'
import { dismissChatNotice, handleChatEvent, useChatNotices, type ChatNotice } from '../lib/chatNotices'

export default function ChatElsewhereBanner({
  onOpen
}: {
  /** Switch to the notice's model, the Model view and its chat; the row is dismissed by the banner. */
  onOpen: (notice: ChatNotice & { database: string }) => void
}): JSX.Element | null {
  // The feed lives here, not in the chat panel: the panel is unmounted on every view but Model.
  useEffect(() => onAiEvent(handleChatEvent), [])
  const notices = useChatNotices()
  if (!notices.length) return null
  return (
    <div className="chat-elsewhere" role="status" aria-live="polite">
      {notices.map((n) => {
        const where = n.database ? ` in “${n.database}”` : ' in another chat'
        const head = n.kind === 'done' ? `Assistant finished${where}` : `Assistant failed${where}`
        const database = n.database
        return (
          <div key={n.chatId} className={`chat-elsewhere-row${n.kind === 'error' ? ' err' : ''}`}>
            <span title={n.excerpt || undefined}>
              <b>{head}</b>
              {n.excerpt ? ` — ${n.excerpt}` : ''}
            </span>
            {database ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  dismissChatNotice(n.chatId)
                  onOpen({ ...n, database })
                }}
              >
                Open
              </button>
            ) : null}
            <button
              type="button"
              className="chat-elsewhere-x"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => dismissChatNotice(n.chatId)}
            >
              ✕
            </button>
          </div>
        )
      })}
    </div>
  )
}
