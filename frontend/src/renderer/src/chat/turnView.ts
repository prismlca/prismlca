import { useEffect, useSyncExternalStore } from 'react'
import { onAiEvent, type AiEvent, type ToolTrace } from '../lib/ai'

export interface ContextLevel {
  tokens: number
  window?: number
  budget: number
}

/**
 * What the turn in flight looks like so far: the text streamed, the tool rows, the thinking state.
 * The renderer assembles it from the run's events — main sends the full trace only with `done`.
 */
export interface TurnView {
  streaming: string
  live: ToolTrace[]
  /** When each row of `live` started (epoch ms), in the same order — the rows' clocks count from it. */
  started: number[]
  /**
   * Characters of reasoning in the round now running; 0 once it writes or calls a tool. A reasoning
   * model can be silent for minutes, and "Thinking" with a clock looks the same whether it is working
   * or wedged — this is the difference, without putting the chain of thought on screen.
   */
  reasoning: number
  /** How many rounds this turn threw away and began again. */
  restarts: number
  context: ContextLevel | null
  /**
   * When the current thinking phase began: the turn's start, a restarted round, or the last call's end.
   * Unknown for a run this window has seen nothing of yet (adopted after a reload) — the clock then
   * counts from when it appeared, never from the epoch.
   */
  thinkingAt?: number
  /**
   * The run this view belongs to, once its `run` event has named it. `null` = begun by a send here
   * whose run has not reported yet; absent = assembled from stray events (a reload, a tail after Stop).
   */
  runId?: string | null
}

export const emptyTurn = (now?: number): TurnView => ({
  streaming: '',
  live: [],
  started: [],
  reasoning: 0,
  restarts: 0,
  context: null,
  thinkingAt: now
})

/** Index of the newest row of this tool still waiting for its outcome, or -1. */
const openRow = (live: ToolTrace[], name: string): number =>
  live.map((t) => !t.status && t.name === name).lastIndexOf(true)

/**
 * One event folded into the chat's view; `undefined` = no turn in flight. Pure, for the tests.
 *
 * `done` and `error` end the turn and drop the view. Main can send an `error` AFTER `done` (the answer
 * could not be saved) and relies on the renderer holding no partial text by then — a view kept past
 * `done` would put the answer into the transcript twice.
 *
 * A stopped run sends neither: its end is the `run` event that leaves 'running'. That one drops the
 * view too — a delta already in flight when Stop was pressed lands after Stop dropped the view and
 * would otherwise stand as a turn forever — unless the view is a newer send's, still waiting for its
 * own run to report.
 */
export function foldTurn(prev: TurnView | undefined, ev: AiEvent, now: number): TurnView | undefined {
  if (ev.type === 'done' || ev.type === 'error') return undefined
  if (ev.type === 'run') {
    if (ev.run.state === 'running') return { ...(prev ?? emptyTurn(now)), runId: ev.run.runId }
    const newer = prev && (prev.runId === null || (prev.runId && prev.runId !== ev.run.runId))
    return newer ? prev : undefined
  }
  const shown = ['delta', 'reasoning', 'context', 'round-restart', 'tool'].includes(ev.type)
  if (!shown) return prev
  // A run this window did not see start (a reload): its view begins with what arrives now.
  const v = prev ?? emptyTurn(now)
  switch (ev.type) {
    case 'delta':
      // Visible output supersedes the thinking note: the round is writing now. And it supersedes the
      // restart note: that note describes a round that returned nothing, and this round is visibly
      // returning something. Left standing, a single retry in minute 6 read as a recurring failure for
      // the remaining 48 minutes of a run (V283). The log line in the main process is the durable record.
      return { ...v, streaming: v.streaming + ev.text, reasoning: 0, restarts: 0 }
    case 'reasoning':
      return { ...v, reasoning: ev.chars }
    case 'context':
      return { ...v, context: { tokens: ev.tokens, window: ev.window, budget: ev.budget } }
    case 'round-restart':
      // The round is starting over, so the clock has to as well — otherwise it keeps timing an attempt
      // whose reasoning has already been discarded, and the two numbers on that line stop describing
      // the same thing.
      return { ...v, reasoning: 0, restarts: v.restarts + 1, thinkingAt: now }
    case 'tool': {
      if (ev.phase === 'start')
        // A tool call is the round doing real work — the restart note has served its purpose (V283).
        return {
          ...v,
          reasoning: 0,
          restarts: 0,
          live: [...v.live, { name: ev.name, args: ev.args }],
          started: [...v.started, now]
        }
      const idx = openRow(v.live, ev.name)
      if (idx < 0) return { ...v, reasoning: 0 }
      const live = [...v.live]
      if (ev.phase === 'progress') {
        // A note from a call still running: it replaces the previous note rather than piling up, so
        // the row says where the work IS, not everywhere it has been.
        live[idx] = { ...live[idx], detail: ev.detail }
        return { ...v, reasoning: 0, live }
      }
      // Close the newest still-open row for this tool. A returned refusal ('soft') counts as rejected —
      // the model was told no, which is precisely what should be visible. Duration and result land here,
      // not only in the turn's closing trace: on a long run the finished rows are the only place to read
      // what a call returned while the rest of the turn is still going.
      live[idx] = {
        ...live[idx],
        status: ev.phase === 'error' ? 'error' : ev.soft ? 'rejected' : 'ok',
        detail: ev.phase === 'error' ? ev.detail : ev.soft,
        ms: ev.ms,
        preview: ev.preview,
        resultChars: ev.resultChars,
        itemsFailed: ev.itemsFailed,
        notice: ev.notice
      }
      return { ...v, reasoning: 0, live, thinkingAt: now }
    }
    default:
      return v
  }
}

