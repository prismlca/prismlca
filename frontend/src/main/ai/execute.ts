/**
 * The tool executor: one place that builds a `ToolCtx` and runs a tool call with every rule the chat
 * loop used to enforce inline — unknown tool, switched-off tool, stop pressed, foreign serialisation
 * in the arguments, the byte-identical-repeat guard, the result shapes a tool may return, and the
 * "did this change the model" verdict that triggers a canvas reload.
 *
 * Extracted from agent.ts so a second caller — the MCP server for external agents — runs
 * a tool under exactly the same rules as the chat. Copying the `ToolCtx` construction would not have
 * been enough: `disabledTools` was checked at dispatch (agent.ts:1268), the turn header was set in the
 * `api` closure, and the run memory (`inspected`, `searched`) lived in the loop. Whatever the chat
 * learns about safe execution, an external client must get for free — and vice versa.
 *
 * What stays with the caller: the trace, the events it emits, how it caps a result for its own
 * context window, and what it does with an image or a transcript. Those differ between a chat turn
 * and an MCP call, and neither is a rule about running a tool.
 */
import { MUTATING_TOOLS, TOOL_BY_NAME, type ToolCtx } from './tools'
import {
  makeRepeatGuard,
  stripOwnClosingTags,
  toolNamesInArgs,
  xmlInArgs,
  type RepeatGuard
} from './toolGuards'
import { validateToolArgs } from './argSchema'
import { changesStructure, effectOf, type ToolEffect } from './tools/effects'
import { apiError } from '../../shared/backendError'
import { clampResearchQuestions } from '../../shared/aiDefaults'
import { ignoredDatabase, resolveDatabase, scopeRefusal, type KindOf, type ModelScope } from './modelScope'

/** Raw backend request, as main's `apiRequest` provides it (status + body, never throws on HTTP errors). */
export type ApiRaw = (
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
) => Promise<{ status: number; body: unknown }>

export interface ToolSessionOpts {
  apiRaw: ApiRaw
  /**
   * Headers every backend call of this session carries — evaluated per call, because the MCP server
   * changes the turn id between calls while the chat keeps one for the run. `X-Prism-Turn` groups a
   * turn's commands for undo; `X-Prism-Client` names the external client in the audit log.
   */
  headers: () => Record<string, string>
  /** The UI round-trip (renderer), already bound to the run/session it belongs to. */
  ui: ToolCtx['ui']
  activeDb: string | null
  /**
   * The in-app chat's model fence (modelScope.ts). Absent = not fenced, which is what an MCP session
   * is: an external agent works across models on purpose.
   */
  modelScope?: ModelScope
  /** Tools switched off — not offered AND not executed, whatever a model remembers. */
  disabledTools?: Iterable<string>
  /** The escape sentence the repeat guard tells the model after the third identical call. */
  repeatEscape?: string
  model?: string
  webSearchAllowed?: boolean
  distancesAvailable?: boolean
  distances?: ToolCtx['distances']
  eurostatAvailable?: boolean
  eurostat?: ToolCtx['eurostat']
  libraryDbs?: string[]
  backgroundDbs?: string[]
  preferredBackground?: string
  maxResearchQuestions?: number
  research?: ToolCtx['research']
  researchWeb?: ToolCtx['researchWeb']
  review?: ToolCtx['review']
  /**
   * Runs after every dispatch check and before the tool: the caller's policy — an approval card, a
   * "the app is busy" gate. Throw to refuse the call with that message. `effect` is the effects
   * table's verdict for this (tool, action).
   */
  beforeRun?: (name: string, args: Record<string, unknown>, effect: ToolEffect) => Promise<void>
  appState?: ToolCtx['appState']
  /**
   * The session's own end (disconnect, server stop): checked before every backend request, so a
   * tool that is mid-way through several writes stops between them — and after every wait
   * (approval card, question) before the tool runs at all.
   */
  signal?: AbortSignal
}

/** What running one tool call came to. `ok: true` includes a soft refusal the tool RETURNED. */
export type ToolOutcome =
  | {
      ok: true
      /** The string handed back to the model (JSON or prose). */
      result: string
      /** The tool refused inside its own answer (`{"error": …}`): told no, nothing changed. */
      soft?: string
      /** A batch where some items failed (`failedItems`). */
      itemsFailed?: number
      /** A screenshot (data URL) — the caller decides how to hand an image to its model. */
      image?: string
      /** ask_user: the Q + A as Markdown the chat appends to its visible text. */
      transcript?: string
      /** A line a data provider requires to be DISPLAYED (distances attribution). */
      notice?: string
      /** A writing tool ran and was not refused (effects table): the renderer's model-scoped caches
       *  — study, scenarios, audit — are stale. */
      mutated: boolean
      /** The write touched the GRAPH (MUTATING_TOOLS): the canvas must be redrawn as well. */
      graph?: boolean
      /** …and changed which boxes or arrows it draws: the chat fits the view once the turn is over. */
      structure?: boolean
      ms: number
    }
  | { ok: false; error: string; ms: number }

