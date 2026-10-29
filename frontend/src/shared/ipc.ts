/**
 * The payload types that cross the IPC bridge — main, preload and renderer read the SAME definition.
 *
 * Each of these used to exist two or three times ("mirror of X in main/…, the preload boundary will
 * not let us import it"), and the copies drifted exactly as copies do: the renderer's `AiEvent` had
 * already fallen behind on the token counts once and was missing the `provider` event entirely when
 * the copies were folded in here. The old comments' premise was wrong — what the boundary cannot
 * share is *runtime values*; type-only imports are erased at compile time, and `src/shared` is
 * compiled into both bundles (listed in tsconfig.node.json AND tsconfig.web.json, see aiDefaults.ts).
 *
 * Same constraints as everything in shared/: type declarations and pure values only — no Node APIs,
 * no DOM APIs, no imports that exist on only one side.
 */
import type { ChatPlan, ChatRun, RunOutcome } from './plan'
import type { ReasoningEffort } from './aiDefaults'

import type { TransportSettings } from './distanceDefaults'
import type { DisplaySettings } from './displayDefaults'
import type { RecentModel } from './startPage'

/**
 * What one tool call did. Collected in the main process (agent.ts) and persisted with the assistant
 * turn, so an expandable trace is available live AND after a reload. `resultChars` is the real length
 * of the result — `preview` is capped for storage, and the UI says how much it is not showing.
 *
 * `status` and `ms` are optional because the shape serves two moments of the same row: a COMPLETED
 * trace entry (the collector always writes both) and the renderer's in-flight row, where a missing
 * `status` is what "still running" looks like (CanvasChat keys its pending logic on `!t.status`).
 */
export interface ToolTrace {
  name: string
  args?: string
  status?: 'ok' | 'rejected' | 'error'
  /** Why it failed, or the refusal the tool returned. */
  detail?: string
  preview?: string
  /** Length of the untruncated result, so the UI can say how much it is not showing. */
  resultChars?: number
  /** Items of a BATCH call that failed while the call itself succeeded — the one shape where the
   *  call is 'ok' and part of the work is not. */
  itemsFailed?: number
  ms?: number
  /** A line the row shows even when collapsed — the attribution a data provider requires to be
   *  displayed (the distances tool: openrouteservice / OpenStreetMap / Mapbox). */
  notice?: string
}

