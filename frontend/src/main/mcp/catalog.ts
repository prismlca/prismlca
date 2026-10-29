/**
 * The tool catalogue an external MCP client sees: the in-app tools, minus the ones that only make
 * sense with our own chat around them, plus one MCP-only tool that stands in for the system prompt.
 *
 * Built from the same registry as the chat (`ai/tools`), never a second list — the parity test in
 * catalog.test.ts holds every api/ui tool of docs/ai-tool-manifest.json to this. The three sub-agent
 * tools are excluded on purpose: the external client IS the model, and a model inside a model would
 * double cost and responsibility. `set_chat_title` has no chat to name.
 *
 * Electron-free, like the tools package, so the MCP server and its tests run under plain Node.
 */
import { TOOLS, TOOL_BY_NAME } from '../ai/tools'
import { toolCatalog } from '../ai/tools/catalog'
import { toolAnnotations } from '../ai/tools/effects'

export const MCP_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  'research_bom',
  'research_web',
  'review_model',
  'set_chat_title',
  // The client is the model and brings its own task list (Claude Code `Tasks`, Codex `update_plan`,
  // Cowork tasks); a second one would be written by nobody and read by nobody — Codex's issue #33890
  // names the harm, "two competing planning surfaces".
  'plan'
])

// The in-app chat's model fence (ai/modelScope.ts: its own model only, comparison models read-only,
// no model lifecycle, no `delete_model`) reaches the MCP server not at all: an external agent is meant
// to work across models — it opens, creates and compares them, and it keeps its own session, so it
// cannot lose a chat the way the in-app assistant would. Its sessions send no `X-Prism-Model`.

/** The MCP-only bootstrap tool — what the system prompt is to the in-app chat. */
export const ORIENTATION_TOOL = 'orientation'

export const ORIENTATION_DESCRIPTION =
  'CALL THIS FIRST, before any other PrismLCA tool. Returns what PrismLCA is, the model this session ' +
  'works on with its study scope (goal, functional unit, boundaries), the background databases ' +
  'released to you, the skills you can load with get_skill, and the modelling rules the in-app ' +
  'assistant follows (sign conventions, method choice, units, what is undoable). Without it you ' +
  'will model against conventions you do not know. Cheap and read-only; call it again after ' +
  'switching models.'

export interface McpToolDef {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint?: boolean }
  _meta?: Record<string, unknown>
  /** Internal: the full description when `description` was shortened — never sent to the client. */
  _note?: string
}

/** Claude Code cuts a tool description at 2,048 characters; three of ours are longer. */
export const MCP_DESCRIPTION_MAX = 2000

const NOTE_POINTER = ' More on reading its answer: call orientation and see "Tool notes".'

/**
 * A description that fits the client's cut-off: shortened at a sentence end, pointing at the
 * orientation text, where the full description is kept under "Tool notes". The chat keeps the long
 * text — it was tuned against real runs and the chat has no such limit.
 */
export function mcpDescription(description: string): { description: string; note?: string } {
  if (description.length <= MCP_DESCRIPTION_MAX) return { description }
  const limit = MCP_DESCRIPTION_MAX - NOTE_POINTER.length
  const cut = description.lastIndexOf('. ', limit)
  const head = cut > limit / 2 ? description.slice(0, cut + 1) : description.slice(0, limit)
  return { description: `${head}${NOTE_POINTER}`, note: description }
}

/** The full descriptions of the tools whose MCP description had to be shortened, by tool name. */
export function toolNotes(opts: CatalogOpts = {}): Record<string, string> {
  const notes: Record<string, string> = {}
  for (const t of mcpToolDefs(opts)) if (t._note) notes[t.name] = t._note
  return notes
}

export interface CatalogOpts {
  /** Tools switched off in Settings → AI → Tools: not offered, exactly as in the chat. */
  disabledTools?: Iterable<string>
  /** The `distances` tool exists only with a geocoding key and the app setting on (chat rule). */
  distances?: boolean
  /** The `eurostat_eol` tool exists only with the app setting on (chat rule). */
  eurostat?: boolean
}

/** Whether a tool name may be called through MCP at all (before any per-session switch). */
export function isMcpTool(name: string): boolean {
  if (name === ORIENTATION_TOOL) return true
  return name in TOOL_BY_NAME && !MCP_EXCLUDED_TOOLS.has(name)
}

/**
 * The catalogue for ONE session, computed once at its start and kept stable afterwards: two of the
 * three target clients do not document `tools/list_changed`, so the list must not move under them.
 */
export function mcpToolDefs(o: CatalogOpts = {}): McpToolDef[] {
  const disabled = new Set(o.disabledTools ?? [])
  const labels = new Map(toolCatalog().map((e) => [e.name, e.label] as const))
  const orientation: McpToolDef = {
    name: ORIENTATION_TOOL,
    title: 'Orientation',
    description: ORIENTATION_DESCRIPTION,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
  }
  const rest = TOOLS.filter((t) => {
    const name = t.spec.function.name
    if (MCP_EXCLUDED_TOOLS.has(name) || disabled.has(name)) return false
    if (name === 'distances') return o.distances === true
    if (name === 'eurostat_eol') return o.eurostat === true
    return true
  }).map((t): McpToolDef => {
    const name = t.spec.function.name
    const annotations = toolAnnotations(name)
    const { description, note } = mcpDescription(t.spec.function.description)
    return {
      name,
      title: labels.get(name),
      description,
      inputSchema: t.spec.function.parameters,
      annotations,
      ...(note ? { _note: note } : {}),
      // Claude Code prompts the user on every call of a tool carrying this key, in every permission
      // mode — the one documented client-side control for irreversible operations.
      ...(annotations.destructiveHint ? { _meta: { 'anthropic/requiresUserInteraction': true } } : {})
    }
  })
  return [orientation, ...rest]
}
