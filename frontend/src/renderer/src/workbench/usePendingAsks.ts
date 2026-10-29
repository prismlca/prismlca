import { useEffect, useState } from 'react'
import { aiPendingAsks, onAiEvent, type PendingAsk } from '../lib/ai'

/**
 * The questions the assistant is waiting on, kept current from main's record.
 *
 * Lives in the Workbench rather than the chat panel because the panel is not there when it matters:
 * it is mounted only on the Model view, and it filters to the chat on screen. A question asked while
 * the user is in another model, on Results, or with the chat collapsed reaches this hook, and the
 * Workbench turns every open question that is not on screen into a banner with a way to the chat.
 *
 * Loaded once from `ai:pendingAsks` (a window reload must not lose the banner while the run still
 * waits), then kept by the `ask` / `ask-settled` events. `done` and `error` for the chat clear it
 * too, belt and braces: a run that ends has no question left to answer.
 */
export function usePendingAsks(): PendingAsk[] {
  const [asks, setAsks] = useState<PendingAsk[]>([])
  useEffect(() => {
    let alive = true
    void aiPendingAsks()
      .then((list) => {
        if (alive) setAsks(list)
      })
      .catch(() => {})
    const off = onAiEvent((ev) => {
      if (ev.type === 'ask') {
        setAsks((prev) => [...prev.filter((a) => a.reqId !== ev.ask.reqId), ev.ask])
      } else if (ev.type === 'ask-settled') {
        setAsks((prev) => prev.filter((a) => a.reqId !== ev.reqId))
      } else if (ev.type === 'done' || ev.type === 'error') {
        setAsks((prev) =>
          prev.some((a) => a.chatId === ev.chatId) ? prev.filter((a) => a.chatId !== ev.chatId) : prev
        )
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return asks
}
