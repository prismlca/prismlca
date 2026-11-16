/**
 * After an assistant run on the model on screen, the Model page's toolbar holds what the run calculated: its
 * process selected on the canvas (the functional-unit pill reads the selection) and its method in the
 * selector. "Calculate" on the canvas then computes what the chat reported. Nothing is calculated here —
 * the selection and the method are all that change. Which calculation counts is runCalculation.ts.
 *
 * Without it the chat named a score and a method while the toolbar beside it read "select a process" and
 * offered the first method in the list — unless the run had happened to use `calculate_in_canvas`, which
 * selects and sets both itself.
 *
 * The in-app chat's runs only, and only a run of the model on screen: `done` carries no model, so the
 * model's own chat list says whether the run's chat is one of its chats. A run of another model, or one
 * that ends after the user opened another, changes nothing.
 *
 * A process the run created in its last moments may not be a box yet: the canvas reloads a little after
 * the run's last edit. The method is set at once, and the canvas is looked at again a few times for the
 * box — for as long as the same model is on screen and no newer run's calculation has taken the toolbar.
 */
import { useEffect, useRef } from 'react'

import { onChatEvent } from '../chat/turnView'
import { listChats } from '../lib/ai'
import type { MethodEntry } from '../lib/methods'
import { mayHaveCalculated, runCalculation } from './runCalculation'
import type { useCanvasModel } from './useCanvasModel'

type Canvas = ReturnType<typeof useCanvasModel>

/** Between two looks for an awaited box: a little more than the reload's debounce (useAiEditRefresh). */
export const LOOK_AGAIN_MS = 300
/** Looks after the first, so about 1.5 s in all: a selection arriving later would come out of nowhere. */
export const LOOKS = 5

export interface RunCalculationOnCanvasDeps {
  activeDb: string | null
  methods: MethodEntry[]
  setChosen: (v: string) => void
  canvas: Pick<Canvas, 'selectOnly' | 'nodesRef'>
}

export function useRunCalculationOnCanvas(deps: RunCalculationOnCanvasDeps): void {
  // Read when a run ends, not when the subscription was made.
  const ref = useRef(deps)
  ref.current = deps

  useEffect(() => {
    let alive = true
    /** Runs that ended with a calculation, counted; and the newest of them that has reached the toolbar. */
    let ended = 0
    let shown = 0
    let looking: ReturnType<typeof setTimeout> | null = null
    const stopLooking = (): void => {
      if (looking) clearTimeout(looking)
      looking = null
    }
    /** Select the box once the canvas shows it, looking `left` more times while `db` stays on screen. */
    const lookFor = (id: string, db: string, left: number): void => {
      looking = setTimeout(() => {
        looking = null
        const now = ref.current
        if (now.activeDb !== db) return
        if (now.canvas.nodesRef.current.some((n) => n.id === id)) now.canvas.selectOnly(id)
        else if (left > 1) lookFor(id, db, left - 1)
      }, LOOK_AGAIN_MS)
    }

    const off = onChatEvent((ev, before) => {
      if (ev.type !== 'done' && ev.type !== 'error') return
      // `done` brings the run's whole trace, arguments included. A failed run brings none: the rows the
      // turn view assembled are what there is (a call still running has no status and counts for nothing).
      const traces = (ev.type === 'done' ? ev.trace : undefined) ?? before?.live ?? []
      const db = ref.current.activeDb
      if (!db || !mayHaveCalculated(traces)) return
      const run = ++ended
      void listChats(db)
        .then(({ chats }) => {
          const now = ref.current
          // Unmounted; a newer run has set the toolbar already; another model was opened while we asked;
          // or the run's chat belongs to another model.
          if (!alive || run < shown || now.activeDb !== db || !chats.some((c) => c.id === ev.chatId)) return
          shown = run
          // An older run still waiting for its box must not select it over this run's choice.
          stopLooking()
          // The canvas as it stands once the answer is in, not as it stood at `done`.
          const { processId, awaitedProcessId, methodIndex } = runCalculation({
            traces,
            activeDb: db,
            processIds: new Set(now.canvas.nodesRef.current.map((n) => n.id)),
            methods: now.methods
          })
          if (methodIndex !== undefined) now.setChosen(String(methodIndex))
          if (processId) now.canvas.selectOnly(processId)
          else if (awaitedProcessId) lookFor(awaitedProcessId, db, LOOKS)
        })
        // The toolbar then stays as it was; the chat has said what the run found either way.
        .catch(() => {})
    })
    return () => {
      alive = false
      off()
      stopLooking()
    }
  }, [])
}
