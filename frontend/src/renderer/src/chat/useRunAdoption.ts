/**
 * Take over a run this window did not start.
 *
 * `busy` used to be set only where a message was sent, so it was a claim about THIS component's
 * history rather than about the run. Reload the window — or let a tool switch the active model,
 * which remounts everything — and it fell to false while the run carried on in the main process.
 * Three things hang off it: the run bar, the thinking dots and the Stop button. Losing the first
 * two is a nuisance; losing the third means a run that cannot be stopped and a question from the
 * model that nobody is shown (V274).
 *
 * The main process holds the abort controllers, so it is the only party that knows. Asked once the chat
 * is on screen — every way it comes up: the model's newest, the one shown from memory, a pick from the
 * list, "Go to chat". Asked before, a quick answer found the panel still on the previous chat and was
 * dropped, and with it the run bar and Stop for the whole run, as no later event marks a run again. The
 * ordinary `done`/`error` events clear it from there. Only ever marks a run, never clears one: a "not
 * running" answer here may predate a send made while it was in flight.
 */
import { useCallback, useEffect, type MutableRefObject } from 'react'

import { aiIsRunning, aiPendingAsks, aiSteerQueue, type PendingAsk as PendingAskInfo } from '../lib/ai'
import { approvalOf, askQuestions, type PendingAsk } from './askCards'
import { queueReports, runsEnded } from './turnView'

export interface RunAdoptionDeps {
  chatId: string | null
  chatIdRef: MutableRefObject<string | null>
  activeDbRef: MutableRefObject<string | null>
  askRef: MutableRefObject<PendingAsk | null>
  markRunning: (id: string, database: string | null | undefined, on: boolean) => void
  setQueued: (queued: string[]) => void
  setAsk: (ask: PendingAsk) => void
}

export function useRunAdoption(deps: RunAdoptionDeps): void {
  const { chatId, chatIdRef, activeDbRef, askRef, markRunning, setQueued, setAsk } = deps
  const adoptRun = useCallback(
    async (id: string) => {
      const ends = runsEnded(id)
      const reports = queueReports(id)
      const [running, asks, steers] = await Promise.all([
        aiIsRunning(id).catch(() => false),
        aiPendingAsks().catch((): PendingAskInfo[] => []),
        aiSteerQueue(id).catch((): string[] => [])
      ])
      if (chatIdRef.current !== id) return
      // What came in while the questions were out is newer than their answers. A `done` or `error`: the run
      // they describe is over — taken as they were, they put the run bar, Stop and an expired question back.
      // A queue report: it replaced the queue this read, and the chip of a message just queued would go.
      if (runsEnded(id) !== ends) return
      if (running) markRunning(id, activeDbRef.current, true)
      if (queueReports(id) === reports) setQueued(steers)
      // A question asked while this chat was not on screen: main kept it, so the card comes back
      // here rather than the run waiting on a card nobody was shown.
      const mine = asks.find((a) => a.chatId === id)
      if (mine && askRef.current?.reqId !== mine.reqId) {
        if (mine.kind === 'approval') {
          const approval = approvalOf(mine.args)
          if (approval) setAsk({ reqId: mine.reqId, chatId: id, questions: [], approval })
        } else {
          const questions = askQuestions(mine.args)
          if (questions.length) setAsk({ reqId: mine.reqId, chatId: id, questions })
        }
      }
    },
    [chatIdRef, activeDbRef, askRef, markRunning, setQueued, setAsk]
  )
  useEffect(() => {
    if (chatId) void adoptRun(chatId)
  }, [chatId, adoptRun])
}
