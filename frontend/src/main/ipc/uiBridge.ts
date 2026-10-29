/**
 * The main → renderer → main round-trip for UI tools, and main's record of the questions waiting
 * on the user.
 *
 * Lived inside `registerChatIpc` until 01.10.2026, bound to a chat id. The MCP server for external
 * agents needs the same round-trip — a canvas action, a question card, a "may this run?" card — for
 * a SESSION that has no chat. So the bridge is its own object: one pending map, one counter, one
 * record of open questions, and a `call` that knows which of the two it is serving. The renderer
 * receives the same `ai:ui-tool` message either way; `sessionId` on it says "not a chat".
 */
import { ipcMain, type BrowserWindow } from 'electron'

import { PendingAsks } from '../ai/pendingAsks'
import { MCP_ASK_TIMEOUT_MS } from '../mcp/timeouts'
import type { AgentEvent, PendingAsk } from '../../shared/ipc'

/** How long an ask_user (or an approval card) waits for a human before the run goes on without an
 *  answer. Thirty minutes: since the Workbench shows a banner for a question asked while the user is
 *  in another model or view (06.09.2026), the wait is on the user noticing, not on the chat being
 *  watched — and ten minutes was short for someone finishing a thought in the other model first. */
export const ASK_USER_TIMEOUT_MS = 30 * 60_000

/** Programmatic UI actions (jump, layout, screenshot rect) answer in milliseconds; this is a hang. */
const UI_ACTION_TIMEOUT_MS = 30_000

/** The two UI tools that pend on a HUMAN, and are therefore recorded as open questions. */
const HUMAN_TOOLS = new Set(['ask_user', 'approve_tool'])

export interface UiCallOpts {
  signal?: AbortSignal
  /** The chat whose run is asking — routes the card to the right chat panel. */
  chatId?: string
  /** The external-agent session asking (MCP). Mutually exclusive with `chatId` in practice. */
  sessionId?: string
  /** What the external client calls itself — shown on the card so the user knows who is asking. */
  clientName?: string
  /** The model the run/session works on; canvas tools refuse when another model is on screen. */
  activeDb?: string | null
}

export interface UiBridgeDeps {
  getWindow: () => BrowserWindow | null
  /** Push an event to the renderer (the same channel the chat streams on). */
  emit: (ev: AgentEvent) => void
}

export class UiBridge {
  /** The questions waiting on the user — main's record, because main survives the window. */
  readonly pendingAsks = new PendingAsks()
  private readonly pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private counter = 0

  constructor(private readonly deps: UiBridgeDeps) {}

  /** Renderer → main channels: the answer to a request, and the list of open questions. */
  registerIpc(): void {
    ipcMain.handle('ai:pendingAsks', () => this.pendingAsks.list())
    ipcMain.on(
      'ai:ui-result',
      (_e, msg: { reqId: string; ok: boolean; result?: unknown; error?: string }) => {
        const p = this.pending.get(msg.reqId)
        if (!p) return
        this.pending.delete(msg.reqId)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(msg.error || 'UI action failed.'))
      }
    )
  }

  /** Whether a window exists to serve a UI action right now. */
  hasWindow(): boolean {
    return !!this.deps.getWindow()
  }

  async call(name: string, args: Record<string, unknown>, opts?: UiCallOpts): Promise<any> {
    const win = this.deps.getWindow()
    if (!win) throw new Error('No window available for the UI action.')
    if (opts?.signal?.aborted) throw new Error('Canceled.')
    // Main's own action, no renderer needed: bring the window forward. On Wayland/GNOME `focus()`
    // often only flashes the task-bar entry — that is the platform's decision, and it is still the
    // user's cue.
    if (name === 'show_window') {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      return { ok: true, focused: win.isFocused() }
    }
    const reqId = `ui${++this.counter}`
    // ask_user pends on a human answer, so it gets minutes, not the 30s of programmatic UI actions.
    const human = HUMAN_TOOLS.has(name) && !!(opts?.chatId || opts?.sessionId)
    const timeoutMs = human
      ? opts?.sessionId
        ? MCP_ASK_TIMEOUT_MS
        : ASK_USER_TIMEOUT_MS
      : UI_ACTION_TIMEOUT_MS
    // The event's chatId is the routing key for chat panels; an external session has none, and the
    // empty string matches no chat — the Workbench routes those by `sessionId` instead.
    const eventChat = opts?.chatId ?? ''
    if (human) {
      const ask: PendingAsk = {
        reqId,
        chatId: eventChat,
        database: opts?.activeDb ?? null,
        args,
        since: Date.now(),
        ...(opts?.sessionId
          ? { origin: 'mcp' as const, sessionId: opts.sessionId, clientName: opts.clientName }
          : {}),
        ...(name === 'approve_tool' ? { kind: 'approval' as const } : {})
      }
      this.pendingAsks.add(ask)
      this.deps.emit({ chatId: eventChat, type: 'ask', ask })
    }
    const result = await new Promise<any>((resolve, reject) => {
      let done = false
      const settle = (fn: (v: any) => void, v: any): void => {
        if (done) return
        done = true
        this.pending.delete(reqId)
        if (human && this.pendingAsks.settle(reqId)) {
          this.deps.emit({ chatId: eventChat, type: 'ask-settled', reqId })
        }
        clearTimeout(timer)
        opts?.signal?.removeEventListener('abort', onAbort)
        win.webContents.removeListener('did-navigate', onGone)
        win.webContents.removeListener('render-process-gone', onGone)
        fn(v)
      }
      const onAbort = (): void => settle(reject, new Error('Canceled.'))
      // A reload/crash of the renderer loses the pending request — fail fast instead of waiting
      // out the timeout (matters for ask_user, which may pend for minutes).
      const onGone = (): void => settle(reject, new Error('The window was reloaded.'))
      const timer = setTimeout(
        () =>
          settle(
            reject,
            new Error(
              human
                ? `No answer from the user within ${Math.round(timeoutMs / 60_000)} minutes — the card was closed. Ask again when the user is back, or continue with a stated assumption.`
                : 'UI action timed out.'
            )
          ),
        timeoutMs
      )
      this.pending.set(reqId, {
        resolve: (v) => settle(resolve, v),
        reject: (e) => settle(reject, e)
      })
      opts?.signal?.addEventListener('abort', onAbort, { once: true })
      win.webContents.on('did-navigate', onGone)
      win.webContents.on('render-process-gone', onGone)
      win.webContents.send('ai:ui-tool', {
        reqId,
        name,
        args,
        chatId: opts?.chatId,
        sessionId: opts?.sessionId,
        clientName: opts?.clientName,
        database: opts?.activeDb ?? undefined
      })
    })
    // The screenshot tool returns just the canvas rect; the main process captures it (only main
    // can access webContents.capturePage) and hands back a data URL for vision models.
    if (name === 'screenshot_canvas' && result?.rect) {
      const img = await win.webContents.capturePage(result.rect)
      return { image: `data:image/png;base64,${img.toPNG().toString('base64')}` }
    }
    return result
  }

  /** Cancel every open question of one external session (disconnect, session end). */
  cancelSession(sessionId: string, reason = 'The session ended.'): void {
    for (const ask of this.pendingAsks.list()) {
      if (ask.sessionId !== sessionId) continue
      this.pending.get(ask.reqId)?.reject(new Error(reason))
    }
  }
}