export type AgentEvent =
  | { chatId: string; type: 'delta'; text: string }
  // `args` rides along so a failure is diagnosable at all — "HTTP 422" alone says nothing about WHY
  // the model's call was wrong. `soft` carries a refusal the tool RETURNED rather than threw
  // (`{"error": …}`): the model was told no just the same, so anything counting mistakes has to see
  // it — otherwise a model looping on rejected calls looks perfectly healthy.
  | {
      chatId: string
      type: 'tool'
      name: string
      // 'progress' is a note from a call still in flight — a research leg saying which component it is
      // on. Without it a sub-agent that runs for minutes shows a pulse and a seconds counter and
      // nothing else, which is indistinguishable from a hang.
      phase: 'start' | 'progress' | 'done' | 'error'
      detail?: string
      args?: string
      soft?: string
      // What the call took and what it returned, on 'done'. These used to travel only in the turn's
      // final trace array, so during a long turn you could see WHICH calls had finished but not what
      // any of them said — on a 17-minute run that is exactly when you want to read the one that
      // just came back. Same fields as ToolTrace so the renderer can fill the row in place.
      ms?: number
      preview?: string
      resultChars?: number
      itemsFailed?: number
      notice?: string
    }
  // The model is thinking and has produced this many characters of reasoning in the current round.
  // Only the count crosses the wire — never the text; see StreamEvent in providers/types.ts.
  | { chatId: string; type: 'reasoning'; chars: number }
  /**
   * The round was abandoned and begun again — today only because the provider returned an empty
   * completion. The renderer restarts its "thinking" clock on this, so the elapsed time next to the
   * reasoning count belongs to the same attempt as the count. Without it the two were different
   * clocks: "reasoning, 0.8k characters · 6:08 min" was a real line, 8 seconds of reasoning beside
   * the age of a thinking state that had already thrown one response away.
   */
  | { chatId: string; type: 'round-restart'; reason: 'empty' }
  /**
   * How full the model's context is, after every round: the prompt size the provider counted for
   * the request just answered, the model's window (absent when the catalogue does not know it) and
   * the size at which older tool results are condensed. The run bar draws a meter from it.
   */
  | { chatId: string; type: 'context'; tokens: number; window?: number; budget: number }
  /** Which OpenRouter endpoint served this turn. Sent once, as soon as the first chunk names it. */
  | { chatId: string; type: 'provider'; name: string }
  // A mutating tool ran — the renderer should reload the canvas. `database` names the model the run
  // edits, so a canvas showing ANOTHER model (two assistants working in parallel) is left alone.
  /** A write happened; `graph === false` says the canvas graph itself did not change (study
   *  metadata, scenarios, results set-up), so only the caches reload, not the drawing. `structure`
   *  says boxes or arrows came or went — the chat fits the canvas to the view when the turn ends. */
  | { chatId: string; type: 'refresh'; database?: string; graph?: boolean; structure?: boolean }
  // Token counts ride along on 'done' so evals (and, later, the cost panel) can report prompt size
  // and how much of it the provider served from its prefix cache.
  | {
      chatId: string
      type: 'done'
      text: string
      cost?: number
      promptTokens?: number
      cachedTokens?: number
      /** Output tokens, reasoning included — the half the price hangs on. Sent so the chat header can
       *  say what a conversation has consumed; the monthly per-model total cannot, because it cannot
       *  tell two chats apart. */
      completionTokens?: number
      /** The OpenRouter endpoint that served the turn — the thing that explains why one run is
       *  four times slower than the next on the same model (V22). */
      provider?: string
      /** The prompt size of the last round — the context level the turn ended at (a level, not the sum). */
      contextTokens?: number
      /** The turn's tool trace, so the renderer can attach it to the message it just completed
       *  (the live events carry no results — sending 30k-char payloads per call would be wasteful). */
      trace?: ToolTrace[]
      /** How the run ended — structured; the italic note in `text` is for the reader, this is for code. */
      outcome?: RunOutcome
      turnId?: string
    }
  | { chatId: string; type: 'error'; message: string; code?: string }
  /**
   * The run put a question to the user (ask_user) — and, later, stopped waiting for the answer,
   * whichever way (answered, cancelled, timed out). The Workbench keeps a banner per open question
   * from these, so a question asked while the user is in another model or another view is not
   * missed; `ai:pendingAsks` is the same record, for a renderer that mounts after the fact.
   */
  | { chatId: string; type: 'ask'; ask: PendingAsk }
  | { chatId: string; type: 'ask-settled'; reqId: string }
  /**
   * The chat's plan changed (an accepted `plan` call; `null` = withdrawn) or its run state moved
   * (started, stopped with an outcome). The renderer draws the card from these and from the stored
   * chat — the store is the truth, the event says "look again".
   */
  | { chatId: string; type: 'plan'; plan: ChatPlan | null }
  | { chatId: string; type: 'run'; run: ChatRun }
  /**
   * The messages the user typed while the run was working, still waiting to be handed to the model
   * (main/ipc/chat.ts `steers`). Sent whenever the queue changes; empty once the loop took them.
   */
  | { chatId: string; type: 'steer'; queued: string[] }

