/**
 * One MCP session = one external client connected to PrismLCA: the model it works on, the tools it
 * may call, its approval mode, and a log of what it did. Runs every tool through the same executor
 * as the chat (ai/execute.ts) under its own turn id and client label.
 *
 * Calls run SERIALLY per session. Clients may issue tool calls in parallel; for writes the order is
 * the semantics, and a read racing a write on the same model is exactly the confusion the in-app
 * chat avoids with its barrier groups. Parallel reads are a possible later step.
 *
 * Electron-free: everything platform-bound (window, keys, settings store) is injected by ipc/mcp.ts.
 */
import { createToolSession, type ApiRaw, type ToolOutcome, type ToolSession } from '../ai/execute'
import type { ToolCtx } from '../ai/tools'
import { effectOf, type ToolEffect } from '../ai/tools/effects'
import { approvalTarget } from '../ai/approval'
import type { Skill } from '../ai/systemPrompt'
import type { McpApprovalMode, McpCallRecord, McpSessionSnapshot } from '../../shared/ipc'
import { buildOrientation } from './instructions'
import { MCP_EXCLUDED_TOOLS, ORIENTATION_TOOL, isMcpTool, mcpToolDefs, type McpToolDef } from './catalog'

/** What the backend accepts as a client label (commands.py CLIENT_LABEL_RE); anything else is dropped. */
const LABEL_ALLOWED = /[^\p{L}\p{N}_ .\-/:]/gu

/** A client label the audit log will keep: letters, digits, space and `._-/:`, at most 80 chars. */
export function clientLabel(name?: string, version?: string): string {
  const raw = `${name ?? ''} ${version ?? ''}`.trim().replace(LABEL_ALLOWED, ' ').replace(/\s+/g, ' ').trim()
  return (raw || 'MCP client').slice(0, 80)
}

export interface SessionDeps {
  apiRaw: ApiRaw
  /** The UI round-trip, bound by the caller to this session (bridge.call with sessionId). */
  ui: (
    sessionId: string,
    clientName: string,
    activeDb: string | null,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<any>
  /** The app settings the executor needs (disabled tools, preferred background, feature switches). */
  settings: () => {
    disabledTools: string[]
    preferredBackground: string
    eurostatEnabled: boolean
  }
  /** Transport-distance measuring for one call, or undefined when the feature is off / has no key. */
  makeDistances?: (signal?: AbortSignal) => ToolCtx['distances'] | undefined
  eurostat?: ToolCtx['eurostat']
  /** Something about this session changed (client known, a call finished): the renderer redraws. */
  onChange: (s: McpSession) => void
  /** A MUTATING tool ran: the canvas showing this model must reload. */
  onMutated: (database: string | null) => void
}

const RECENT_CALLS = 50
const ARGS_PREVIEW = 300

export class McpSession {
  clientName = 'MCP client'
  /** A question or approval card open for this session's current call, if any. */
  humanWait: { tool: string; since: number } | null = null
  clientVersion = ''
  readonly startedAt = Date.now()
  lastSeen = Date.now()
  /** Default: ask before irreversible operations only. */
  approval: McpApprovalMode = 'irreversible'
  private seq = 0
  private readonly recent: McpCallRecord[] = []
  private chain: Promise<unknown> = Promise.resolve()
  private readonly tools: ToolSession
  /** Computed once at the start and kept stable for the session's life (no `list_changed`). */
  readonly catalog: McpToolDef[]
  private readonly offered: Set<string>
  private ended = false
  /** Aborted by end(): every wait and every backend request of this session stops. */
  private readonly abort = new AbortController()

