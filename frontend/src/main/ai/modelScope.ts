/**
 * The chat's model fence, main-process half: which databases a tool call of the in-app chat may name.
 *
 * The built-in assistant works on the model whose chat it runs in. It reads and changes that model,
 * may rename it, and may READ the comparison models linked to it and switched on in the chat — never
 * change them. It does not open, create, copy or delete models, does not link inputs from another
 * model (a comparison model included: the link would make one model depend on the other), and does
 * not write into the library. Without that, a chat could wander into another model, and the user
 * would find the work under a chat that sits somewhere else.
 *
 * Only the chat sets a scope; an external MCP session has none and is not fenced — it is meant to
 * work across models and brings its own session. The backend holds the same line for every write
 * (`X-Prism-Model`, backend engine/model_scope.py); this half refuses before the call is sent, in
 * words the model can act on, and is the only one that fences READS.
 *
 * Electron-free, like the tools package.
 */
import { ACTION_PARAM, effectOf, type ToolEffect } from './tools/effects'

export interface ModelScope {
  /** Comparison models this run may read: linked with the chat's model AND switched on in the chat. */
  readable: string[]
  /** Linked comparison models the user switched off in this chat — named in the refusal, so the model
   *  can tell the user where the switch is instead of claiming the model is out of reach for good. */
  switchedOff?: string[]
}

/** Tools the chat is never offered: none of their actions is open to it. */
export const NOT_IN_CHAT: ReadonlySet<string> = new Set(['delete_model'])

/** Actions of shared tools the chat may not take, with what it tells the user instead. */
const DENIED_ACTIONS: Record<string, Record<string, (own: string) => string>> = {
  manage_model: {
    create: (own) =>
      `This chat cannot create a model — it works only on "${own}". The user creates the model in the ` +
      `app (New model) and works on it in that model's own chat.`,
    duplicate: (own) =>
      `This chat cannot copy a model — it works only on "${own}". The user copies it in the app; the ` +
      `copy then has its own chat.`
  },
  canvas_view: {
    open_model: (own) =>
      `This chat cannot open another model — it stays with "${own}". The user opens a model in the app; ` +
      `that model's own chat works there.`
  }
}

/**
 * Effects the fence reads differently from the effects table. `review_model` is "read" there (it
 * asks for no approval card), but it records the review in the reviewed model's provenance log — a
 * write into that model, so a review of a comparison model is refused.
 */
const FENCE_EFFECT: Record<string, ToolEffect> = { review_model: 'write' }

/**
 * Whether a field names the supplier of an input being LINKED: in a writing call it may name the model
 * itself, the library or a background/biosphere database — never another model. `input_database` links
 * only on "add" (or when no action says otherwise); on the other actions it identifies an input the model
 * already has, and an old link to another model must stay reachable for removing or replacing it.
 */
function linksSupplier(field: string, action: string | undefined): boolean {
  if (field === 'new_input_database') return true
  return field === 'input_database' && (action === undefined || action === 'add')
}

function identifiesInput(field: string, action: string | undefined): boolean {
  return field === 'input_database' && !linksSupplier(field, action)
}

/** Top-level fields of a writing call whose databases are READ, not written: the result view's
 *  subjects may show a comparison model beside this one. */
const READ_FIELDS: Record<string, ReadonlySet<string>> = { setup_results: new Set(['subjects']) }

const DATABASE_KEY = /^(?:.*_)?databases?$/

interface Named {
  /** The field that carries the name (`input_database`, `database`, …). */
  field: string
  /** The top-level argument it sits under (`exchanges`, `subjects`, or the field itself). */
  top: string
  /** The `action` of the object it sits in, else of the call: a batch item's own wins. */
  action?: string
  name: string
}

/**
 * Every database name in the arguments, at any depth. Walked over ALL keys, not the schema's: unknown
 * top-level fields are not rejected (argSchema.ts) and several implementations pass their arguments
 * through unchanged, so a field the schema does not have can still reach the backend.
 */