/** A question the assistant is waiting on — see main/ai/pendingAsks.ts. */
export interface PendingAsk {
  reqId: string
  chatId: string
  /** The model the asking run works on; null for a run without one. */
  database: string | null
  /** The ask_user arguments as the model sent them — the chat panel normalises them into a card. */
  args: Record<string, unknown>
  /** When it was asked (ms since epoch). */
  since: number
  /** Who is asking: a chat run (absent = chat, the older shape) or an external-agent session (MCP). */
  origin?: 'chat' | 'mcp'
  /** The external session, when `origin` is 'mcp' — the Workbench routes the card by it, not by chat. */
  sessionId?: string
  /** What the external client calls itself, for the card ("Claude Code is asking…"). */
  clientName?: string
  /** A question (default) or a "may this tool run?" card from the session's approval mode. */
  kind?: 'ask' | 'approval'
}

/**
 * What the writer is doing right now — the only thing a caller can say during the minutes it takes.
 *
 * A single chapter took 158 s and 385 s in practice runs, and all a caller could show
 * was a spinner: the same picture for "the model is thinking", "the gate refused it and it is being
 * revised" and "the stream died". The union is deliberately small — a phase the author cannot act on
 * or check against the clock is noise. `chars` is cumulative WITHIN one stream and resets when a new
 * one starts, which is why the phase travels with it: a count that halves is only confusing if the
 * label beside it has not changed.
 */
export type WritePhase =
  /** The request is open and nothing at all has come back — a provider queue, or a rate limit. */
  | { phase: 'sent' }
  /** The chapter's brief is being computed on the backend (results snapshot) — before any model call (V422). */
  | { phase: 'brief' }
  /**
   * Reasoning has arrived, so the model is demonstrably working rather than merely not answering.
   * `chars` is how much of it; the two are separate phases because "waiting" and "thinking" are
   * different problems, and only the reasoning ticks can tell them apart.
   */
  | { phase: 'thinking'; chars: number }
  | { phase: 'writing'; chars: number }
  /** `spent` of `allowance` lookups used, this one included: it bounds the round trips still to come. */
  | { phase: 'lookup'; name: string; spent: number; allowance: number }
  | { phase: 'checking' }
  /** The gate refused the text and the writer is fixing it. `attempt` counts from 2. */
  | { phase: 'revising'; attempt: number }
  /** The second reader is reading the chapter; `round` counts its readings from 1. */
  | { phase: 'reviewing'; round: number }

/** A WritePhase on the wire. `id` is stamped on by a "Write all" run, whose four lanes would
 *  otherwise all speak for the same status line; a chapter written on its own arrives without one. */
export type WritePhaseEvent = { id?: string } & WritePhase

/**
 * A file the user attached to a chat message, as everyone but the model sees it.
 *
 * The bytes never travel on this bridge: the renderer hands over paths, main reads them and the
 * backend stores them under the project's `prism_meta/sources/`. What crosses is this description —
 * enough for the chip above the input, for the persisted message, and for the stub that replaces an
 * attachment once the context has been compacted.
 *
 * `id` is content-derived, so the same file attached twice is the same attachment.
 */
export interface AttachmentMeta {
  id: string
  /** The name the user knows it by — the stored file has a sanitised one. */
  name: string
  /** Which route it takes to the model: 'pdf' and 'image' go natively, the rest becomes text. */
  kind: 'pdf' | 'image' | 'sheet' | 'text' | 'document'
  bytes: number
  pages?: number
  chars?: number
  sheets?: Array<{ name: string; rows: number; columns: number }>
  /** Non-empty when this file is big enough that the user should know before sending. */
  warning?: string
  /** Set instead of the rest when the file could not be attached at all. */
  error?: string
}

/** What the gate objected to. Shown to the author when a revision could not fix it. */
export interface Finding {
  kind: string
  detail: string
}

/** One lookup and what it returned — handed to the gate, which only accepts facts we supplied. */
export interface Lookup {
  name: string
  args: string
  result: string
}

/** One point the second reader raised about a chapter, and how it ended. `quote` is the chapter's
 *  own words as printed; `open` points are what the author sees. */