  constructor(
    readonly id: string,
    private readonly deps: SessionDeps,
    activeDb: string | null,
    /** Databases released to the session — every installed background and library. */
    private readonly released: { backgroundDbs: string[]; libraryDbs: string[] },
    /** The project the session was opened on; the backend refuses every request that names another
     *  (409 project_changed) — a model of the same name in another project is not this model. */
    readonly project: string | null = null
  ) {
    const s = deps.settings()
    const distancesOn = !!deps.makeDistances?.()
    this.catalog = mcpToolDefs({
      disabledTools: s.disabledTools,
      distances: distancesOn,
      eurostat: s.eurostatEnabled && !!deps.eurostat
    })
    this.offered = new Set(this.catalog.map((t) => t.name))
    this.tools = createToolSession({
      apiRaw: deps.apiRaw,
      // One turn per call: the granularity an external agent thinks in, and what `history`
      // undo_turn can take back as a block.
      headers: () => ({
        'X-Prism-Turn': this.turnId(),
        'X-Prism-Client': this.label(),
        // Percent-encoded: a header value is Latin-1 on the wire, and "Müller" or "研究" are
        // permitted project names. The backend unquotes it.
        ...(this.project ? { 'X-Prism-Project': encodeURIComponent(this.project) } : {})
      }),
      signal: this.abort.signal,
      ui: async (name, args) => {
        // While a question or approval card waits on a person, the client sees only silence; the
        // server reads `humanWait` and sends progress notifications meanwhile (mcp/server.ts).
        const human = name === 'ask_user' || name === 'approve_tool'
        if (human) this.humanWait = { tool: name, since: Date.now() }
        let answer: unknown
        try {
          answer = await deps.ui(this.id, this.clientName, this.tools.ctx.activeDb, name, args, this.signal)
        } finally {
          if (human) this.humanWait = null
        }
        // A tool's own question (the irreversible deletes ask one) may wait minutes, like the
        // approval card — and what was allowed when it opened may be switched off, or the session
        // gone, by the time it is answered. The card rechecks after its wait (beforeRun); this does
        // the same for every question asked from inside a running tool, before it can mutate
        // (a delete_model switched off mid-question used to run anyway).
        if (human && this.runningTool) {
          if (this.ended) throw new Error('This session has ended.')
          const gone = this.revoked(this.runningTool)
          if (gone) throw new Error(gone)
        }
        return answer
      },
      activeDb,
      disabledTools: s.disabledTools,
      repeatEscape: 'the same call three times in a row was refused; change the arguments or stop.',
      // Recorded as provenance where a tool writes prose (the study's goal & scope): the client's
      // label is the honest answer to "which model wrote this" when PrismLCA does not know the model.
      model: this.label(),
      webSearchAllowed: false,
      distancesAvailable: distancesOn,
      distances: distancesOn ? (mode, pairs) => deps.makeDistances!(this.signal)!(mode, pairs) : undefined,
      eurostatAvailable: s.eurostatEnabled && !!deps.eurostat,
      eurostat: deps.eurostat,
      libraryDbs: released.libraryDbs,
      backgroundDbs: released.backgroundDbs,
      preferredBackground: s.preferredBackground,
      appState: () => this.appState(),
      beforeRun: (name, args, effect) => this.beforeRun(name, args, effect)
    })
  }

