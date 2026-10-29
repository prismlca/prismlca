import { WORKBENCH_UI_TOOLS } from './workbench/useMcpUiTools'
import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import ComparisonPicker from './components/ComparisonPicker'
import { useComparedWith } from './lib/comparison'
import {
  aiCancel,
  aiSteer,
  aiUnsteer,
  aiSend,
  aiTranscribe,
  defaultVoiceLanguage,
  appendMessages,
  createChat,
  deleteChat,
  getChat,
  listChats,
  renameChat,
  onUiTool,
  openSource,
  uiResult,
  aiTools,
  type AttachmentMeta,
  type ChatMessage,
  type ChatSummary
} from './lib/ai'
import { getAS } from './lib/appSettings'
import { clampMaxTokens } from '../../shared/aiDefaults'
import { errMsg } from './lib/errors'
import type { SettingsCategory, SettingsFocus } from './views/Settings'
import { readDraft, writeDraft } from './chat/chatPrefs'
import { useChatPrefs } from './chat/useChatPrefs'
import { useAttachments } from './chat/useAttachments'
import ChatComposer from './chat/ChatComposer'
import { modelCatalogue } from './chat/ModelPicker'
import { usePlanState } from './chat/usePlanState'
import OtherRuns, { type OtherRun } from './chat/OtherRuns'
import { dropTurn, onChatEvent, startTurn, turnOf, useTurnFeed, useTurnView } from './chat/turnView'
import { leaveChat, shownChat, withLiveTail } from './chat/shownChats'
import { useRunAdoption } from './chat/useRunAdoption'
import { ContinueButton, PlanCard, PlanPill, resumable, runReason } from './components/PlanCard'
import { useAppSettings } from './lib/appSettings'
import { noteChatModel, setVisibleChat } from './lib/chatNotices'
import { DEFAULT_MODEL_ID } from '../../shared/aiDefaults'
import {
  approvalOf,
  askQuestions,
  AskUserCard,
  ChatApprovalCard,
  type ApprovalRequest,
  type PendingAsk
} from './chat/askCards'
import { ToolTraceList } from './chat/ToolTraceList'
import { ChatUsage, RunStatus } from './chat/RunStatus'
import { Markdown, MessageRow } from './chat/MessageRow'

/** Handlers the canvas provides so the assistant can drive the UI (executed in the renderer). */
export interface ChatUiHandlers {
  jumpToProcess: (code: string) => void
  autoLayout: () => void
  screenshotRect: () => { x: number; y: number; width: number; height: number } | null
  calculateInCanvas: (method: string[], code?: string) => Promise<unknown>
  setupResults: (args: Record<string, unknown>) => Promise<unknown> | unknown
  /** What is actually on the canvas (foreground + read-only reference boxes). */
  getCanvas: () => unknown
  /** Remove all read-only background reference boxes from the canvas view. */
  clearCanvas: () => unknown
  /** Remove one background reference box (by code) from the canvas view. */
  removeFromCanvas: (code: string) => Promise<unknown> | unknown
  /**
   * Reload after an AI edit: audit + databases + tags always, the canvas only when `canvas` is not
   * false — a run editing another model must not rebuild the graph on screen. `fit` fits the canvas
   * to the view once the graph is rebuilt (the end of a turn that added or removed boxes).
   */
  refresh: (opts?: { canvas?: boolean; fit?: boolean }) => void
}

/**
 * The UI tools that read or change the canvas on screen. Every other UI tool (ask_user,
 * set_chat_title) is about the chat, not the canvas, and is served whichever model is shown.
 */
const CANVAS_TOOLS = new Set([
  'jump_to_process',
  'auto_layout',
  'screenshot_canvas',
  'calculate_in_canvas',
  'setup_results',
  'get_canvas',
  'clear_canvas',
  'remove_from_canvas'
])

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

// Read the AI settings fresh (`getAS()`: the Settings panel writes them to userData/settings.json via
// lib/appSettings.ts, not localStorage) so a model change applies to the
// next message without remounting the chat.

export { shortSkillName } from './chat/ComposerMenu'
export { AskUserCard, ChatApprovalCard } from './chat/askCards'
export { formatArgs, ToolTraceList } from './chat/ToolTraceList'
export { MessageRow } from './chat/MessageRow'

