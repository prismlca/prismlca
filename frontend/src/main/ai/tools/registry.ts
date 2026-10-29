/**
 * The assembled tool surface. TOOLS order is SEMANTIC — it is the display order of the
 * Settings → AI-Tools panel and the order of docs/ai-tool-manifest.json — so it is spelled
 * out here explicitly instead of depending on group concatenation. The asserts below turn a
 * forgotten registration or a typo into a startup crash instead of a silently shorter list.
 */
import type { Tool } from './context'
import { IMPL } from './impl'
import { readTools } from './groups/read'
import { calcTools } from './groups/calc'
import { modelTools } from './groups/model'
import { paramsTools } from './groups/params'
import { lciaTools } from './groups/lcia'
import { tagsTools } from './groups/tags'
import { researchTools } from './groups/research'
import { reviewTools } from './groups/review'
import { canvasTools } from './groups/canvas'
import { historyTools } from './groups/history'
import { distancesTools } from './groups/distances'
import { eurostatTools } from './groups/eurostat'
import { planTools } from './groups/plan'

const ALL: Tool[] = [
  ...readTools,
  ...calcTools,
  ...modelTools,
  ...paramsTools,
  ...lciaTools,
  ...tagsTools,
  ...researchTools,
  ...reviewTools,
  ...canvasTools,
  ...historyTools,
  ...distancesTools,
  ...eurostatTools,
  ...planTools
]

/** The monolith's definition order, preserved verbatim across the split. */
const TOOL_ORDER: string[] = [
  'list_models',
  'get_current_model',
  'search_background',
  'list_activities',
  'get_process_details',
  'get_flow_properties',
  'get_model_graph',
  'list_methods',
  'search_elementary_flows',
  'list_tags',
  'check_model_health',
  'get_audit',
  'get_skill',
  'calculate',
  'compare',
  'delete_model',
  'create_process',
  'edit_process',
  'delete_process',
  'set_classification',
  'set_flow_properties',
  'evaluate_formula',
  'list_parameters',
  'list_scenarios',
  'compare_scenarios',
  'get_characterization_factors',
  'list_method_families',
  'get_method_factors',
  'search_biosphere_flows',
  'research_bom',
  'research_web',
  'distances',
  'eurostat_eol',
  'review_model',
  'set_chat_title',
  'ask_user',
  'get_canvas',
  'screenshot_canvas',
  'calculate_in_canvas',
  'setup_results',
  'edit_scenario',
  'edit_lcia_method',
  'manage_method_family',
  'manage_model',
  'edit_parameter',
  'edit_tags',
  'canvas_view',
  'history',
  'explain_result',
  'model_info',
  'edit_exchange',
  'lookup',
  'plan'
]

const byName = new Map(ALL.map((t) => [t.spec.function.name, t]))
if (byName.size !== ALL.length) throw new Error('duplicate tool name in a group file')
if (TOOL_ORDER.length !== ALL.length || TOOL_ORDER.some((n) => !byName.has(n)))
  throw new Error('TOOL_ORDER and the group files disagree — a tool was added to one but not the other')

export const TOOLS: Tool[] = TOOL_ORDER.map((n) => byName.get(n) as Tool)

export const TOOL_BY_NAME: Record<string, Tool> = Object.fromEntries(
  TOOLS.map((t) => [t.spec.function.name, t])
)

/**
 * Implementation names that are NOT callable tools — the internals behind the consolidated surface.
 *
 * Exported for one guard test, and worth the export: these read exactly like tool names, so they leak
 * into descriptions and hints, and a model that follows such a line calls something that does not
 * exist. Three had (`set_model_info` in the goal & scope hint, `set_method_factor` in both flow
 * searches); the built-in skills had five more of the same kind. Derived, not listed, so it cannot
 * fall behind a rename.
 */
export const NON_TOOL_IMPL_NAMES: string[] = Object.keys(IMPL).filter((n) => !(n in TOOL_BY_NAME))

/**
 * Tools that change the model/tags/databases — after each of these the canvas + audit + database
 * list + tag groups must be reloaded, otherwise the user sees a stale canvas until a manual reload.
 * (UI tools like auto_layout / jump_to_process / setup_results already act on the UI directly.)
 */
export const MUTATING_TOOLS = new Set<string>([
  'manage_model',
  'delete_model',
  'create_process',
  'edit_process',
  'delete_process',
  'edit_exchange',
  'set_classification',
  'set_flow_properties',
  'edit_tags',
  // Parameter edits recompute every dependent exchange amount — the canvas draws those amounts on
  // its arrows, so it goes stale unless we reload after them (scenario/LCIA tools don't touch the graph).
  'edit_parameter',
  'history'
])

/**
 * Tools whose calls may run CONCURRENTLY when the model issues several of them in one round (V285).
 *
 * The round loop is sequential by design — most tools mutate the model, and their order is
 * semantics. But the model regularly batches the network-bound read-only calls into one round and
 * announces them as parallel, and they were not: in a real pavilion run, research_bom
 * (181 s) and research_web (576 s) stood in one round and ran back to back — 758 s of wall clock
 * where the slower leg alone would have been 576.
 *
 * Deliberately narrow. In or out is not "does it write the model" but "can two of them share a
 * moment": the calculation endpoints supersede each other per channel (a parallel contribution
 * call answers 409), compare_scenarios applies scenario windows to the live parameter state,
 * review_model does both, ask_user talks to a human, and the canvas tools go through the renderer.
 * None of that belongs in a Promise.all. What remains is search and research — reads with no
 * channel, no window and no UI, which also happen to be the only calls that take minutes.
 *
 * So this is NOT derivable from effects.ts — `read` there includes calculate and compare_scenarios.
 * Codex keeps the same split: each built-in handler declares `supports_parallel_tool_calls` itself,
 * and only foreign MCP tools are admitted by their read-only hint (codex-rs/core/src/tools/handlers/
 * mcp.rs). effects.test.ts holds the one direction that is a safety property: every
 * tool in here is a read in every action.
 */
export const PARALLEL_SAFE_TOOLS = new Set<string>([
  'research_web',
  'research_bom',
  // External geocoding/routing calls with their own rate gate; no channel, no window, no UI.
  'distances',
  // A cached GET against Eurostat's public API; same reasoning.
  'eurostat_eol',
  'search_background',
  'get_process_details',
  'list_methods'
])