  /** What the window shows: asked per call, never cached — the user may have moved on. */
  private async appState(): Promise<Record<string, unknown> | null> {
    try {
      const r = await this.deps.ui(this.id, this.clientName, this.activeDb, 'get_state', {}, this.signal)
      return r && typeof r === 'object' && !('error' in r) ? (r as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  /**
   * The session's policy before a tool runs: the app must not be mid-import (a write into a
   * project whose background is being rebuilt is the kind of state nobody can explain later), and
   * the approval mode decides whether the user sees a card first. An approved irreversible call
   * carries `preApproved`, so the tool's own confirmation does not ask twice.
   */
  private async beforeRun(name: string, args: Record<string, unknown>, effect: ToolEffect): Promise<void> {
    this.tools.ctx.preApproved = false
    if (effect === 'read') return
    const busy = await this.busyReason()
    if (busy) throw new Error(busy)
    const needsCard =
      this.approval === 'every-write'
        ? true
        : this.approval === 'irreversible'
          ? effect === 'irreversible'
          : false
    if (!needsCard) return
    let r: unknown
    // The card waits on a person: the server reports it as progress meanwhile (humanWait).
    this.humanWait = { tool: 'approve_tool', since: Date.now() }
    try {
      r = await this.deps.ui(
        this.id,
        this.clientName,
        this.activeDb,
        'approve_tool',
        {
          tool: name,
          effect,
          args,
          target: approvalTarget(name, args, this.activeDb),
          database: this.activeDb
        },
        this.signal
      )
    } catch (e) {
      this.humanWait = null
      throw new Error(
        `This call needs the user's approval in the PrismLCA window, and none was given (${e instanceof Error ? e.message : String(e)}). Call canvas_view action="show" so they see the card, then try again.`
      )
    }
    this.humanWait = null
    if (!(r && typeof r === 'object' && (r as { approved?: unknown }).approved === true))
      throw new Error('Declined by the user in PrismLCA.')
    // The card may have waited minutes: what was allowed then may be switched off now.
    const gone = this.revoked(name)
    if (gone) throw new Error(gone)
    this.tools.ctx.preApproved = effect === 'irreversible'
  }

  /** A background import in flight makes every write wait; reads are fine. */
  private async busyReason(): Promise<string | null> {
    try {
      const { status, body } = await this.deps.apiRaw('GET', '/api/v1/setup/status')
      const state = status < 400 ? (body as { state?: unknown })?.state : undefined
      return state === 'running'
        ? 'PrismLCA is importing a background database right now; writes wait until it has finished. Reads still work.'
        : null
    } catch {
      return null
    }
  }

  /** The abort signal of the call in flight, if any (the client cancelled). */
  private signal: AbortSignal | undefined
  /** The tool whose `run` is in flight, so a question it asks can recheck its permission after. */
  private runningTool: string | null = null

  get activeDb(): string | null {
    return this.tools.ctx.activeDb
  }

  /** `canvas_view` action="open_model" and a `database` argument the tools resolve themselves both
   *  move the session; this is the explicit switch. */
  setActiveDb(db: string | null): void {
    this.tools.ctx.activeDb = db
    this.deps.onChange(this)
  }

  setClient(name?: string, version?: string): void {
    if (name) this.clientName = name.slice(0, 60)
    if (version) this.clientVersion = version.slice(0, 20)
    this.deps.onChange(this)
  }

  label(): string {
    return clientLabel(this.clientName, this.clientVersion)
  }

  private turnId(): string {
    return `mcp-${this.id.slice(0, 8)}-${this.seq}`
  }

  snapshot(): McpSessionSnapshot {
    return {
      id: this.id,
      project: this.project,
      clientName: this.clientName,
      clientVersion: this.clientVersion,
      startedAt: this.startedAt,
      lastSeen: this.lastSeen,
      activeDb: this.activeDb,
      approval: this.approval,
      calls: this.seq,
      recent: [...this.recent]
    }
  }

  /** The session ended (client DELETE, disconnect from the panel, server stop): nothing that is
   *  waiting or running for it may still write. */
  end(): void {
    if (this.ended) return
    this.ended = true
    this.abort.abort(new Error('This session has ended.'))
  }

  /**
   * What the user has switched off SINCE the session started. The catalogue stays as advertised
   * (no `list_changed`), but a revoked tool is refused at dispatch — and again after an approval
   * wait, which may have lasted minutes.
   */
  private revoked(name: string): string | null {
    const s = this.deps.settings()
    if (s.disabledTools.includes(name)) return `Tool ${name} is switched off (Settings → AI → Tools).`
    if (name === 'eurostat_eol' && !s.eurostatEnabled)
      return 'Eurostat statistics are switched off (Settings → AI → Chat).'
    if (name === 'distances' && !this.deps.makeDistances?.())
      return 'Transport distances are no longer available (setting or key).'
    return null
  }

  /**
   * Run one tool call, queued behind the session's earlier calls. `orientation` is answered here
   * because it needs the backend (skills, study) and the session (client, released databases).
   */
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome> {
    const run = async (): Promise<ToolOutcome> => {
      const startedAt = Date.now()
      this.lastSeen = startedAt
      if (this.ended) return { ok: false, error: 'This session has ended.', ms: 0 }
      this.seq++
      let oc: ToolOutcome
      const gone = this.revoked(name)
      if (!isMcpTool(name) || !this.offered.has(name)) {
        oc = { ok: false, error: `Unknown tool: ${name}`, ms: 0 }
      } else if (gone) {
        oc = { ok: false, error: gone, ms: 0 }
      } else if (name === ORIENTATION_TOOL) {
        oc = await this.orientation().catch((e) => ({
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
          ms: Date.now() - startedAt
        }))
      } else {
        this.signal = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal
        this.runningTool = name
        try {
          oc = await this.tools.run(name, args, { signal })
        } finally {
          this.signal = undefined
          this.runningTool = null
          this.tools.ctx.preApproved = false
        }
        if (oc.ok && oc.mutated) this.deps.onMutated(this.activeDb)
        if (oc.ok && name === 'get_skill') oc = withoutChatOnlyTools(oc)
        if (oc.ok && name === 'check_model_health') oc = withoutChatOnlyAdvice(oc)
        // The backend refused because the app moved to another project: this session's model is
        // not there any more. It ends here; the client reconnects and gets the current project.
        if (!oc.ok && /The active workspace changed/.test(oc.error)) this.end()
      }
      this.record(name, args, oc, effectOf(name, args))
      return oc
    }
    // Serial per session; a failure of one call never breaks the chain for the next.
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  private record(name: string, args: Record<string, unknown>, oc: ToolOutcome, effect: ToolEffect): void {
    const preview = JSON.stringify(args ?? {}).slice(0, ARGS_PREVIEW)
    const rec: McpCallRecord = oc.ok
      ? { n: this.seq, tool: name, args: preview, ok: true, soft: oc.soft, ms: oc.ms, at: Date.now(), effect }
      : {
          n: this.seq,
          tool: name,
          args: preview,
          ok: false,
          error: oc.error,
          ms: oc.ms,
          at: Date.now(),
          effect
        }
    this.recent.push(rec)
    if (this.recent.length > RECENT_CALLS) this.recent.shift()
    this.deps.onChange(this)
  }

  private async orientation(): Promise<ToolOutcome> {
    const startedAt = Date.now()
    const api = this.tools.ctx.api
    const skillsBody = await api('GET', '/api/v1/ai/skills?enabled=true').catch(() => null)
    const skills: Skill[] = Array.isArray(skillsBody?.skills) ? skillsBody.skills : []
    let study: Record<string, unknown> | null = null
    let studyLanguage: string | undefined
    if (this.activeDb) {
      const s = await api('GET', `/api/v1/study?database=${encodeURIComponent(this.activeDb)}`).catch(
        () => null
      )
      if (s && typeof s === 'object') {
        study = s as Record<string, unknown>
        const lang = (s as { language?: unknown }).language
        if (typeof lang === 'string' && lang.trim()) studyLanguage = lang.trim()
      }
    }
    const settings = this.deps.settings()
    const text = buildOrientation({
      activeDb: this.activeDb,
      skills,
      approvalGate: this.approval !== 'never',
      backgroundDbs: this.released.backgroundDbs,
      libraryDbs: this.released.libraryDbs,
      preferredBackground: settings.preferredBackground,
      studyLanguage,
      distances: this.offered.has('distances'),
      eurostat: this.offered.has('eurostat_eol'),
      study,
      clientName: this.clientName,
      toolNotes: Object.fromEntries(
        this.catalog.filter((t) => t._note).map((t) => [t.name, t._note as string])
      )
    })
    return { ok: true, result: text, mutated: false, ms: Date.now() - startedAt }
  }
}

/**
 * The skills are written for the in-app chat and name tools this catalogue does not carry
 * (`review_model`, `research_web`, `research_bom`). A client model following them to the letter then
 * calls a tool that does not exist. Say so in the answer, once, naming the tools the
 * loaded text mentions — the text itself stays as it is.
 */
function withoutChatOnlyTools(oc: ToolOutcome): ToolOutcome {
  if (!oc.ok) return oc
  const named = [...MCP_EXCLUDED_TOOLS].filter((t) => new RegExp(`\\b${t}\\b`).test(oc.result))
  if (!named.length) return oc
  try {
    const body = JSON.parse(oc.result) as Record<string, unknown>
    body.not_available_in_this_session = named
    body.note =
      `These skills mention ${named.map((t) => `\`${t}\``).join(', ')}, which this session does not have: ` +
      'skip those steps (or do them with your own means) and say so in your answer — do not call them.'
    return { ...oc, result: JSON.stringify(body) }
  } catch {
    return oc
  }
}

/**
 * The linter's advice is written for the in-app chat ("research_bom for a composition, research_web
 * for a rate"); an external client has neither (V388). The sentence keeps its shape with the means
 * the client does have.
 */
function withoutChatOnlyAdvice(oc: ToolOutcome): ToolOutcome {
  if (!oc.ok) return oc
  const text = oc.result
    .replace(/\bresearch_bom\b/g, 'your own research')
    .replace(/\bresearch_web\b/g, 'your own web research')
    .replace(/\breview_model\b/g, 'a critical read of the model')
  return text === oc.result ? oc : { ...oc, result: text }
}
