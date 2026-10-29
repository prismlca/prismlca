/**
 * The Workbench's answer to UI-tool requests that are not a chat's: everything an external-agent
 * session (MCP) asks of the window, plus the three requests that belong to the app rather than to a
 * chat panel whoever asks — open a model, open a page, report the window state.
 *
 * The chat panel (CanvasChat) answers its own canvas requests and question cards; it ignores
 * requests carrying a `sessionId` and the app-level names below, so every request has exactly one
 * owner. The two human-facing requests of a session — `ask_user`, `approve_tool` — are not answered
 * here at all: main records them as open questions, the External-agents drawer shows the cards, and
 * the card resolves them (`uiResult`). Nothing else must answer them, or the card would go stale.
 */
import { useEffect, useRef } from 'react'
import type { ChatUiHandlers } from '../CanvasChat'
import { onUiTool, uiResult, type UiToolRequest } from '../lib/ai'
import { splitId } from '../lib/canvas'
import type { ViewKey } from './AppSidebar'

/** Requests the Workbench answers for ANY origin (the chat panel never sees them). */
export const WORKBENCH_UI_TOOLS: ReadonlySet<string> = new Set(['open_model', 'open_page', 'get_state'])

const PAGES: ReadonlySet<string> = new Set<ViewKey>([
  'overview',
  'model',
  'parameters',
  'scenarios',
  'lcia',
  'results',
  'report'
])

const CANVAS_TOOLS: ReadonlySet<string> = new Set([
  'jump_to_process',
  'auto_layout',
  'screenshot_canvas',
  'calculate_in_canvas',
  'setup_results',
  'get_canvas',
  'clear_canvas',
  'remove_from_canvas'
])

/** Resolved by the drawer's cards, never here. */
const HUMAN_TOOLS: ReadonlySet<string> = new Set(['ask_user', 'approve_tool'])

export interface McpUiToolsDeps {
  activeDb: string | null
  databases: Array<{ name: string; kind: string }>
  view: ViewKey
  setView: (v: ViewKey) => void
  openModel: (name: string) => void
  /** Re-read the database list from the backend and return it. `databases` above is the React copy,
   *  refreshed without waiting after every mutation — so a model created by the call just before is
   *  missing from it for a few milliseconds. */
  refreshDatabases: () => Promise<Array<{ name: string; kind: string }>>
  /** The canvas selection as node ids (`db/code`). */
  selected: string[]
  resultsTab: 'overview' | 'detail'
  chatUi: ChatUiHandlers
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function useMcpUiTools(deps: McpUiToolsDeps): void {
  // Read inside the handler, which subscribes once and would otherwise close over the first render.
  const ref = useRef(deps)
  ref.current = deps
  useEffect(() => {
    const off = onUiTool(async (msg: UiToolRequest) => {
      const mine = !!msg.sessionId || WORKBENCH_UI_TOOLS.has(msg.name)
      if (!mine || HUMAN_TOOLS.has(msg.name)) return
      const d = ref.current
      try {
        let result: unknown = { ok: true }
        switch (msg.name) {
          case 'get_state': {
            result = {
              view: d.view,
              active_model: d.activeDb,
              selected: d.selected.map((id) => {
                const [database, code] = splitId(id)
                // A box id carries its occurrence after '#': the same dataset can be selected twice.
                return id === `${database}/${code}` ? { database, code } : { database, code, id }
              }),
              results_tab: d.resultsTab === 'detail' ? 'detailed' : 'overview'
            }
            break
          }
          case 'open_model': {
            const name = String(msg.args.database ?? '')
            // Not in the React copy is not yet "does not exist": `manage_model create` answers before
            // the list the app holds has caught up, and an agent opens the model it just made with
            // the very next call. Ask the backend once before saying no.
            const db =
              d.databases.find((x) => x.name === name) ??
              (await d.refreshDatabases()).find((x) => x.name === name)
            if (!db) result = { error: `No model "${name}" in this workspace.` }
            else if (db.kind !== 'foreground')
              result = { error: `"${name}" is a ${db.kind} database, not a model.` }
            else {
              if (name !== d.activeDb) d.openModel(name)
              d.setView('model')
              result = { ok: true, active_model: name, view: 'model' }
            }
            break
          }
          case 'open_page': {
            const page = String(msg.args.page ?? '')
            if (!PAGES.has(page))
              result = { error: `Unknown page "${page}". One of: ${[...PAGES].join(', ')}.` }
            else {
              d.setView(page as ViewKey)
              result = { ok: true, view: page }
            }
            break
          }
          default: {
            if (!CANVAS_TOOLS.has(msg.name)) {
              result = { error: `Unknown UI tool: ${msg.name}` }
              break
            }
            // The canvas handlers act on the model on screen and need the Model page mounted.
            if (msg.database && d.activeDb && msg.database !== d.activeDb) {
              result = {
                error: `The window shows "${d.activeDb}", not "${msg.database}". Call canvas_view action="open_model" first.`
              }
              break
            }
            // `setup_results` configures the Results page (and may open it): it needs no canvas on
            // screen — refusing it from the Results page was the one place the guard bit the tool
            // it was meant to serve (V392).
            if (d.view !== 'model' && msg.name !== 'setup_results') {
              result = {
                error: 'The Model page is not open. Call canvas_view action="open_page" page="model" first.'
              }
              break
            }
            const u = d.chatUi
            switch (msg.name) {
              case 'jump_to_process':
                u.jumpToProcess(String(msg.args.code))
                break
              case 'auto_layout':
                u.autoLayout()
                break
              case 'screenshot_canvas': {
                const rect = u.screenshotRect()
                result = rect ? { rect } : { error: 'Canvas not visible.' }
                break
              }
              case 'calculate_in_canvas':
                result = await u.calculateInCanvas(
                  (msg.args.method as string[]) ?? [],
                  msg.args.code ? String(msg.args.code) : undefined
                )
                break
              case 'setup_results':
                result = await u.setupResults(msg.args)
                break
              case 'get_canvas':
                result = u.getCanvas()
                break
              case 'clear_canvas':
                result = u.clearCanvas()
                break
              case 'remove_from_canvas':
                result = await u.removeFromCanvas(String(msg.args.code))
                break
            }
          }
        }
        uiResult(msg.reqId, true, result)
      } catch (e) {
        uiResult(msg.reqId, false, undefined, errMsg(e))
      }
    })
    return off
  }, [])
}