export interface ToolSession {
  /** The context the tools see. MUTABLE by design (`activeDb` after a rename, `unitNoteSaid`). */
  ctx: ToolCtx
  repeats: RepeatGuard
  /**
   * Run one tool call. `rawArgs` is the model's argument string (parsed here, so a broken JSON is an
   * error the model sees) or an already-parsed object (the MCP server hands over structured input).
   */
  run(
    name: string,
    rawArgs: string | Record<string, unknown> | undefined,
    opts?: RunOpts
  ): Promise<ToolOutcome>
}

/** `calculate job="status"|"result"` reads a background job; asking again is the whole point. */
export function isPoll(name: string, args: Record<string, unknown>): boolean {
  return name === 'calculate' && (args.job === 'status' || args.job === 'result')
}

/** Both signals, or whichever exists: the session's (ended, disconnected) and the request's. */
function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b])
  return a ?? b
}

export interface RunOpts {
  /** Stop pressed / client cancelled: a call queued behind a slow one must not start. */
  signal?: AbortSignal
}

/**
 * A tool that rejects a call usually RETURNS `{"error": …}` instead of throwing (an invalid argument
 * is the model's mistake, not an exception). Surface that message so mistakes can be counted:
 * a model looping on rejected calls otherwise shows up as zero errors.
 */
export function softError(resultStr: string): string | undefined {
  if (!resultStr.startsWith('{')) return undefined
  try {
    const v = JSON.parse(resultStr) as { error?: unknown }
    return typeof v.error === 'string' ? v.error : undefined
  } catch {
    return undefined
  }
}

/**
 * How many items of a BATCH call failed, from the envelope `batchResult` writes.
 *
 * A batch is the one shape where the call succeeds and the work does not. Three of six processes
 * were lost to a dropped socket while the trace said `ok` and the summary line read
 * "54 tool calls" — the run was saved only because the model read the result itself. The status
 * cannot simply become 'error': the other three items WERE applied, and calling that a failure is
 * its own lie. So the count travels beside the status.
 */
export function failedItems(resultStr: string): number | undefined {
  if (!resultStr.startsWith('{')) return undefined
  try {
    const v = JSON.parse(resultStr) as { failed?: unknown; total?: unknown }
    if (typeof v.failed !== 'number' || typeof v.total !== 'number') return undefined
    return v.failed > 0 ? v.failed : undefined
  } catch {
    return undefined
  }
}

/**
 * Append the argument names this tool does not have, when a call has failed.
 *
 * The validation message says what is MISSING and never what is EXTRA, because FastAPI's `detail`
 * only lists the fields it wanted. Measured in a wall-paint run: the model called
 * `calculate` with `codes: [...]` — the batch key that `search_background`, `get_process_details`,
 * `edit_exchange`, `edit_parameter` and `edit_scenario` all take — and was told `code: Field
 * required`. The one word that would have ended it, `codes`, appeared nowhere. A generic sentence
 * here covers every tool, because the schema is right next to the call.
 */
export function withUnknownFields(message: string, rawArgs: string | undefined, tool?: unknown): string {
  const props = (tool as any)?.spec?.function?.parameters?.properties
  if (!props || !rawArgs) return message
  let args: Record<string, unknown>
  try {
    args = JSON.parse(rawArgs)
  } catch {
    return message
  }
  if (!args || typeof args !== 'object') return message
  const unknown = Object.keys(args).filter((k) => !(k in props))
  if (!unknown.length) return message
  return (
    `${message} Also: this tool has no ${unknown.map((k) => `"${k}"`).join(', ')} — ` +
    `it takes ${Object.keys(props)
      .map((k) => `"${k}"`)
      .join(', ')}.`
  )
}

/** `warnings` first in a JSON-object answer (the search answers' placement); a non-object answer gets it as a line on top. */
function withWarning(result: string, remark: string): string {
  try {
    const parsed = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const warnings = Array.isArray(parsed.warnings) ? [...parsed.warnings, remark] : [remark]
      return JSON.stringify({ warnings, ...parsed })
    }
  } catch {
    /* not JSON — fall through */
  }
  return `${remark}\n${result}`
}

