/**
 * The Workbench's answer to the canvas requests of the in-app assistant and of external agents (MCP), on
 * whichever page is shown.
 *
 * The chat panel used to answer the assistant's, and it exists on the Model view only: on every other page
 * nobody did, and each canvas action hung until main gave up after 30 s (V481). The canvas state lives in
 * the Workbench and outlasts the Model view, so most requests act on it where it is — a layout, a removal,
 * a calculation or a read — and the answer says the user sees the outcome in the model view. Only the two
 * that are about the screen, centring a process and the screenshot, open the model view themselves and
 * wait until it is drawn.
 *
 * One owner per request: the chat panel answers its question cards and its title, useMcpUiTools the
 * app-level requests, the External-agents drawer a session's cards — and each leaves these names alone.
 */
import { useEffect, useRef } from 'react'
import { onUiTool, uiResult, type UiToolRequest } from '../lib/ai'
import { errMsg } from '../lib/errors'
import type { ViewKey } from './AppSidebar'
import type { ChatUiHandlers } from './useAiCanvasTools'

/** The requests that read or change the canvas (or, for `setup_results`, the Results view). */
export const CANVAS_UI_TOOLS: ReadonlySet<string> = new Set([
  'jump_to_process',
  'auto_layout',
  'screenshot_canvas',
  'calculate_in_canvas',
  'setup_results',
  'get_canvas',
  'clear_canvas',
  'remove_from_canvas'
])

/** The two that need the canvas on screen: they open the model view first. */
const ON_SCREEN: ReadonlySet<string> = new Set(['jump_to_process', 'screenshot_canvas'])

/**
 * What a run is told when it asks for the canvas of a model the user is not looking at. Says what
 * still works, so the model finishes the modelling instead of stopping to wait for a screen — and
 * says the canvas is a view, so it does not conclude the model's data is out of reach.
 */
const canvasElsewhere = (database: string): string =>
  `The canvas of "${database}" is not on screen: the user is currently viewing a different model. ` +
  'Canvas actions (viewing, arranging, calculating in the canvas) are unavailable until they return to ' +
  `"${database}". The model's data is unaffected — the modelling tools keep working, so continue with ` +
  'those and mention the canvas step in your answer.'

/** An external agent may switch the window's model itself. */
const otherModel = (shown: string, wanted: string): string =>
  `The window shows "${shown}", not "${wanted}". Call canvas_view action="open_model" first.`

/** Beside an action done on a canvas the user is not looking at. */
const OFF_SCREEN = 'model view (the user is on another page)'

/** The canvas did not come on screen while a request waited for it (the user moved on, or it took too long). */
const NOT_ON_SCREEN = 'Canvas not visible.'

export interface CanvasUiToolsDeps {
  activeDb: string | null
  view: ViewKey
  setView: (v: ViewKey) => void
  ui: ChatUiHandlers
  /** Resolves once the Model view shows this model's canvas, drawn (useAiCanvasTools). */
  whenDrawn: () => Promise<boolean>
}

/** Another model on screen: the refusal for this request's origin. */
const elsewhere = (msg: UiToolRequest, shownDb: string, wanted: string): { error: string } => ({
  error: msg.sessionId ? otherModel(shownDb, wanted) : canvasElsewhere(wanted)
})

async function serve(msg: UiToolRequest, now: () => CanvasUiToolsDeps): Promise<unknown> {
  const { view, setView, whenDrawn, activeDb } = now()
  const shown = view === 'model'
  if (ON_SCREEN.has(msg.name)) {
    if (!shown) setView('model')
    const drawn = await whenDrawn()
    // Checked again after the wait: the user may have opened another model or page meanwhile, and the
    // screenshot or the jump would then be of a canvas the request never asked about.
    const after = now()
    const switched = shown ? {} : { switched_to: 'model view' }
    if (after.activeDb !== activeDb && after.activeDb)
      return { ...elsewhere(msg, after.activeDb, msg.database ?? activeDb ?? ''), ...switched }
    if (!drawn || after.view !== 'model') return { error: NOT_ON_SCREEN, ...switched }
    // The handlers of the render that has the canvas mounted.
    if (msg.name === 'jump_to_process') {
      after.ui.jumpToProcess(String(msg.args.code))
      return { ok: true, ...switched }
    }
    const rect = after.ui.screenshotRect()
    return rect ? { rect, ...switched } : { error: NOT_ON_SCREEN, ...switched }
  }
  const u = now().ui
  let out: unknown = { ok: true }
  switch (msg.name) {
    case 'auto_layout':
      u.autoLayout()
      break
    case 'calculate_in_canvas':
      out = await u.calculateInCanvas(
        (msg.args.method as string[]) ?? [],
        msg.args.code ? String(msg.args.code) : undefined
      )
      break
    case 'setup_results':
      // Prepares the Results page, and its answer says itself where the user is.
      return await u.setupResults(msg.args)
    case 'get_canvas':
      out = u.getCanvas()
      break
    case 'clear_canvas':
      out = u.clearCanvas()
      break
    case 'remove_from_canvas':
      out = await u.removeFromCanvas(String(msg.args.code))
      break
  }
  const plain = !!out && typeof out === 'object' && !Array.isArray(out) && !('error' in out)
  return shown || !plain ? out : { ...(out as object), visible_in: OFF_SCREEN }
}

export function useCanvasUiTools(deps: CanvasUiToolsDeps): void {
  // Read inside the handler, which subscribes once and would otherwise close over the first render.
  const ref = useRef(deps)
  ref.current = deps
  useEffect(() => {
    const off = onUiTool(async (msg: UiToolRequest) => {
      if (!CANVAS_UI_TOOLS.has(msg.name)) return
      try {
        // The canvas belongs to the model on screen. A run working on another model (started there, the
        // user has switched since — or two assistants in parallel) would read or rearrange the wrong one.
        // Refused with the reason, as a result the model can act on.
        const shownDb = ref.current.activeDb
        if (msg.database && shownDb && msg.database !== shownDb) {
          uiResult(msg.reqId, true, elsewhere(msg, shownDb, msg.database))
          return
        }
        uiResult(msg.reqId, true, await serve(msg, () => ref.current))
      } catch (e) {
        uiResult(msg.reqId, false, undefined, errMsg(e))
      }
    })
    return off
  }, [])
}