export default function CanvasChat({
  activeDb,
  backgroundDbs,
  secondaryBackgroundDbs,
  libraryDbs,
  ui,
  aboveBar,
  onDatasetDrop,
  onOpenSettings,
  focusChat,
  onGoToChat,
  onAskShown
}: {
  activeDb: string | null
  /** Names of the installed read-only background databases, for the system prompt and the searches. */
  backgroundDbs?: string[]
  /** The ones among them that are NOT searched unless this chat switches them on (the second
   *  background, e.g. BAFU beside ecoinvent). */
  secondaryBackgroundDbs?: string[]
  /** The user's own library databases (My processes) the assistant may search when released. */
  libraryDbs?: string[]
  ui: ChatUiHandlers
  /**
   * Whatever should occupy the corner while the chat is collapsed — today the canvas minimap.
   *
   * It is a slot rather than a floating neighbour so that the two share ONE bottom-anchored column:
   * the input pill's height (it grows with a wrapped draft or an attachment chip) is then the
   * minimap's offset, with nothing to measure and nothing to keep in sync. Expanding the chat takes
   * the slot back, which is what "the chat covers the minimap" means here — see the render below.
   */
  aboveBar?: JSX.Element | null
  /**
   * A dataset dragged out of the search panel and released on the dock instead of on the canvas.
   *
   * The dock covers a corner of the canvas that is droppable everywhere else, and a drop there used to
   * be swallowed without a word — the chat bar has had that hole since it was docked, and the minimap
   * doubled it. Handled here rather than per occupant so the whole dock has one answer.
   */
  onDatasetDrop?: (event: React.DragEvent) => void
  /**
   * Open the Settings window on a page. The "+" menu's Skills flyout ends in "Add skill", which is
   * the Settings → AI → Skills page: creating one needs a name, a description and Markdown, and that
   * form exists once, there.
   */
  onOpenSettings?: (page: SettingsCategory, focus?: SettingsFocus) => void
  /**
   * Open the panel on this chat. The Workbench's "Go to chat" button on a question banner sets it,
   * together with the model and the view; `nonce` makes the same chat requestable twice. Consumed
   * once the model's chats are loaded, because the model switch picks the newest chat otherwise.
   */
  focusChat?: { chatId: string; nonce: number } | null
  /** Open a chat of another model: switch to the model, then focus the chat (the header's other runs). */
  onGoToChat?: (database: string, chatId: string) => void
  /**
   * Which question card is on screen right now (its request id), or null. The Workbench shows a
   * banner for every open question that is NOT on screen — a question asked while the user is in
   * another model, another view, or has the chat collapsed would otherwise wait unseen.
   */
  onAskShown?: (reqId: string | null) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  /** Is the transcript resting at its bottom? Drives both the autoscroll and the jump button. */
  const [atBottom, setAtBottom] = useState(true)
  const [height, setHeight] = useState(() => Math.round(window.innerHeight * 0.6))
  const [chats, setChats] = useState<ChatSummary[]>([])
  // From the first render on, not only from the loading effect: the refs below must already hold it when
  // StrictMode runs that effect's cleanup once on mount — it would store an empty panel over it.
  const [chatId, setChatId] = useState<string | null>(() => shownChat(activeDb)?.id ?? null)
  const [messages, setMessages] = useState<ChatMessage[]>(() => shownChat(activeDb)?.messages ?? [])
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  // The shown chat's turn in flight — streamed text, tool rows, thinking state — from the store that
  // keeps hearing a run while this panel is unmounted or shows another chat (chat/turnView.ts). The
  // Workbench holds the feed for the app's lifetime; holding it here too keeps the panel whole alone.
  useTurnFeed()
  const turn = useTurnView(chatId)
  const { streaming, live } = turn
  // Messages typed while the shown chat's run was working, waiting in main for the next round
  // boundary (the `steer` event; see main/ipc/chat.ts). Shown as chips above the input until taken.
  const [queued, setQueued] = useState<string[]>([])
  const [toolLabels, setToolLabels] = useState<Record<string, string>>({})
  /**
   * The chats with a run in flight, each with the model it works on — every chat this panel started or
   * adopted, across models. `busy` used to be one flag for the whole panel, and the panel survives a
   * model switch: start the assistant in model A, switch to model B, and B showed the Stop button and
   * refused to send until A was done — pressing that Stop cancelled A's run. Two assistants working on
   * two models at once are exactly the case, and the main process has always
   * allowed it: one abort controller per chat, each run bound to its own model at the start. So the
   * question the UI answers is "is the chat ON SCREEN running", and this is where it looks it up.
   *
   * A ref plus a version counter rather than state: the event handlers below are subscribed once and
   * read it in the moment, and a send must mark its chat before its first await, not after a render.
   */
  const runningRef = useRef(new Map<string, string>())
  const [, bumpRunning] = useState(0)
  const markRunning = useCallback((id: string, database: string | null | undefined, on: boolean) => {
    const map = runningRef.current
    if (on === map.has(id)) return
    if (on) {
      map.set(id, database ?? '')
      noteChatModel(id, database)
    } else map.delete(id)
    bumpRunning((n) => n + 1)
  }, [])
  const busy = !!chatId && runningRef.current.has(chatId)
  const [error, setError] = useState<string | null>(null)
  const [showChats, setShowChats] = useState(false)
  // Files attached to the message being written — see chat/useAttachments.ts.
  const attach = useAttachments({ setError, setOpen })
  const { attachments, clearAttachments } = attach
  const [dropping, setDropping] = useState(false)
  // The models the active one is compared with (study metadata).
  const comparedWith = useComparedWith(activeDb)
  // The per-chat switches of the "+" menu and the draft — see chat/useChatPrefs.ts.
  const prefs = useChatPrefs(chatId, { activeDb, comparedWith, backgroundDbs, secondaryBackgroundDbs })
  // Both stable (useCallback [] in the hook). Taken out of `prefs` because a callback that CALLS
  // `prefs.x()` would have to depend on the whole object, which is new on every render.
  const { typeInput, adopt } = prefs
  const [pickingComparison, setPickingComparison] = useState(false)
  // The plan card (plan tool). Frozen = the selected model has no plan tool (`planTool: false` in
  // its catalogue row): a plan an earlier model left stays readable, collapsed, and nothing opens it
  // automatically. A model missing from the catalogue counts as not frozen, as main defaults to true.
  const appSettings = useAppSettings()
  const currentModel = appSettings.model || DEFAULT_MODEL_ID
  const [planToolOff, setPlanToolOff] = useState<Set<string>>(() => new Set())
  /** Context window per model id, for the meter's 100 % (absent = the catalogue does not know). */
  const [windows, setWindows] = useState<Record<string, number>>({})
  useEffect(() => {
    let stale = false
    void modelCatalogue()
      .then((list) => {
        if (stale) return
        setPlanToolOff(new Set(list.filter((m) => m.planTool === false).map((m) => m.id)))
        setWindows(
          Object.fromEntries(list.filter((m) => m.contextTokens).map((m) => [m.id, m.contextTokens!]))
        )
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])
  const frozen = planToolOff.has(currentModel)
  /** Whether the canvas column has room for the card beside the dock; measured below. Without room the
   *  card can only open over the transcript, so it waits as the pill until it is asked for. */
  const [planWide, setPlanWide] = useState(true)
  const { entries: planEntries, seed: seedPlan, setOpen: setPlanOpen } = usePlanState(frozen || !planWide)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [ask, setAsk] = useState<PendingAsk | null>(null) // pending ask_user question, if any
  // Voice input: 'rec' while the microphone records, 'busy' while OpenRouter transcribes.
  const [voice, setVoice] = useState<'idle' | 'rec' | 'busy'>('idle')
  const recRef = useRef<{ rec: MediaRecorder; stream: MediaStream } | null>(null)

  // Human-readable tool names for the trace entries — the same catalog Settings → AI tools uses,
  // so a label is defined in exactly one place (TOOL_META in main/ai/tools.ts).
  useEffect(() => {
    void aiTools()
      .then((list) => setToolLabels(Object.fromEntries(list.map((t) => [t.name, t.label]))))
      .catch(() => {})
  }, [])

  const chatIdRef = useRef<string | null>(null)

  /**
   * Forget the queued-message chips on screen when the shown chat changes: they belong to the chat that
   * was showing, and the next chat's queue comes from main (chat/useRunAdoption.ts). The turn itself is
   * kept per chat (chat/turnView.ts) and changes with `chatId` on its own.
   */
  const clearQueued = useCallback(() => setQueued([]), [])
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const uiRef = useRef(ui)
  const activeDbRef = useRef(activeDb)
  const askRef = useRef<PendingAsk | null>(null)
  /** The createChat lock: a second send while the first creates the chat must not make another. */
  const creatingChat = useRef(false)
  /** The user message on its way to the store: a second click meanwhile must not send it twice. */
  const storingMessage = useRef(false)
  /** Which openChat is the current one — a slow getChat for an earlier click must not land. */
  const openSeq = useRef(0)
  chatIdRef.current = chatId

  uiRef.current = ui
  activeDbRef.current = activeDb
  askRef.current = ask

  /** Resolve the pending ask_user. One array of answers per question; `freeText` is one flag per
   *  question from the card's own-answer fields, or `true` when the chat input answered the whole
   *  form as a single reply. */
  const answerAsk = useCallback((answers: string[][], freeText: boolean | boolean[] = false) => {
    const a = askRef.current
    if (!a) return
    setAsk(null)
    uiResult(a.reqId, true, { answers, freeText })
  }, [])
  /** Resolve the pending approve_tool card: main's gate runs the call on true, refuses it on false. */
  const answerApproval = useCallback((approved: boolean) => {
    const a = askRef.current
    if (!a?.approval) return
    setAsk(null)
    uiResult(a.reqId, true, { approved })
  }, [])

  // Through the existing `uiRef` (kept current above), so the handler identity never changes. `ui` is
  // a useMemo in useAiCanvasTools that is rebuilt on every canvas selection change — listing it as a
  // dependency gave every message in the transcript a new `onJump` the moment you clicked a process,
  // which would switch the memo on MessageRow off exactly when someone is working.
  const jump = useCallback((code: string) => {
    uiRef.current.jumpToProcess(code)
  }, [])

  // Load this model's chats when the active model changes. Runs elsewhere keep going — the main
  // process owns them — and are shown again when their chat is. The chat this panel last showed for the
  // model is on screen at once (chat/shownChats.ts) until the store has answered.
  useEffect(() => {
    const last = shownChat(activeDb)
    setChatId(last?.id ?? null)
    setMessages(last?.messages ?? [])
    clearQueued()
    setError(null)
    if (!activeDb) {
      setChats([])
      return
    }
    let alive = true
    void listChats(activeDb)
      .then(async (r) => {
        if (!alive) return
        setChats(r.chats)
        // The newest chat — unless a "Go to chat" request names one of this model's chats.
        const wanted = focusPending.current
        const pick = wanted && r.chats.some((c) => c.id === wanted) ? wanted : r.chats[0]?.id
        if (pick === wanted) focusPending.current = null
        if (!pick) {
          // The chat shown last may be gone (deleted): no stale transcript stays on screen.
          setChatId(null)
          setMessages([])
        }
        if (pick) {
          const full = await getChat(activeDb, pick)
          if (!alive) return
          setChatId(full.id)
          // The chat shown from memory may have gone on live meanwhile (a turn ended): that stays.
          setMessages((cur) =>
            full.id === last?.id ? withLiveTail(full.messages, cur, last.messages) : full.messages
          )
          seedPlan(full.id, full.plan, full.run)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
      // Leaving this model or the Model view: what is on screen now is what comes back first.
      leaveChat(activeDb, chatIdRef.current, messagesRef.current)
    }
  }, [activeDb, clearQueued, seedPlan])

  // Whether the chat now on screen is running, its questions and queue — once it is on screen.
  useRunAdoption({ chatId, chatIdRef, activeDbRef, askRef, markRunning, setQueued, setAsk })

  // "Go to chat" from a question banner. Opens the panel now; the chat itself is opened now if it is
  // among the loaded chats, else by the model-switch effect above once they are (the request usually
  // arrives together with a model switch).
  const focusPending = useRef<string | null>(null)
  const chatsRef = useRef(chats)
  chatsRef.current = chats
  const openChatRef = useRef<(id: string) => Promise<void>>(async () => {})
  useEffect(() => {
    if (!focusChat) return
    setOpen(true)
    if (chatsRef.current.some((c) => c.id === focusChat.chatId)) {
      focusPending.current = null
      void openChatRef.current(focusChat.chatId)
    } else {
      focusPending.current = focusChat.chatId
    }
  }, [focusChat])

  // The chat on screen needs no "finished elsewhere" notice, and reaching it clears one (V406).
  const visibleChat = open ? chatId : null
  useEffect(() => {
    setVisibleChat(visibleChat)
    return () => setVisibleChat(null)
  }, [visibleChat])

  // Tell the Workbench which question card is on screen, so its banner covers exactly the others.
  const shownAsk = open && ask && ask.chatId === chatId ? ask.reqId : null
  useEffect(() => {
    onAskShown?.(shownAsk)
    return () => onAskShown?.(null)
  }, [shownAsk, onAskShown])

  // Subscribe to streaming events. The turn's display (text, tool rows, thinking) is the store's
  // (chat/turnView.ts), which hands each event over with the turn as it stood before it; this handles
  // what the panel does with them. done/error clear the running mark of THEIR chat whichever chat is
  // on screen (otherwise a chat would stay busy forever). Persistence of the assistant's answer
  // happens in the main process, so nothing is lost if this component unmounts mid-run. The reloads an
  // edit asks for are the Workbench's (workbench/useAiEditRefresh.ts): this panel exists on one view only.
  useEffect(() => {
    const off = onChatEvent((ev, before) => {
      const forShownChat = ev.chatId === chatIdRef.current
      // A stale question card must not outlive its run: the main process may have timed the
      // question out (run resumes → deltas) or the run ended (done/error).
      if (
        (ev.type === 'delta' || ev.type === 'done' || ev.type === 'error') &&
        askRef.current &&
        ev.chatId === askRef.current.chatId
      ) {
        setAsk(null)
      }
      if (ev.type === 'steer') {
        if (!forShownChat) return
        setQueued(ev.queued)
      } else if (ev.type === 'done') {
        markRunning(ev.chatId, null, false)
        if (!forShownChat) return
        const text = ev.text || before?.streaming || ''
        // The trace from the main process still wins: it is the authoritative record of the turn
        // (arguments included), whereas the live list is assembled from events and misses whatever
        // came before a window reload. Both carry result previews.
        const trace = ev.trace ?? before?.live ?? []
        // In the same commit as the store's update, which has already dropped the live turn: that one
        // renders at once (useSyncExternalStore), a plain setState from this IPC callback a task later,
        // and the frame between them showed the transcript without the streamed text and without the
        // answer that replaces it — a jump at the end of every long run.
        if (text)
          flushSync(() =>
            setMessages((m) => [
              ...m,
              {
                role: 'assistant',
                content: text,
                tools: trace.length ? trace : undefined,
                cost: ev.cost,
                prompt_tokens: ev.promptTokens,
                cached_tokens: ev.cachedTokens,
                completion_tokens: ev.completionTokens,
                context_tokens: ev.contextTokens,
                provider: ev.provider,
                ...(ev.turnId ? { turn_id: ev.turnId } : {}),
                ...(ev.outcome && ev.outcome !== 'answered' ? { outcome: ev.outcome } : {})
              }
            ])
          )
      } else if (ev.type === 'error') {
        markRunning(ev.chatId, null, false)
        if (!forShownChat) return
        // Keep any partial answer (the main process persists it too), then show the error. An error
        // after `done` (the answer could not be saved) finds no turn left, so it adds only the notice.
        const partial = before?.streaming ?? ''
        // No trace in the error event — the live list has statuses and result previews of its own.
        const failedTrace = before?.live ?? []
        // One commit with the store's update, as for `done`.
        flushSync(() => {
          if (partial) {
            setMessages((m) => [
              ...m,
              { role: 'assistant', content: partial, tools: failedTrace.length ? failedTrace : undefined }
            ])
          }
          setError(ev.message)
        })
      }
    })
    return off
  }, [markRunning])

  // Execute UI-tool requests from the agent and reply (via uiRef so we don't re-subscribe on every render).
  useEffect(() => {
    const off = onUiTool(async (msg) => {
      // Not this panel's: an external session's request (answered by the Workbench and the
      // External-agents drawer), or one of the app-level requests the Workbench owns for everyone.
      if (msg.sessionId || WORKBENCH_UI_TOOLS.has(msg.name)) return
      const u = uiRef.current
      try {
        let result: unknown = { ok: true }
        // The canvas on screen belongs to the active model. A run working on another model (started
        // there, the user has since switched — or two assistants working in parallel) would read or
        // rearrange the wrong canvas. Refused with the reason, as a result the model can act on.
        const shown = activeDbRef.current
        if (CANVAS_TOOLS.has(msg.name) && msg.database && shown && msg.database !== shown) {
          uiResult(msg.reqId, true, { error: canvasElsewhere(msg.database) })
          return
        }
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
          case 'ask_user':
          case 'approve_tool': {
            const questions = msg.name === 'ask_user' ? askQuestions(msg.args) : []
            const approval = msg.name === 'approve_tool' ? approvalOf(msg.args) : null
            if (!questions.length && !approval) {
              uiResult(
                msg.reqId,
                false,
                undefined,
                msg.name === 'ask_user'
                  ? 'ask_user needs a question with at least one option.'
                  : 'approve_tool needs the tool to confirm.'
              )
              return
            }
            const target = msg.chatId ?? chatIdRef.current ?? ''
            const pending = askRef.current
            // A second question from the SAME chat while one pends would deadlock the older run — supersede
            // it. Another chat's question is no replacement: main keeps it open under its own reqId, the
            // toolbar banner lists it, and it comes back with its chat (chat/useRunAdoption.ts). Answering it
            // with an error here ended that run's wait for nothing.
            if (pending && pending.chatId === target)
              uiResult(pending.reqId, false, undefined, 'Superseded by a newer question.')
            // The shown chat's card stays; the new question waits in main until its chat is opened.
            if (pending && pending.chatId !== target && pending.chatId === chatIdRef.current) return
            setAsk({ reqId: msg.reqId, chatId: target, questions, ...(approval ? { approval } : {}) })
            return // resolved later by answerAsk / answerApproval (click or typed answer) or stop()
          }
          case 'set_chat_title': {
            // The run's own chat and model, not whatever is on screen: with the user in another
            // model meanwhile, the old reading renamed THAT model's open chat.
            const db = msg.database ?? activeDbRef.current
            const id = msg.chatId ?? chatIdRef.current
            const title = String(msg.args.title || '').slice(0, 80)
            if (db && id && title) {
              await renameChat(db, id, title).catch(() => {})
              if (db === activeDbRef.current) {
                void listChats(db)
                  .then((r) => setChats(r.chats))
                  .catch(() => {})
              }
            }
            result = { ok: true }
            break
          }
          default:
            result = { error: `Unknown UI tool: ${msg.name}` }
        }
        uiResult(msg.reqId, true, result)
      } catch (e) {
        uiResult(msg.reqId, false, undefined, errMsg(e))
      }
    })
    return off
  }, [])

  /** How far off the bottom still counts as "at the bottom" — a couple of rounded pixels do not. */
  const BOTTOM_SLACK = 24

  const toBottom = useCallback((smooth = false): void => {
    const el = bodyRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    setAtBottom(true)
  }, [])

  // Autoscroll the transcript as it streams — but only while the reader is at the bottom. It used
  // to scroll unconditionally, so reading back through a long run was impossible during one: every
  // token yanked the view down again. Sticking to the bottom is what people want by default and
  // scrolling up is how they say otherwise.
  useEffect(() => {
    if (atBottom) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [messages, streaming, live, atBottom])

  // Opening the panel on an existing chat lands at the newest message, not at the oldest. The
  // transcript is only in the DOM once `open` is true, so this waits a frame for it to be laid out
  // and measurable — and it runs on a chat switch too, for the same reason.
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => toBottom())
    return () => cancelAnimationFrame(id)
  }, [open, chatId, toBottom])

  // `overrideText` sends a message that did not come from the input field (voice transcript);
  // the typed draft is left untouched then.
  const send = useCallback(
    async (overrideText?: string) => {
      // A pending question intercepts the message: typing/speaking is the "Other" answer of ask_user.
      const pendingAsk = askRef.current
      // An approval card is answered by its buttons, never by typed text.
      if (pendingAsk && !pendingAsk.approval && pendingAsk.chatId === chatIdRef.current) {
        if (busy) {
          const answer = (overrideText ?? prefs.input).trim()
          if (!answer) return
          if (!overrideText) typeInput('')
          // Typed text answers the whole form at once — the agent is told it is free text and can
          // re-ask whatever the sentence did not settle.
          answerAsk([[answer]], true)
          return
        }
        setAsk(null) // stale card without a run — fall through to a normal send
      }
      const text = (overrideText ?? prefs.input).trim()
      if (!activeDb) return
      // The run is working: the message is queued in main and reaches the model after its current
      // step (the Claude Code / Cursor pattern) — Stop remains the interruption. Attachments stay in
      // the tray for the next ordinary message; a queued line is words only.
      if (busy) {
        const id = chatIdRef.current
        if (!text || !id) return
        if (!overrideText) typeInput('')
        // Main queues it whether the run is still going or ended this very instant: either way the
        // chip shows it and the chat's next round or next run takes it — nothing is sent on its own,
        // and nothing is lost to the race.
        void aiSteer(id, text).catch((e) => setError(errMsg(e)))
        return
      }
      if (!text && attachments.length === 0) return
      // A send still creating its chat or storing its message holds the next one off BEFORE the box is
      // emptied — a second message typed meanwhile used to be cleared and then dropped.
      if (creatingChat.current || storingMessage.current) return
      setError(null)
      if (!overrideText) typeInput('')
      setOpen(true)
      // Sending is the one moment where being scrolled up should not be honoured: you have just
      // added to the end, and not showing it would look like nothing happened.
      setAtBottom(true)
      let id = chatIdRef.current
      if (!id) {
        // Nothing else says "busy" until the run is marked below, and a second click during createChat
        // made a second chat and a second run for the same message.
        if (creatingChat.current) return
        creatingChat.current = true
        const chat = await createChat(activeDb).catch(() => null)
        if (!chat) {
          creatingChat.current = false
          setError('Could not create the chat.')
          return
        }
        id = chat.id
        // Carry the placeholder of the model this send started on (`activeDb` of this closure, not the
        // one on screen now) over to the new id, and keep what is on screen for it (see useChatPrefs).
        // Before setChatId: the settings effect that id triggers must skip it.
        adopt(id, activeDb)
        creatingChat.current = false
        if (activeDbRef.current === activeDb) {
          setChatId(id)
          chatIdRef.current = id
          void listChats(activeDb)
            .then((r) => setChats(r.chats))
            .catch(() => {})
        }
      }
      // Whether the panel still shows the model this send belongs to. It does not when the model was
      // switched while createChat was in flight: the new chat then exists for the OLD model, and the
      // run it starts is one "elsewhere" — the message is stored, the run is marked and the request
      // goes out, but nothing below may touch the panel, which now belongs to the other model. Send
      // used to jump the panel into that chat and write its message into the shown
      // transcript; switching back to the old model opens the chat with the run (chat/useRunAdoption.ts).
      let shown = activeDbRef.current === activeDb
      // The message stays the prose the user typed, in what we show, what we persist and what goes
      // to the model. The files travel beside it as their own content parts (main/ai/attachments.ts)
      // — which is also what lets the main process match its transcript to this history next turn:
      // the two must be the same string, and inlining a file into it made them differ.
      const att = attachments.filter((a) => a.id && !a.error)
      const sent = att.length ? { attachments: att } : {}
      const history = messages
      // Stored before the run starts. It was fire-and-forget at first: a failed store went
      // unnoticed, the run went out anyway, and main then saved the answer to a question the
      // transcript never held. A local round trip; a second click meanwhile is held off above.
      storingMessage.current = true
      const stored = await appendMessages(activeDb, id, [{ role: 'user', content: text, ...sent }])
        .then(() => null)
        .catch((e: unknown) => errMsg(e))
        .finally(() => {
          storingMessage.current = false
        })
      // The panel may have moved during the round trip — to another model, or to another chat of this
      // one. Either way this send now runs "elsewhere", by the rule above.
      if (activeDbRef.current !== activeDb || chatIdRef.current !== id) shown = false
      if (stored !== null) {
        // Nothing went out: the words go back to the chat they were written in — never over newer
        // typing — and the files stay attached.
        if (!overrideText) {
          if (shown) typeInput((cur) => (cur.trim() ? cur : text))
          else if (!readDraft(id).trim()) writeDraft(id, text)
        }
        if (shown) setError(`Your message could not be saved, so it was not sent: ${stored}`)
        return
      }
      if (shown) setMessages((m) => [...m, { role: 'user', content: text, ...sent }])
      // The store names a new chat after this first message; re-list so the header shows it now, not
      // when the run ends.
      void listChats(activeDb)
        .then((r) => {
          if (shown) setChats(r.chats)
        })
        .catch(() => {})
      // Only the files this message took: one attached during the round trip belongs to the next.
      clearAttachments(attachments)
      markRunning(id, activeDb, true)
      // The turn's view belongs to its chat, shown or not: the clock starts now either way.
      startTurn(id)
      try {
        // From main's store, not from this browser: the cost brake and the disabled tools are
        // guardrails, and main clamps whatever is sent here anyway (see main/settings.ts).
        const as = getAS()
        const { model, researchModel, reviewModel, maxRounds, maxCostUsd, disabledTools, focusTools } = as
        const maxTokens = clampMaxTokens(as.maxTokens)
        // Per-chat toggle vs. app-wide kill switch: the toggle attaches web tools to THIS chat, the
        // kill switch also governs the research sub-agent (which brings its own web search).
        const webAllowed = as.webSearchEnabled
        const allowWeb = prefs.webSearch && webAllowed
        await aiSend({
          chatId: id,
          model,
          activeDb,
          history,
          userText: text,
          ...sent,
          maxRounds,
          maxCostUsd,
          maxTokens,
          disabledTools,
          webSearch: allowWeb,
          webSearchAllowed: webAllowed,
          distancesAllowed: prefs.distancesOn,
          eurostatAllowed: prefs.eurostatOn,
          focusTools,
          researchModel,
          reviewModel,
          backgroundDbs: prefs.searchedBackgrounds,
          withheldBackgrounds: prefs.withheldBackgrounds,
          // Withheld = an empty list, not an absent field: absent would read as "none installed"
          // and the system prompt could not say that the user chose to hold the library back.
          libraryDbs: prefs.useLibrary ? libraryDbs : [],
          // The comparison models this chat keeps on; main fetches one brief per name.
          comparisonModels: prefs.comparisonOn
        })
        void listChats(activeDb)
          .then((r) => {
            if (shown) setChats(r.chats)
          })
          .catch(() => {})
      } catch (e) {
        markRunning(id, null, false)
        if (shown) setError(errMsg(e))
      }
    },
    [
      prefs.input,
      busy,
      markRunning,
      activeDb,
      prefs.searchedBackgrounds,
      prefs.withheldBackgrounds,
      libraryDbs,
      prefs.useLibrary,
      prefs.comparisonOn,
      messages,
      attachments,
      prefs.webSearch,
      prefs.distancesOn,
      prefs.eurostatOn,
      answerAsk,
      typeInput,
      adopt,
      clearAttachments
    ]
  )

  // The recorder's onstop closure outlives renders — always dispatch through the LATEST send so
  // the chat history it snapshots is current (the assistant may have answered while recording).
  const sendRef = useRef(send)
  sendRef.current = send

  /** Mic button: first click starts recording, second click stops + transcribes + sends. */
  const toggleMic = useCallback(async () => {
    if (voice === 'busy') return
    const cur = recRef.current
    if (cur) {
      cur.rec.stop() // onstop stops the tracks and hands the blob to transcription
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      // What the words are about. A model switch during "Transcribing…" swaps `sendRef` for the new
      // model's send, and a spoken change request for A went out as one for B.
      const spokenIn = { db: activeDbRef.current, chat: chatIdRef.current }
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const rec = new MediaRecorder(stream, { mimeType: mime })
      const chunks: Blob[] = []
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data)
      }
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        recRef.current = null
        setVoice('busy')
        void (async () => {
          try {
            const blob = new Blob(chunks, { type: mime })
            const buf = await blob.arrayBuffer()
            if (buf.byteLength < 1_000) throw new Error('Recording too short — try again.')
            // Pinning the language stops Whisper from returning an English TRANSLATION of
            // non-English speech (Settings → AI Chat → Spoken language).
            // From the app settings: Settings writes there, and the old localStorage key it moved out of
            // stayed at whatever it held before the move.
            const lang = getAS().voiceLanguage || defaultVoiceLanguage()
            const { text } = await aiTranscribe(buf, 'webm', lang === 'auto' ? undefined : lang)
            setVoice('idle')
            if (!text) {
              setError('Heard nothing in the recording — please try again.')
              return
            }
            if (activeDbRef.current !== spokenIn.db) {
              if (spokenIn.chat) {
                writeDraft(spokenIn.chat, text)
                setError(
                  'The model changed while transcribing — the text was kept as a draft in the chat it was spoken in.'
                )
              } else {
                setError(`The model changed while transcribing — not sent: “${text}”`)
              }
              return
            }
            const shown = chatIdRef.current
            if (shown && runningRef.current.has(shown) && !askRef.current) {
              // A run is in flight and there is no question to answer — sending now is impossible,
              // so park the transcript in the input instead of dropping it.
              typeInput((v) => (v ? `${v} ${text}` : text))
              return
            }
            void sendRef.current(text) // the transcript goes out as a chat message immediately
          } catch (e) {
            setVoice('idle')
            setError(errMsg(e))
          }
        })()
      }
      rec.start(250) // collect chunks continuously; assembled into one blob on stop
      recRef.current = { rec, stream }
      setVoice('rec')
      setError(null)
      setOpen(true)
    } catch {
      setError('Microphone not available or permission denied.')
    }
  }, [voice, typeInput])

  // Unmounting mid-recording: silently discard the take and release the microphone.
  useEffect(
    () => () => {
      const cur = recRef.current
      if (!cur) return
      recRef.current = null
      cur.rec.onstop = () => cur.stream.getTracks().forEach((t) => t.stop())
      try {
        cur.rec.stop()
      } catch {
        cur.stream.getTracks().forEach((t) => t.stop())
      }
    },
    []
  )

  /** Open a file the user attached, or show it in the file manager. The stored copy in the project
   *  is the durable one: the model's view of an attachment is compacted away long before the chat
   *  is, so this is how a reader gets back to the original. */
  const reveal = useCallback(async (a: AttachmentMeta, inFolder: boolean) => {
    const r = await openSource(a.id, inFolder).catch((e) => ({ error: errMsg(e) }))
    if (r.error) setError(`${a.name}: ${r.error}`)
  }, [])

  /** Continue a stopped run: an ordinary, visible user message through the send path. */
  const continueRun = useCallback((text: string) => {
    void sendRef.current(text)
  }, [])

  // Room for the card beside the dock? The dock's distance from the canvas column's left edge is the
  // space there is; the card needs its width plus the gap and the column's own margin. Measured, not a
  // fixed breakpoint, because the dock's width is a share of the column (min(58%, 660px)).
  useEffect(() => {
    const root = rootRef.current
    const stage = root?.parentElement
    if (!root || !stage || typeof ResizeObserver === 'undefined') return
    const measure = (): void => {
      if (!stage.clientWidth) return
      setPlanWide(root.offsetLeft >= 280 + 12 + 16)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    measure()
    return () => ro.disconnect()
  }, [])

  // A model without the plan tool freezes the plan: collapsed, the pill stays. So does a column that
  // has just become too narrow for the card beside the dock — open, it would now cover the transcript.
  // On the switch (or a chat change) only — the pill still opens the plan for reading.
  useEffect(() => {
    if ((frozen || !planWide) && chatId) setPlanOpen(chatId, false)
  }, [frozen, planWide, chatId, setPlanOpen])

  const stop = useCallback(() => {
    // Cancel the run of the chat ON SCREEN — the Stop button exists only while that one runs. Another
    // chat's run (an assistant working on another model in parallel) is not this button's business.
    // The partial text is kept locally; the main process persists it to the store on abort.
    const running = chatIdRef.current
    if (!running || !runningRef.current.has(running)) return
    const a = askRef.current
    if (a && a.chatId === running) {
      // Belt and braces: main's abort listener also rejects; double settlement is ignored there.
      uiResult(a.reqId, false, undefined, 'Canceled by the user.')
      setAsk(null)
    }
    void aiCancel(running)
    markRunning(running, null, false)
    const partial = turnOf(running)?.streaming ?? ''
    // Taken into the transcript here, so dropped from the store: a later `done` must not add it twice.
    dropTurn(running)
    clearQueued()
    if (partial) setMessages((m) => [...m, { role: 'assistant', content: partial }])
  }, [markRunning, clearQueued])

  const newChat = useCallback(async () => {
    if (!activeDb) return
    const chat = await createChat(activeDb).catch(() => null)
    if (!chat) return
    setChatId(chat.id)
    setMessages([])
    seedPlan(chat.id, null, null)
    clearQueued()
    setError(null)
    setShowChats(false)
    void listChats(activeDb)
      .then((r) => setChats(r.chats))
      .catch(() => {})
  }, [activeDb, clearQueued, seedPlan])

  const openChat = useCallback(
    async (id: string) => {
      if (!activeDb) return
      const mine = ++openSeq.current
      const full = await getChat(activeDb, id).catch(() => null)
      if (!full) return
      // The model or the choice moved on while this was loading: A's transcript under B's model would
      // send the next message with A's history and B's context.
      if (mine !== openSeq.current || activeDbRef.current !== activeDb) return
      // The queued-message chips belong to the chat shown: reopening that one keeps them, as its adoption
      // does not run again to bring them back.
      if (full.id !== chatIdRef.current) clearQueued()
      setChatId(full.id)
      setMessages(full.messages)
      seedPlan(full.id, full.plan, full.run)
      setShowChats(false)
    },
    [activeDb, clearQueued, seedPlan]
  )
  openChatRef.current = openChat

  const removeChat = useCallback(
    async (id: string) => {
      if (!activeDb) return
      if (runningRef.current.has(id)) {
        // Deleting a chat that has a run in flight (possibly paused on a question): abort it.
        void aiCancel(id)
        markRunning(id, null, false)
        dropTurn(id)
        if (id === chatIdRef.current) clearQueued()
      }
      await deleteChat(activeDb, id).catch(() => {})
      const r = await listChats(activeDb).catch(() => ({ chats: [] as ChatSummary[] }))
      setChats(r.chats)
      if (chatIdRef.current === id) {
        setChatId(null)
        setMessages([])
      }
    },
    [activeDb, markRunning, clearQueued]
  )

  // Drag the top edge to resize the transcript.
  const dragRef = useRef(false)
  useEffect(() => {
    const move = (e: MouseEvent): void => {
      if (!dragRef.current) return
      const h = window.innerHeight - e.clientY - 56 // leave room for the input bar
      setHeight(Math.max(180, Math.min(window.innerHeight - 120, h)))
    }
    const up = (): void => {
      dragRef.current = false
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  const askPending = !!ask && !ask.approval && ask.chatId === chatId && busy
  // Runs in flight in chats other than the shown one, for the header's "other runs" (chat/OtherRuns.tsx).
  const elsewhere: OtherRun[] = [...runningRef.current]
    .filter(([id]) => id !== chatId)
    .map(([id, db]) =>
      db && db !== activeDb
        ? { chatId: id, database: db }
        : { chatId: id, database: null, title: chats.find((c) => c.id === id)?.title }
    )
  const planEntry = chatId ? planEntries[chatId] : undefined
  const plan = planEntry?.plan ?? null
  const run = planEntry?.run ?? null
  const planOpen = !!plan && !!planEntry?.open
  const collapsePlan = (): void => {
    if (chatId) setPlanOpen(chatId, false)
  }
  const planCard = (overlay: boolean): JSX.Element | null =>
    plan ? (
      <PlanCard
        plan={plan}
        run={run}
        frozen={frozen}
        overlay={overlay}
        canContinue={!busy}
        fallbackLimit={appSettings.maxCostUsd}
        onContinue={continueRun}
        onCollapse={collapsePlan}
      />
    ) : null
  return (
    <div
      ref={rootRef}
      className={`canvas-chat${open ? ' open' : ''}`}
      /* The same rule as the canvas pane underneath: accept the gesture, and let the drop handler
         ignore a payload that is not a dataset. Anything narrower here would be a second, drifting
         copy of what the pane already decides. The minimap stops its own drops before they get this
         far, because a point on the map means something more specific (see CanvasMinimap). */
      onDragOver={(e) => {
        // Two payloads reach this pane now: a dataset from the search results and files from the
        // desktop. Accepting the gesture for both here and sorting them out on the drop keeps the
        // one rule the canvas underneath already follows.
        const files = Array.from(e.dataTransfer?.types ?? []).includes('Files')
        if (!files && !onDatasetDrop) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (files && !dropping) setDropping(true)
      }}
      onDragLeave={(e) => {
        // Only when the pointer has actually left the panel — dragging across a child fires this too.
        if (dropping && !e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        setDropping(false)
        if (attach.onFileDrop(e)) return
        onDatasetDrop?.(e)
      }}
    >
      {dropping ? <div className="chat-drop-hint">Drop files to attach them</div> : null}
      {/* The plan: a card left of the dock, bottom-aligned, or a pill when collapsed. Where the column
          is too narrow for the card, it opens as an overlay over the transcript instead. */}
      {plan && !planOpen ? (
        <PlanPill plan={plan} run={run} frozen={frozen} onOpen={() => chatId && setPlanOpen(chatId, true)} />
      ) : null}
      {planOpen && planWide ? planCard(false) : null}
      {planOpen && !planWide && !open ? planCard(true) : null}
      {pickingComparison && activeDb ? (
        <ComparisonPicker database={activeDb} onClose={() => setPickingComparison(false)} />
      ) : null}
      {/* One slot, two occupants: the transcript when open, the minimap when not. Neither needs a
          z-index against the other, because only one of them is ever in the tree. */}
      {open ? (
        <div className="chat-panel" style={{ height }}>
          <div className="chat-resize" onMouseDown={() => (dragRef.current = true)} title="Drag to resize" />
          {planOpen && !planWide ? planCard(true) : null}
          <div className="chat-head">
            <button className="chat-head-btn" onClick={() => setShowChats((v) => !v)} title="Switch chat">
              ☰ {chats.find((c) => c.id === chatId)?.title ?? 'New chat'}
            </button>
            <ChatUsage messages={messages} window={windows[currentModel]} />
            <OtherRuns
              runs={elsewhere}
              onOpen={(r) => (r.database ? onGoToChat?.(r.database, r.chatId) : void openChat(r.chatId))}
            />
            <div className="chat-head-spacer" />
            <button className="chat-head-btn" onClick={newChat} title="New chat">
              ＋
            </button>
            <button className="chat-head-btn" onClick={() => setOpen(false)} title="Collapse">
              ✕
            </button>
            {showChats ? (
              <div className="chat-list" onMouseLeave={() => setShowChats(false)}>
                {chats.length === 0 ? <div className="chat-list-empty">No chats yet.</div> : null}
                {chats.map((c) => (
                  <div key={c.id} className={`chat-list-item${c.id === chatId ? ' on' : ''}`}>
                    <button className="chat-list-open" onClick={() => openChat(c.id)}>
                      {c.title || 'New chat'}
                    </button>
                    {runningRef.current.has(c.id) ? (
                      <span className="chat-list-running" title="The assistant is still working in this chat">
                        working
                      </span>
                    ) : null}
                    <button className="chat-list-del" title="Delete chat" onClick={() => removeChat(c.id)}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div
            className="chat-body"
            ref={bodyRef}
            onScroll={(e) => {
              const el = e.currentTarget
              const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK
              // Only on a change: this fires on every scrolled pixel, and a setState per pixel
              // re-renders a transcript that can be hundreds of nodes long.
              setAtBottom((was) => (was === bottom ? was : bottom))
            }}
          >
            {busy ? <RunStatus turn={turn} labels={toolLabels} /> : null}
            {messages.length === 0 && !streaming ? (
              <div className="chat-hint">
                Ask about your model or the data, or tell me to build/change something. I can search
                ecoinvent, edit processes, tag, calculate and set up results.
              </div>
            ) : null}
            {messages.map((m, i) => (
              <MessageRow key={i} m={m} labels={toolLabels} onJump={jump} onReveal={reveal} />
            ))}
            {/* Without a plan, Continue sits under the stop note in the transcript. */}
            {!plan && resumable(run) && !live.length && !streaming ? (
              <div className="chat-continue">
                {run.outcome === 'interrupted' ? (
                  <span className="chat-continue-why">{runReason(run.outcome)}</span>
                ) : null}
                <ContinueButton
                  run={run}
                  hasPlan={false}
                  disabled={busy}
                  fallbackLimit={appSettings.maxCostUsd}
                  onContinue={continueRun}
                />
              </div>
            ) : null}
            {live.length ? (
              <div className="chat-msg assistant">
                <ToolTraceList traces={live} started={turn.started} labels={toolLabels} running={busy} />
              </div>
            ) : null}
            {streaming ? (
              <div className="chat-msg assistant">
                <Markdown text={streaming} onJump={jump} />
              </div>
            ) : null}
            {ask && ask.chatId === chatId ? (
              ask.approval ? (
                <ChatApprovalCard
                  key={ask.reqId}
                  ask={ask as PendingAsk & { approval: ApprovalRequest }}
                  label={toolLabels[ask.approval.tool] ?? ask.approval.tool}
                  onAnswer={answerApproval}
                />
              ) : (
                <AskUserCard key={ask.reqId} ask={ask} onAnswer={answerAsk} />
              )
            ) : null}
            {/* The model is working and nothing else on screen says so: no text streaming yet, and no
                tool row left pulsing. That is not only the first round — it is also every gap between
                two rounds, where the last call has returned and the next token has not arrived. The old
                condition was `!live.length`, so from the second round on those gaps showed nothing at
                all, and what it showed was a single grey ellipsis at 12px that was easy to
                miss entirely. */}
            {busy && !streaming && !live.some((t) => !t.status) ? (
              <div className="chat-thinking" aria-label="Working">
                <i />
                <i />
                <i />
              </div>
            ) : null}
            {error ? <div className="chat-error">{error}</div> : null}
          </div>
          {/* The way back down, in the place every chat app puts it. It exists because the
              transcript no longer drags the reader along: scrolled up during a run, you would
              otherwise have to find the end by hand while it keeps growing. Hidden at the bottom —
              a button that says "go where you already are" is furniture. */}
          {!atBottom ? (
            <button
              className="chat-jump"
              title="Jump to the newest message"
              aria-label="Jump to the newest message"
              onClick={() => toBottom(true)}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                <path
                  d="M8 3v9m0 0 3.5-3.5M8 12 4.5 8.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
        </div>
      ) : (
        (aboveBar ?? null)
      )}
      <ChatComposer
        activeDb={activeDb}
        prefs={prefs}
        attachments={attach}
        comparedWith={comparedWith}
        backgroundDbs={backgroundDbs}
        libraryDbs={libraryDbs}
        busy={busy}
        askPending={askPending}
        queued={queued}
        onUnsteer={(i) => {
          const id = chatIdRef.current
          if (id) void aiUnsteer(id, i).catch(() => {})
        }}
        voice={voice}
        onToggleMic={() => void toggleMic()}
        onSend={() => void send()}
        onStop={stop}
        onOpen={() => setOpen(true)}
        onPickComparison={() => setPickingComparison(true)}
        onOpenSettings={onOpenSettings}
      />
    </div>
  )
}