export function createToolSession(o: ToolSessionOpts): ToolSession {
  const disabled = new Set(o.disabledTools ?? [])
  // Backend call that unwraps the JSON body or throws a readable error for the model to see.
  const api = async (method: string, path: string, body?: unknown): Promise<any> => {
    if (o.signal?.aborted) throw new Error('This session has ended; nothing more is sent to the backend.')
    const { status, body: b } = await o.apiRaw(method, path, body, headers())
    // One shared reading of the failure (message ?? validation detail ?? string body ?? HTTP n,
    // hint appended) — see shared/backendError.ts for why the hint always rides along.
    const failure = apiError(status, b)
    if (failure) throw failure
    return b
  }
  // The fence travels with every backend call of a fenced session, naming the model as it is NOW — after
  // a rename, the new name. Empty = a chat without a model, which may change none.
  const headers = (): Record<string, string> =>
    ctx.scope ? { ...o.headers(), 'X-Prism-Model': encodeURIComponent(ctx.activeDb ?? '') } : o.headers()
  // Database kinds for the fence, fetched once and again — at most once per call — when a name is new
  // (a model the user made meanwhile). Only a fenced call that names another database ever asks. A list
  // that cannot be had refuses the call: "unknown" would let it through.
  let kinds: Map<string, string> | null = null
  const loadKinds = async (): Promise<Map<string, string>> => {
    const { status, body } = await o.apiRaw('GET', '/api/v1/databases', undefined, headers())
    if (status >= 400 || !Array.isArray(body))
      throw new Error(
        'This chat could not check which databases exist, so the call did not run. Send it again.'
      )
    const list = body as Array<{ name?: string; kind?: string }>
    return new Map(list.filter((d) => d?.name).map((d) => [String(d.name), String(d.kind ?? '')]))
  }
  const kindsForOneCall = (): KindOf => {
    let fresh = false
    // Reloaded on any name the list does not hold exactly — a loose spelling is resolved against the
    // current list, never an old one that may lack the model it really reaches.
    return async (name) => {
      if (!fresh && !kinds?.has(name)) {
        kinds = await loadKinds()
        fresh = true
      }
      return kinds ? resolveDatabase(kinds, name) : undefined
    }
  }
  const ctx: ToolCtx = {
    api,
    ui: o.ui,
    activeDb: o.activeDb,
    scope: o.modelScope,
    model: o.model,
    webSearchAllowed: o.webSearchAllowed,
    distancesAvailable: o.distancesAvailable === true && !!o.distances,
    distances: o.distances,
    eurostatAvailable: o.eurostatAvailable === true && !!o.eurostat,
    eurostat: o.eurostat,
    // The user's own library, when released — search_activities folds these databases into every
    // search and marks their hits as the user's own (see tools/groups/read.ts).
    libraryDbs: o.libraryDbs?.filter(Boolean) ?? [],
    // Absent = the caller did not say (server default); an EMPTY list = every background switched
    // off, and the search tool then says so instead of searching nothing.
    backgroundDbs: o.backgroundDbs?.filter(Boolean),
    preferredBackground: o.preferredBackground || undefined,
    maxResearchQuestions: clampResearchQuestions(o.maxResearchQuestions),
    // Which datasets have been opened with get_process_details — owned by the session; the chat seeds
    // it from the carried transcript so a dataset read in an earlier turn is not asked for twice.
    inspected: new Set<string>(),
    // Which background searches have already been answered, keyed by content words. Not seeded: a
    // search is cheap to repeat and the note is only worth having while the answer is in view.
    searched: new Map<string, { query: string; hits: number }>(),
    research: o.research,
    researchWeb: o.researchWeb,
    review: o.review,
    appState: o.appState
  }
  // The byte-identical-repeat guard, shared with the chapter writer (toolGuards.ts).
  const repeats = makeRepeatGuard(o.repeatEscape ?? 'answer the user with what you already have.')

  const run: ToolSession['run'] = async (name, rawArgs, opts) => {
    const tool = TOOL_BY_NAME[name]
    const startedAt = Date.now()
    const argText = typeof rawArgs === 'string' ? rawArgs : rawArgs ? JSON.stringify(rawArgs) : ''
    try {
      const args: Record<string, unknown> =
        typeof rawArgs === 'string' ? (rawArgs ? JSON.parse(rawArgs) : {}) : (rawArgs ?? {})
      if (!tool) throw new Error(`Unknown tool: ${name}`)
      if (disabled.has(name))
        throw new Error(`Tool ${name} is switched off for this chat (Settings → AI → Tools).`)
      // Stop pressed while an earlier call was running: nothing after it starts — a create_process
      // queued behind a research call must not land.
      const signal = anySignal(o.signal, opts?.signal)
      if (signal?.aborted) throw new Error('Stopped by the user before this call started.')
      // Valid JSON whose strings carry another serialisation's tags (V326) — say so, before the tool
      // rejects a "missing" field that is in fact glued into another one.
      // A closing tag that only echoes the field's own name at the end of its value is repaired, not
      // refused (V436): the route re-encoded the model's XML tool call and left `</cutoff_criteria>`
      // behind — unambiguous, and a refusal cost a round for nothing.
      const repaired = stripOwnClosingTags(args)
      if (repaired.length)
        console.log(`[prism-ai] ${name}: stripped the field's own closing tag from ${repaired.join(', ')}`)
      const xml = xmlInArgs(args)
      if (xml) throw new Error(xml)
      // The repeat guard files at dispatch, which is synchronous even inside a parallel group — two
      // byte-identical calls in one round still count as two.
      // Polling a job IS the same call again, by design: the guard that catches a model looping on
      // a refused edit must not stop the one legitimate repeat.
      const blocked = isPoll(name, args) ? null : repeats.block(name, argText)
      if (blocked) throw new Error(blocked)
      // The declared schema, checked here for every tool (argSchema.ts) — after the repeat guard,
      // so a model re-sending the same invalid call still runs into the block instead of the same
      // diagnosis a fourth time, and after the tag check, whose cause outranks any schema symptom.
      const invalid = validateToolArgs(name, tool.spec.function.parameters, args)
      if (invalid) throw new Error(invalid)
      // The chat's model fence — before an approval card, so the user is never asked about a call
      // that may not run anyway.
      if (ctx.scope) {
        const ignored = ignoredDatabase(name, args, tool.spec.function.parameters, ctx.activeDb)
        if (ignored) throw new Error(ignored)
        const outside = await scopeRefusal(name, args, ctx.activeDb, ctx.scope, kindsForOneCall())
        if (outside) throw new Error(outside)
      }
      if (o.beforeRun) await o.beforeRun(name, args, effectOf(name, args))
      // The policy above may have waited minutes on a human; the session may be gone by now.
      if (signal?.aborted) throw new Error('Cancelled while waiting — the call did not run.')
      const out = await tool.run(args, ctx)
      let result: string
      let image: string | undefined
      let transcript: string | undefined
      let notice: string | undefined
      if (typeof out === 'object' && 'image' in out) {
        result = 'Screenshot captured; see the image in the next message.'
        image = out.image
      } else if (typeof out === 'object' && 'transcript' in out) {
        result = out.result
        transcript = out.transcript
      } else if (typeof out === 'object' && 'notice' in out) {
        result = out.result
        notice = out.notice
      } else {
        result = out as string
      }
      const soft = softError(result)
      // A tool name in a field the report prints (V408b): said in the answer, beside the result, in the
      // `warnings` slot every search answer already uses — the one place a model reads first.
      if (!soft && MUTATING_TOOLS.has(name)) {
        const remark = toolNamesInArgs(args, Object.keys(TOOL_BY_NAME))
        if (remark) result = withWarning(result, remark)
      }
      // A rejected call changed nothing, so it neither needs a canvas reload nor lifts the repeat
      // block — otherwise a model looping on refused edits would clear it every round.
      //
      // `mutated` follows the effects table, not MUTATING_TOOLS: that set is the CANVAS list and
      // misses writers that never touch the graph (study metadata, scenarios, results set-up). The
      // renderer invalidates its study/scenario caches on this flag, so a `model_info set` that did
      // not raise it left the Report page reading a study record from before the assistant filled
      // it in — "Not recorded for this study: functional unit, …" over a complete record (V424).
      // `graph` keeps the old meaning for the canvas: only those tools redraw it.
      const mutated = !soft && effectOf(name, args) !== 'read'
      if (mutated) repeats.clear() // the model state moved on: re-reading the same thing is legitimate again
      return {
        ok: true,
        result,
        soft,
        itemsFailed: failedItems(result),
        image,
        transcript,
        notice,
        mutated,
        graph: mutated && MUTATING_TOOLS.has(name),
        structure: mutated && changesStructure(name, args),
        ms: Date.now() - startedAt
      }
    } catch (e) {
      const error = withUnknownFields(e instanceof Error ? e.message : String(e), argText || undefined, tool)
      return { ok: false, error, ms: Date.now() - startedAt }
    }
  }

  return { ctx, repeats, run }
}
