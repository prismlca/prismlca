import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatPlan, ChatRun } from '../../../shared/plan'
import { onAiEvent } from '../lib/ai'

/** What the plan card knows about one chat. `open` is the card's visibility — renderer state, never
 *  persisted. */
export interface PlanEntry {
  plan: ChatPlan | null
  run: ChatRun | null
  open: boolean
}

/**
 * The plan and run state of every chat this panel has seen, keyed by chat id.
 *
 * Keyed rather than "the shown chat's": a run keeps going in a chat that is not on screen (another
 * model, another chat), and its plan events must land in that chat's entry, not in whichever chat
 * happens to be shown when they arrive. Switching back then shows the latest state without a race
 * between the chat GET and the event stream.
 *
 * The open rule: a NEW plan opens the card — the first revision, a plan after none, or a plan
 * under a different title. An update leaves the card as the user left it, so a collapse holds until
 * the next new plan. A chat loaded with a plan already in it starts collapsed (the pill shows it).
 * `suppressOpen` keeps a plan from opening by itself: a frozen plan (the model has no plan tool), and
 * any plan while the card would have to cover the transcript (no room beside the dock).
 */
export function usePlanState(suppressOpen: boolean): {
  entries: Record<string, PlanEntry>
  seed: (id: string, plan: ChatPlan | null | undefined, run: ChatRun | null | undefined) => void
  setOpen: (id: string, open: boolean) => void
} {
  const [entries, setEntries] = useState<Record<string, PlanEntry>>({})
  const suppressRef = useRef(suppressOpen)
  suppressRef.current = suppressOpen

  const seed = useCallback(
    (id: string, plan: ChatPlan | null | undefined, run: ChatRun | null | undefined) => {
      setEntries((s) => ({
        ...s,
        [id]: { plan: plan ?? null, run: run ?? null, open: (s[id]?.open ?? false) && !!plan }
      }))
    },
    []
  )

  const setOpen = useCallback((id: string, open: boolean) => {
    setEntries((s) => (s[id] ? { ...s, [id]: { ...s[id], open } } : s))
  }, [])

  useEffect(
    () =>
      onAiEvent((ev) => {
        if (ev.type === 'plan') {
          setEntries((s) => {
            const prev = s[ev.chatId]
            const plan = ev.plan
            const isNew =
              !!plan &&
              (plan.revision === 1 ||
                (prev !== undefined && !prev.plan) ||
                (!!prev?.plan && prev.plan.title !== plan.title))
            const open = !!plan && (isNew ? !suppressRef.current : (prev?.open ?? false))
            return { ...s, [ev.chatId]: { plan, run: prev?.run ?? null, open } }
          })
        } else if (ev.type === 'run') {
          setEntries((s) => {
            const prev = s[ev.chatId]
            return {
              ...s,
              [ev.chatId]: { plan: prev?.plan ?? null, open: prev?.open ?? false, run: ev.run }
            }
          })
        }
      }),
    []
  )

  return { entries, seed, setOpen }
}