export function namedDatabases(args: Record<string, unknown>): Named[] {
  const out: Named[] = []
  const actionOf = (o: Record<string, unknown>, inherited?: string): string | undefined =>
    typeof o.action === 'string' && o.action.trim() ? o.action.trim() : inherited
  const visit = (v: unknown, field: string, top: string, action: string | undefined, depth: number): void => {
    if (depth > 6 || v === null || v === undefined) return
    if (Array.isArray(v)) {
      for (const item of v) visit(item, field, top, action, depth + 1)
      return
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      for (const [k, inner] of Object.entries(o)) visit(inner, k, top, actionOf(o, action), depth + 1)
      return
    }
    if (typeof v === 'string' && v.trim() && DATABASE_KEY.test(field))
      out.push({ field, top, ...(action ? { action } : {}), name: v.trim() })
  }
  // A batch that names its actions per item hands a shared field down to every item (exchangeBatch.ts):
  // the field then acts as the items do — one "add" among them makes a shared input a supplier.
  const itemActions = Object.values(args ?? {}).flatMap((v) =>
    Array.isArray(v)
      ? v.map((i) => (i && typeof i === 'object' ? actionOf(i as Record<string, unknown>) : undefined))
      : []
  )
  const batchAction =
    itemActions.length && itemActions.every(Boolean)
      ? itemActions.includes('add')
        ? 'add'
        : itemActions[0]
      : undefined
  const callAction = actionOf(args ?? {}) ?? batchAction
  for (const [k, v] of Object.entries(args ?? {})) visit(v, k, k, callAction, 0)
  return out
}

/** The database a name reaches, with its kind from `GET /databases` (`foreground`, `library`,
 *  `background`, `biosphere`); undefined = no such database. */
export type KindOf = (name: string) => Promise<{ name: string; kind: string } | undefined>

const fold = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * The database a name reaches, resolved the way the backend's routes resolve it (`_db_or_404`): exact,
 * else the one database whose letters and digits match — case and punctuation do not count there, so
 * they may not count here either, or `bottle glass` would pass a fence that only knows `Bottle Glass`.
 */
export function resolveDatabase(
  kinds: Map<string, string>,
  name: string
): { name: string; kind: string } | undefined {
  const exact = kinds.get(name)
  if (exact !== undefined) return { name, kind: exact }
  const wanted = fold(name)
  const hits = wanted ? [...kinds.keys()].filter((n) => fold(n) === wanted) : []
  return hits.length === 1 ? { name: hits[0], kind: kinds.get(hits[0]) ?? '' } : undefined
}

function quoteList(names: string[]): string {
  return names.map((n) => `"${n}"`).join(', ')
}

function readableClause(scope: ModelScope): string {
  return scope.readable.length
    ? ` and may read its comparison model(s) ${quoteList(scope.readable)}, never change them`
    : ''
}

/**
 * Why this call may not run in the chat, or null when it may. `kindOf` resolves a name the scope does
 * not know; a name it cannot resolve does not exist, and the call goes on to the tool, which says
 * "not found" — the fence has nothing to protect there.
 */