export interface ReviewIssue {
  quote: string
  problem: string
  evidence?: string
  fix?: string
  status: 'resolved' | 'false_positive' | 'open'
  resolution?: string
}

/** Something only the author can settle — asked with the reader's own proposal for an answer. */
export interface ReviewQuestion {
  id: string
  question: string
  why?: string
  proposal?: string
  options?: string[]
}

/** What writer and second reader settled about one chapter (stored with it as `ai_review`). */
export interface ChapterReview {
  reviewer: string
  rounds: number
  issues: ReviewIssue[]
  questions: ReviewQuestion[]
  /** Per hint kind of the automatic word check: how often the reader had it fixed, or let it stand. */
  hints: Record<string, { fixed?: number; dismissed?: number }>
}

/** One chapter's fate in a "Write all" run — everything the panel needs to show it. */
export interface WriteAllOutcome {
  id: string
  /** The gate accepted and the backend stored it. False = refused (draft) or failed (see `error`). */
  stored: boolean
  text?: string
  model?: string
  lookups?: Lookup[]
  figure?: Record<string, unknown> | null
  findings: Finding[]
  attempts?: number
  /** Set when the chapter never reached the gate — cancelled, stream lost, backend away. */
  error?: string
  /** The answer did not end properly (no finish, cut off, empty) or the run was stopped with text in
   *  hand: `text` is an unchecked draft and `findings` says why. */
  incomplete?: boolean
  /** The second reading, when one ran. */
  review?: ChapterReview | null
  /** An update's outcome: edited, or found still right as it stood. */
  update?: 'edited' | 'unchanged'
}

/** What the renderer may know about a provider key. Deliberately not the key: it stays in the main
 *  process, and `hint` is a mask (`sk-or-v…1f4c`) so two accounts can be told apart, no more.
 *
 *  `source` says which of the four places the key actually came from — `'env'` (the env var, which
 *  wins over everything), `'stored'` (the OS credential store, the only one Settings can remove),
 *  `'devfile'` (a working copy's `.secrets/` file). Settings has to name it: a key it cannot see
 *  reads as "no key", and a key it cannot remove must not offer a Remove button. `trusted` is false
 *  when the OS gave us no real credential store (a Linux box with no keyring), where "encrypted at
 *  rest" would be a lie: Chromium's fallback obfuscates with a hard-coded password. */
export interface KeyStatus {
  present: boolean
  hint: string
  source: 'env' | 'stored' | 'devfile' | 'none'
  backend: string
  trusted: boolean
  available: boolean
}

/** The MCP server for external agents (main/mcp) — what the renderer's panel and settings see. */
export type McpApprovalMode = 'every-write' | 'irreversible' | 'never'

export interface McpCallRecord {
  n: number
  tool: string
  /** The arguments, JSON, cut to a preview. */
  args: string
  ok: boolean
  /** A refusal the tool returned (ok is still true: the tool answered). */
  soft?: string
  error?: string
  ms: number
  at: number
  effect: 'read' | 'write' | 'irreversible'
}

export interface McpSessionSnapshot {
  id: string
  /** The project the session was opened on (null = the backend named none). */
  project: string | null
  clientName: string
  clientVersion: string
  startedAt: number
  lastSeen: number
  activeDb: string | null
  approval: McpApprovalMode
  calls: number
  recent: McpCallRecord[]
}

export interface McpStatus {
  running: boolean
  url: string | null
  /** Only while running; the Settings page shows it for the developer route (Claude Code direct). */
  token: string | null
  sessions: McpSessionSnapshot[]
}

export type McpClientId = 'claude-code' | 'codex' | 'claude-desktop'

