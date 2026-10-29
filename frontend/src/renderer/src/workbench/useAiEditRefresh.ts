/**
 * The Workbench follows the assistant's edits on every view, not only where its chat is.
 *
 * Each write of a run emits a `refresh`; this reloads what the write touched — the canvas when it shows
 * the edited model, the audit log and with it the model caches (reloadAudit), the database list and the tag
 * groups — through the same `refresh` an external agent's edits take. It hears the events for the
 * Workbench's whole lifetime (the turn feed is held there), because the chat panel exists on the Model view
 * only: an edit made while Parameters or the Overview showed reached no one, and on return the canvas drew
 * the graph from before — boxes without the background suppliers linked meanwhile, until the model was
 * opened again. The canvas state lives in the Workbench, so it rebuilds while hidden and is current when
 * the Model view mounts.
 *
 * Coalesced: a run of forty edits costs one reload, and once any coalesced edit was to the model on screen,
 * the canvas is part of it.
 */
import { useEffect, useRef } from 'react'

import type { ChatUiHandlers } from '../CanvasChat'
import { onChatEvent } from '../chat/turnView'

export function useAiEditRefresh(activeDb: string | null, refresh: ChatUiHandlers['refresh']): void {
  // Read when an event arrives, not when the subscription was made.
  const activeDbRef = useRef(activeDb)
  activeDbRef.current = activeDb
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let canvas = false
    let fit = false
    const schedule = (withCanvas: boolean, withFit = false): void => {
      if (timer) clearTimeout(timer)
      canvas ||= withCanvas
      fit ||= withFit
      timer = setTimeout(() => {
        const opts = { canvas, fit: canvas && fit }
        timer = null
        canvas = false
        fit = false
        refreshRef.current(opts)
      }, 250)
    }
    /**
     * Runs that added or removed boxes or arrows on the model on screen, by chat — and which model that
     * was. When such a run ends, the canvas is fitted to the view, once: new processes used to land
     * outside the frame and "Fit view" had to be pressed by hand. Not during the run, where the view would
     * jump under the reader at every step, and not after a turn that only read, calculated or set
     * parameters, where the user's own framing is the one that matters. Off the Model view the fit is left
     * to the canvas, which fits itself when it is shown again.
     */
    const fitAfterRun = new Map<string, string | undefined>()
    const off = onChatEvent((ev) => {
      if (ev.type === 'refresh') {
        // The canvas only when it shows the edited model: an assistant working on another model must not
        // rebuild the graph the user is editing by hand here. A model switch loads the graph afresh anyway.
        const onScreen = !ev.database || ev.database === activeDbRef.current
        if (onScreen && ev.structure) fitAfterRun.set(ev.chatId, ev.database)
        schedule(onScreen && ev.graph !== false)
      } else if (ev.type === 'done' || ev.type === 'error') {
        // A run that failed half-way has still put its boxes on the canvas.
        if (!fitAfterRun.has(ev.chatId)) return
        const database = fitAfterRun.get(ev.chatId)
        fitAfterRun.delete(ev.chatId)
        // Merged into the run's final reload (still debouncing): one rebuild, then one fit.
        if (!database || database === activeDbRef.current) schedule(true, true)
      }
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])
}