export async function scopeRefusal(
  tool: string,
  args: Record<string, unknown>,
  own: string | null,
  scope: ModelScope,
  kindOf: KindOf
): Promise<string | null> {
  const here = own ?? ''
  if (NOT_IN_CHAT.has(tool))
    return "This chat cannot delete models. Deleting a model is the user's action in the app."
  const param = ACTION_PARAM[tool]
  const action = param ? String(args?.[param] ?? '').trim() : ''
  const denied = DENIED_ACTIONS[tool]?.[action]
  if (denied) return denied(here)

  const effect = FENCE_EFFECT[tool] ?? effectOf(tool, args)
  const writes = effect !== 'read'
  for (const named of namedDatabases(args)) {
    if (named.name === here) continue
    const hit = scope.readable.includes(named.name)
      ? { name: named.name, kind: 'foreground' }
      : await kindOf(named.name)
    if (!hit) continue // no such database: the tool answers that
    const { name, kind } = hit
    if (name === here) continue
    // An input the model already has, named to change or remove it: no new link, nothing read there.
    if (writes && identifiesInput(named.field, named.action)) continue
    const comparison = scope.readable.includes(name)
    const model = kind === 'foreground'
    const role =
      !writes || READ_FIELDS[tool]?.has(named.top)
        ? 'read'
        : linksSupplier(named.field, named.action)
          ? 'supplier'
          : 'target'
    if (role === 'read' && (!model || comparison)) continue
    if (role === 'supplier' && !model) continue
    if (role === 'read') {
      const off = scope.switchedOff?.includes(name)
      return off
        ? `"${name}" is a comparison model of "${here}" but switched off in this chat, so this chat cannot ` +
            `read it. The user can switch it on in this chat's + menu; it can then be read here, never changed.`
        : `Outside this chat's model: "${name}" is neither this chat's model nor one of its comparison models, ` +
            `so this chat cannot read or change it. This chat works on "${here}"${readableClause(scope)}. ` +
            `Work in another model is done in that model's own chat. To compare the two here, the user adds ` +
            `"${name}" as a comparison model of "${here}" (this chat's + menu → Comparison models…, or Model ` +
            `info → Compared with); it can then be read ` +
            `here, never changed.`
    }
    if (role === 'supplier')
      return (
        `Outside this chat's model: inputs can come from the background databases, the library and "${here}" ` +
        `itself — not from another model, a comparison model included ("${name}"). A link would make this ` +
        `model depend on the other one. To take over its modelling, read the process there and rebuild it ` +
        `here from the same background datasets.`
      )
    if (kind === 'library')
      return (
        `The library "${name}" is read-only in this chat: link its datasets as inputs, but its processes are ` +
        `changed by the user, not here.`
      )
    if (comparison)
      return (
        `Outside this chat's model: "${name}" is a comparison model — this chat may read it but never change ` +
        `it; it changes only "${here}". If the comparison model should change too, tell the user: that is ` +
        `done in its own chat.`
      )
    if (model)
      return (
        `Outside this chat's model: this chat changes only "${here}" — not "${name}". Work in another model ` +
        `is done in that model's own chat; tell the user so instead of looking for another way.`
      )
    // A background or biosphere database as a write target: the backend's read-only guardrail answers.
  }
  return null
}

/**
 * A `database` the tool would silently ignore — it has no such argument and works on the open model.
 * The answer would then be this model's while the chat believes it read the other one ("same distance
 * as the comparison model"), and with `open_model` closed to the chat that is where it goes looking.
 * Said instead of answered; null when the tool takes `database` or the name is the chat's own.
 */
export function ignoredDatabase(
  tool: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
  own: string | null
): string | null {
  const db = typeof args?.database === 'string' ? args.database.trim() : ''
  const props = (schema?.properties ?? {}) as Record<string, unknown>
  if (!db || fold(db) === fold(own ?? '') || 'database' in props) return null
  return (
    `${tool} has no "database" argument: it works on the open model "${own ?? ''}" only, so "${db}" would ` +
    `be ignored and the answer would be this model's. To read another model use a tool that takes ` +
    `"database" — get_process_details, model_info, get_model_graph, list_parameters, list_scenarios.`
  )
}

/** The `list_models` answer as the chat sees it: its own model, its readable comparison models and the
 *  shared databases — the workspace's other models are not listed. */
export function scopedDatabaseList(
  databases: unknown,
  own: string | null,
  scope: ModelScope
): { databases: Array<Record<string, unknown>>; scope: string } {
  const list = Array.isArray(databases) ? (databases as Array<{ name: string; kind?: string }>) : []
  const shown = list
    .filter((d) => d.kind !== 'foreground' || d.name === own || scope.readable.includes(d.name))
    .map((d) => (d.kind === 'foreground' && d.name !== own ? { ...d, comparison: true } : d))
  return {
    databases: shown,
    scope:
      'This chat sees its own model, the comparison models switched on here (read-only) and the shared ' +
      "databases. The workspace's other models are not listed: work in them is done in their own chats."
  }
}