/**
 * The turn in flight of every chat, kept outside the chat panel.
 *
 * The panel is unmounted on every view but Model, and while it shows another model it shows another
 * chat. Its own state therefore missed every event of a run it was not showing: back from Results, a
 * run in minute twelve showed only the calls made since, its clocks started at zero, and the full
 * list came back only with `done`. This store hears every event for as long as anything holds the
 * feed — the Workbench for the app's lifetime — so the panel finds the whole turn when it returns.
 * A window reload still starts empty: the turn so far lives in no store but this one.
 */
const turns = new Map<string, TurnView>()
const viewers = new Set<() => void>()
/** Listeners to every event, each told the chat's turn as it stood BEFORE the event (see onChatEvent). */
const eventListeners = new Set<(ev: AiEvent, before: TurnView | undefined) => void>()
let holders = 0
let unsubscribe: (() => void) | null = null

function publish(): void {
  for (const fn of viewers) fn()
}

/** How many runs of each chat have ended (`done` or `error`), and how often its queue was reported (`steer`). */
const ended = new Map<string, number>()
const steered = new Map<string, number>()

/** How many runs of ``chatId`` have ended so far. A snapshot asked for before a run ended can tell from it
 *  that it is out of date: "running", or a question, read before `done` and arriving after it, describe a
 *  run that is over. */
export function runsEnded(chatId: string): number {
  return ended.get(chatId) ?? 0
}

/** How often the queue of ``chatId`` was reported — a queue read before the last report is older than it. */
export function queueReports(chatId: string): number {
  return steered.get(chatId) ?? 0
}

export function handleTurnEvent(ev: AiEvent, now: number = Date.now()): void {
  if (ev.type === 'done' || ev.type === 'error') ended.set(ev.chatId, runsEnded(ev.chatId) + 1)
  if (ev.type === 'steer') steered.set(ev.chatId, queueReports(ev.chatId) + 1)
  const prev = turns.get(ev.chatId)
  const next = foldTurn(prev, ev, now)
  if (next !== prev) {
    if (next) turns.set(ev.chatId, next)
    else turns.delete(ev.chatId)
    publish()
  }
  for (const fn of eventListeners) fn(ev, prev)
}

/**
 * Every assistant event, with the chat's turn as it stood before it — what a `done` or `error`
 * handler needs, since that event has already dropped the turn from the store. Heard only while the
 * feed is held (useTurnFeed), so a subscriber holds it too.
 */
export function onChatEvent(cb: (ev: AiEvent, before: TurnView | undefined) => void): () => void {
  eventListeners.add(cb)
  return () => eventListeners.delete(cb)
}

/** A send begins a turn: a fresh view, its thinking clock from now, its run yet to report. */
export function startTurn(chatId: string, now: number = Date.now()): void {
  turns.set(chatId, { ...emptyTurn(now), runId: null })
  publish()
}

/** Forget the chat's turn: Stop has taken its text into the transcript, or the chat is deleted. */
export function dropTurn(chatId: string): void {
  if (turns.delete(chatId)) publish()
}

export function turnOf(chatId: string | null): TurnView | undefined {
  return chatId ? turns.get(chatId) : undefined
}

const NONE = emptyTurn()
const subscribe = (fn: () => void): (() => void) => {
  viewers.add(fn)
  return () => viewers.delete(fn)
}

/** The chat's turn for display: the empty view when none is in flight. */
export function useTurnView(chatId: string | null): TurnView {
  return useSyncExternalStore(subscribe, () => turnOf(chatId) ?? NONE)
}

/**
 * Keep the store listening while the caller is mounted. Counted, so the Workbench and the panel can
 * both hold it; when the last one lets go nothing keeps the views current, and they are dropped.
 */
export function useTurnFeed(): void {
  useEffect(() => {
    if (holders++ === 0) unsubscribe = onAiEvent((ev) => handleTurnEvent(ev))
    return () => {
      if (--holders > 0) return
      unsubscribe?.()
      unsubscribe = null
      turns.clear()
      publish()
    }
  }, [])
}
