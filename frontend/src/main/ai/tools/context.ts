/**
 * Tool registry for the in-app assistant.
 *
 * Two kinds of tools:
 *   - BACKEND tools call the PrismLCA FastAPI over the existing authenticated channel (`ctx.api`).
 *     Mutations pass `source: "ai"` so they land in the undo stack + audit log tagged as AI.
 *   - UI tools ask the renderer to perform a canvas/results action (`ctx.ui`) — screenshot,
 *     jump-to-process, auto-layout, set up result views, trigger the canvas Calculate.
 *
 * Each tool returns a compact result (trimmed to stay token-efficient). Tool RESULTS are strings
 * (JSON or short prose); the screenshot tool returns an image part handled specially by the agent.
 *
 * One tool (`research_bom`) is backed by a SUB-AGENT — an isolated, web-search-only LLM loop in
 * subagent.ts. That is the whole extent of "multi-agent" here: a sub-agent is simply a tool whose
 * implementation is another loop, so the main loop stays untouched. It is INJECTED via `ctx.research`
 * rather than imported, which keeps this module import-free: it can be loaded (and bundled) without
 * pulling in Electron or the network layer.
 */

import type { ChatPlan } from '../../../shared/plan'
import type { ModelScope } from '../modelScope'

export interface ToolCtx {
  /** Authenticated backend call; resolves the JSON body or throws a readable error. */
  api: (method: string, path: string, body?: unknown) => Promise<any>
  /** Ask the renderer to run a UI action; resolves its result (or throws). */
  ui: (name: string, args: Record<string, unknown>) => Promise<any>
  /** The foreground model (database) currently open on the canvas, if any.
   *
   *  MUTABLE on purpose: a rename of this very model changes it mid-run. It used to be captured at
   *  the start and never touched, so after `manage_model action="rename"` every tool that falls back
   *  to it asked for a model that no longer existed — measured: two `edit_parameter`
   *  batches refused with "Model '…' does not exist" while `get_current_model` still reported the
   *  old name, and the run's escape was to rename BACK, silently undoing the answer the user had
   *  just given to the assistant's own question (V275). */
  activeDb: string | null
  /**
   * The chat's model fence (modelScope.ts): set by the in-app chat only, absent in an MCP session.
   * The own model is `activeDb` — read live, so a rename carries the fence along.
   */
  scope?: ModelScope
  /** The chat model driving this run — recorded as provenance where a tool writes prose that a
   *  reader may want to attribute (the study's goal & scope, V128). */
  model?: string
  /** Whether web search is allowed at all (the app-wide kill switch in Settings → AI → Chat). */
  webSearchAllowed?: boolean
  /** Whether the `distances` tool may run in this chat (per-chat toggle ∧ app setting ∧ a key).
   *  False also removes the tool from the offered specs (focus.ts) — the guard in `run` is for a
   *  stale request only. */
  distancesAvailable?: boolean
  /** Measure transport legs (injected by the chat IPC, which binds the run's call budget and the
   *  user's keys; see main/distance/service). Absent outside a real run. */
  distances?: (mode: unknown, pairs: unknown) => Promise<unknown>
  /** Whether the `eurostat_eol` tool may run in this chat (per-chat toggle ∧ app setting). False
   *  also removes it from the offered specs (focus.ts); the guard in `run` is for a stale request. */
  eurostatAvailable?: boolean
  /** Query Eurostat's waste tables (injected by the chat IPC; see main/eurostat/service). */
  eurostat?: (args: unknown) => Promise<unknown>
  /** The user's own library databases (My processes) this chat released; empty = withheld. */
  libraryDbs?: string[]
  /** The read-only background databases released to this chat (ecoinvent and/or BAFU) — the ones a search covers. */
  backgroundDbs?: string[]
  /** The background the user prefers when several are released (Settings → Modelling); '' = none.
   *  It steers by a prompt rule only — search hits are neither marked nor reordered. */
  preferredBackground?: string
  /** How many research questions one research_web call may fan out in parallel (Settings). */
  maxResearchQuestions?: number
  /**
   * Background datasets this run has opened with `get_process_details`, as `database` + NUL + `code` (see inspectedKey).
   * Injected and seeded by the agent from the carried transcript, so a dataset read in an earlier
   * turn still counts as read. The contribution list uses it to say which of the datasets that
   * actually carry the result have never been looked at — see `contribution`.
   */
  inspected?: Set<string>
  /**
   * Background searches this run has already run, keyed by the query's content words (the backend
   * returns them as `content_terms`). Owned by the run, like `inspected`.
   *
   * The byte-level repeat guard in the agent loop cannot see a repeat that travels inside a batch:
   * in a real apple-sauce run "apple juice" was searched six times and "tinplate" six times,
   * across five different `search_background` calls, and no two of those calls were identical. Three
   * whole rounds went on re-asking for two materials that are not in ecoinvent 3.12. This says only
   * what the run has already asked — never anything about the database.
   */
  searched?: Map<string, { query: string; hits: number }>
  /**
   * Whether this run has already been shown the dimension_check boilerplate note once. MUTABLE like
   * `activeDb`: the first formula write of a run keeps the full sentence, every later one keeps only
   * the data fields (`amount_must_be_in`, `parameter_units`) — those change per formula, the sentence
   * never does, and it rode along on 13 of 75 answers in one run (V282).
   */
  unitNoteSaid?: boolean
  /**
   * The user has already confirmed THIS call on an approval card (MCP sessions, approval mode): a
   * tool that would ask again before an irreversible step — the custom-method deletes — skips its
   * own question. Set by the session for the duration of one call, never by a tool.
   */
  preApproved?: boolean
  /**
   * What the app window shows right now — view, selection, results — for `get_current_model` in an
   * external session (Figma's lesson: the selection IS the context a local server has and a cloud
   * one does not). Absent in the chat, whose renderer already sends the active model.
   */
  appState?: () => Promise<Record<string, unknown> | null>
  /**
   * The chat's plan — read the accepted revision, write the next one (persisted and shown by the
   * caller). Injected by the chat loop only; absent in an MCP session, where the external client
   * keeps its own task list, so the `plan` tool answers that it is not available. `explanation` is
   * what the model said about the change, passed through for the event/trace.
   */
  plan?: {
    current: () => ChatPlan | null
    update: (next: ChatPlan | null, explanation?: string) => Promise<void>
  }
  /**
   * Run the web-research sub-agent (injected by the agent, which binds the run's abort signal).
   * Absent outside a real run — the tool then reports that research is unavailable.
   */
  research?: (opts: {
    product: string
    context?: string
    totalMassKg?: number
    components?: string[]
    maxComponents?: number
    domains?: string[]
  }) => Promise<unknown>
  /** Run the generic web-research sub-agent (injected, same reasoning as `research`). */
  researchWeb?: (opts: {
    question: string
    context?: string
    allowUnsourced?: boolean
    index?: number
    total?: number
    domains?: string[]
  }) => Promise<unknown>
  /** Have a prepared dossier judged by the reviewer (injected; one toolless model pass, retried once
   *  when it comes back empty). The outcome travels with the text so "found nothing" and "said
   *  nothing" stay different answers — see `reviewDossier`. */
  review?: (opts: { dossier: string }) => Promise<{
    text: string
    outcome: 'ok' | 'empty' | 'error'
    finish_reason?: string
    reasoning_chars: number
    attempts: number
    ms: number
    error?: string
  }>
}

export interface Tool {
  spec: {
    type: 'function'
    function: { name: string; description: string; parameters: Record<string, unknown> }
  }
  /**
   * What the tool's `run` actually needs, for the manifest (docs/ai-tool-manifest.json): absent
   * means a thin HTTP wrapper an external agent could call directly; 'ui' means it drives the
   * renderer via ctx.ui and only works inside the app window; 'subagent' means it is backed by a
   * nested LLM pass (research legs, the reviewer) an external agent would have to reimplement.
   * A field on the tool rather than a name list in the dump script — the hand-kept list had
   * already drifted (canvas_view was listed by its four IMPL action names, which are not tools).
   */
  surface?: 'ui' | 'subagent'
  /**
   * Returns a string result, {image} for a vision screenshot, {result, transcript} where
   * `transcript` is Markdown appended to the assistant's visible text (used by ask_user so the
   * question + answer survive in the chat history), or {result, notice} where `notice` is a line
   * the chat shows on the tool-call row itself — the attribution a data provider requires to be
   * DISPLAYED, which a collapsed result preview is not (the distances tool).
   */
  run: (
    args: any,
    ctx: ToolCtx
  ) => Promise<
    string | { image: string } | { result: string; transcript: string } | { result: string; notice: string }
  >
}