/** One client's configuration as Settings shows it (main/ipc/mcp.ts + main/mcp/clientConfig.ts). */
export interface McpClientConfig {
  id: McpClientId
  label: string
  /** The file, as the user knows it. */
  configHint: string
  /** The resolved path on this machine. */
  configPath: string
  /** Does the file exist? (The client may still be installed; its folder may be missing too.) */
  exists: boolean
  /** Does the file already carry exactly our entry? */
  configured: boolean
  /** The text to paste by hand. */
  snippet: string
  /** The whole file after our change — shown before writing. Absent when the file could not be merged. */
  proposed?: string
  proposedError?: string
}

export type McpConfigureResult =
  | { ok: true; path: string; backup: string | null }
  | { ok: false; error: string }

export type McpTestResult =
  | { ok: true; tools: number; version: string; ms: number }
  | { ok: false; error: string }

export type McpEvent =
  | { type: 'status'; running: boolean; url: string | null }
  | { type: 'sessions'; sessions: McpSessionSnapshot[] }
  /** An external agent changed this model: the canvas showing it must reload. */
  | { type: 'refresh'; database: string | null }

export interface AppSettings {
  /**
   * Which API serves the assistant: OpenRouter (one key, many labs, ZDR routing) or OpenAI
   * directly. A GLOBAL switch, not per model — the model pickers below show only the active
   * provider's catalogue, and stored ids from the other provider stay stored but read as ''
   * (= the role's default) while it is inactive. Keys for both providers stay stored in parallel;
   * switching never clears either one.
   */
  provider: 'openrouter' | 'openai'
  /** Chat model id, and the model that writes report chapters ('' = follow the chat model). */
  model: string
  writerModel: string
  /** Model for the research legs (`research_web`, `research_bom`); '' = their own default.
   *
   * Two separate keys, because the two jobs are not one job: research wants
   * cheap and web-capable and runs many parallel legs, the review is worth most when it is a
   * SECOND opinion and therefore a different model from the chat. An older file that set only
   * `researchModel` keeps governing the reviewer too (see getSettings), so nobody's configuration
   * changes meaning. A third key, `summaryModel`, named the model that condenses tool output
   * dropped under context pressure; retired — the summary replaces what the chat model
   * read, so the chat model writes it (a weaker one losing a number costs a re-fetch, which is
   * more than the cents a cheap model saves). A stored value is read and ignored. */
  researchModel: string
  /** Model for `review_model`; '' = follow researchModel if that is set, else its own default. */
  reviewModel: string
  /** Model that matches imported flows onto our vocabulary; '' = follow researchModel.
   *
   * A fifth key rather than reusing one of the four, because the job is unlike all of them: bulk
   * classification over a shortlist, one short answer per item, thousands of items in one import.
   * The cheapest capable model wins here, and that choice should not be tied to the chat. */
  matchModel: string
  /** The guardrails: what one run may spend, how many tool rounds it may take, how long a reply. */
  maxCostUsd: number
  maxRounds: number
  /** One reply's ceiling for the chat, the import matcher, research and review. */
  maxTokens: number
  /** One reply's ceiling for the report writer — chapters, outline, translation (larger by default). */
  writerMaxTokens: number
  /** How many questions one research_web call may research in parallel. Each is a separate paid
   *  sub-agent, so this is a cost guardrail, not a preference — see aiDefaults. */
  maxResearchQuestions: number
  /** Preferred provider throughput in tokens/second; 0 = express no preference. Unlike the limits
   *  above this cannot block a request — it only says which endpoints we would rather have. */
  minThroughput: number
  /** Tools the user switched off — a guardrail, not a preference. */
  disabledTools: string[]
  /** Route chat traffic to providers that do not retain it. */
  zeroDataRetention: boolean
  /** Vendors exempted from the zero-retention rule above (their models route as before). */
  zdrExceptAnthropic: boolean
  zdrExceptOpenai: boolean
  zdrExceptGoogle: boolean
  focusTools: boolean
  voiceEnabled: boolean
  voiceLanguage: string
  webSearchEnabled: boolean
  /** How many web lookups (searches + page fetches, each) the provider may run inside ONE reply;
   *  each one re-runs the conversation through the model. 0 = the provider's own default (V398). */
  webLookupsPerAnswer: number
  /** Offer the assistant Eurostat's waste statistics (`eurostat_eol`); the chat's "+" menu narrows it per chat. */
  eurostatEnabled: boolean
  /** Dictionaries spell checking runs with (see shared/spellcheck.ts); [] = checking off. */
  spellcheckLanguages: string[]
  /** Which background database the assistant should take when several are released to a chat and
   *  more than one has a fitting dataset: a database name, or '' = let the assistant decide and say
   *  why. Applies only while that database is switched on in the chat. */
  preferredBackground: string
  /** Transport distances: geocoder, GLEC adjustments, call limits, the panel's recent lookups.
   *  The first nested group in this file — sanitised field by field in main/settings.ts via
   *  `sanitiseTransport`, and always written as a whole (setSettings merges shallowly). */
  transport: TransportSettings
  /** Rounding and unit acceptance — the Display and Modelling panels (see shared/displayDefaults.ts). */
  display: DisplaySettings
  /** Has somebody clicked the welcome tour through to its last card and pressed Finish?
   *
   *  Set only there — not by closing, not by a checkbox. The tour has no skip on purpose, so "false" means
   *  the last card was never reached, and the tour is owed another showing on the next start. Living in the
   *  settings FILE rather than localStorage matters here:
   *  the browser store is origin-scoped, so a dev port change would re-run the tour forever. */
  welcomeTourDone: boolean
  /** May the start page fetch the project news (prismlca.com) on its own, once per app session?
   *  False by default: nothing leaves the machine for the news card until the user clicks its button
   *  or switches this on (Settings → Display, or the tour's last card). */
  newsAutoLoad: boolean
  /** Hold off the computer's idle sleep while long work runs — an import, a search index, an
   *  assistant or report-writer run (main/keepAwake.ts). On by default; only while plugged in. */
  keepAwake: boolean
  /** The models the user opened lately, newest first (see shared/startPage.ts). Written whole —
   *  setSettings merges shallowly — by lib/recentModels.ts; the start page's "Last models" card reads it. */
  recentModels: RecentModel[]
  /** The MCP server for external agents (Settings → AI → External agents). Off by default: nothing
   *  listens, and no data leaves through a client, until the user switches it on. */
  mcpEnabled: boolean
  /** The chat's confirmation card before irreversible tool actions (main/ai/approval.ts):
   *  'irreversible' (default) shows it, 'never' lets the model act and tells it to confirm itself. */
  chatApproval: 'irreversible' | 'never'
  /** Reasoning effort per chat model id (shared/aiDefaults.ts); a model not listed sends nothing,
   *  i.e. runs on its API's default. Offered levels come from the catalogue row (`reasoningEfforts`). */
  reasoningEffort: Record<string, ReasoningEffort>
}

/**
 * The actionable half of an error that crossed the IPC bridge, in the words the user can act on.
 *
 * Electron wraps anything a `ipcMain.handle` handler throws: the renderer receives `Error invoking
 * remote method 'ai:writeAll': Error: OpenRouter credits exhausted — please top up (…)`. The
 * half that matters is at the end; the plumbing in front of it is noise in a dialog. Every invoke
 * channel gets this wrapping, which is why the peeling lives here beside the channel types and not
 * in one view. Honest limitation: this parses Electron's message format because Electron offers no
 * structured error across the bridge — if that format ever changes, the fallback keeps the full
 * (noisier) message rather than losing it.
 */
export function ipcErrorReason(e: unknown, fallback: string): string {
  const raw = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').trim()
  if (!raw) return fallback
  // Peel `Error invoking remote method '…':` and any number of leading `Error:` markers.
  const unwrapped = raw
    .replace(/^Error invoking remote method\s+'[^']*':\s*/i, '')
    .replace(/^(Error:\s*)+/i, '')
    .trim()
  return unwrapped || fallback
}
