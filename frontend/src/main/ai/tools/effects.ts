/**
 * What each tool — and each `action` of a consolidated tool — does to the user's world.
 *
 * This is the source for the MCP annotations (`readOnlyHint` / `destructiveHint`) and for the app's
 * approval mode ("ask before every write" / "ask only before irreversible" / "don't ask"), and
 * the MCP server reads the same table. It is deliberately NOT derived from MUTATING_TOOLS: that set is the
 * canvas-refresh list and misses writers that never touch the graph (scenarios, study meta, LCIA
 * methods). Every entry here was checked against the implementation, not the description.
 *
 *   read          no state change in the backend, the app settings or on disk
 *   write         changes state, but the change is on the undo stack or trivially reversible
 *   irreversible  gone for good: deletes of models/methods/families, anything off the undo stack that
 *                 overwrites or evicts, undo/redo themselves, append-only logs nobody can take back
 *
 * It imports nothing at all (not even the registry), so it loads in plain Node and outside Electron;
 * effects.test.ts holds it against the registered specs.
 */

export type ToolEffect = 'read' | 'write' | 'irreversible'

/**
 * The parameter that selects the operation, for the tools that have one. Tools not listed here have
 * a single implicit action, `'*'`. Parameters that pick data rather than an operation — `distances`
 * mode (road/sea/…), `setup_results` tab, `eurostat_eol` dataset — are deliberately not listed.
 */
export const ACTION_PARAM: Record<string, string> = {
  explain_result: 'mode',
  lookup: 'kind',
  history: 'action',
  manage_model: 'action',
  model_info: 'action',
  edit_exchange: 'action',
  edit_parameter: 'action',
  edit_scenario: 'action',
  edit_lcia_method: 'action',
  manage_method_family: 'action',
  edit_tags: 'action',
  canvas_view: 'action'
}

/** tool name → action → effect; '*' for tools without an action parameter */
export const TOOL_EFFECTS: Record<string, Record<string, ToolEffect>> = {
  // MCP-only (catalog.ts): answered by the session itself, nothing is written. Without a row the
  // fail-closed default labelled every session's first call IRREVERSIBLE in the drawer.
  orientation: { '*': 'read' },
  list_models: { '*': 'read' },
  get_current_model: { '*': 'read' },
  // POST /search/activities is a query; the run memory (`searched`) is not user state.
  search_background: { '*': 'read' },
  list_activities: { '*': 'read' },
  get_process_details: { '*': 'read' },
  get_flow_properties: { '*': 'read' },
  get_model_graph: { '*': 'read' },
  list_methods: { '*': 'read' },
  search_elementary_flows: { '*': 'read' },
  list_tags: { '*': 'read' },
  check_model_health: { '*': 'read' },
  get_audit: { '*': 'read' },
  get_skill: { '*': 'read' },
  calculate: { '*': 'read' },
  compare: { '*': 'read' },
  // Deletes the whole database; model-level operations are not on the undo stack.
  delete_model: { '*': 'irreversible' },
  create_process: { '*': 'write' },
  edit_process: { '*': 'write' },
  // DeleteActivityCommand is undoable and the tool does not ask first.
  delete_process: { '*': 'write' },
  set_classification: { '*': 'write' },
  set_flow_properties: { '*': 'write' },
  // POST /params/evaluate computes against the live parameters and stores nothing.
  evaluate_formula: { '*': 'read' },
  list_parameters: { '*': 'read' },
  list_scenarios: { '*': 'read' },
  // Applies each scenario inside a window and restores the live state; nothing is kept.
  compare_scenarios: { '*': 'read' },
  get_characterization_factors: { '*': 'read' },
  list_method_families: { '*': 'read' },
  get_method_factors: { '*': 'read' },
  search_biosphere_flows: { '*': 'read' },
  // research_bom / research_web / distances / eurostat_eol / review_model append a note to the
  // model's provenance log (/provenance/research, /provenance/review) — additive, idempotent, a record
  // OF the call rather than a change the user made. Not undoable, but nothing of the user's is lost, and
  // an approval mode that prompted before every web search or distance lookup would be unusable
  // (decided while classifying). So: 'read'. The external services they reach are the
  // privacy question, and that one is answered by the switches that make these tools exist at all.
  research_bom: { '*': 'read' },
  research_web: { '*': 'read' },
  distances: { '*': 'read' },
  eurostat_eol: { '*': 'read' },
  review_model: { '*': 'read' },
  // Renames the chat; the user can rename it back.
  set_chat_title: { '*': 'write' },
  // Writes the chat's plan to disk (chat state, not model data); the next revision reverses it.
  plan: { '*': 'write' },
  ask_user: { '*': 'read' },
  get_canvas: { '*': 'read' },
  screenshot_canvas: { '*': 'read' },
  // Conservative: changes what the results page shows (no model state), which a reader does not do.
  calculate_in_canvas: { '*': 'write' },
  // Conservative: configures (and may persist) the result view; UI state only, trivially reversible.
  setup_results: { '*': 'write' },
  // All four are Scenario commands on the undo stack, delete included.
  edit_scenario: { create: 'write', set_value: 'write', duplicate: 'write', delete: 'write' },
  // Custom LCIA methods are NOT on the undo stack. create/duplicate only add a new method, so they
  // stay 'write'; everything that changes or removes an existing method cannot be taken back.
  edit_lcia_method: {
    create: 'write',
    duplicate: 'write',
    rename: 'irreversible',
    set_factor: 'irreversible',
    remove_flow: 'irreversible',
    // Asks the user via ask_user before deleting.
    delete: 'irreversible'
  },
  manage_method_family: {
    // Conservative: creates OR overwrites an existing family's description, with no undo.
    upsert: 'irreversible',
    rename: 'irreversible',
    // Asks the user via ask_user; removes the family and all its methods.
    delete: 'irreversible'
  },
  manage_model: {
    // Additive: a new model, nothing existing changes (not undoable, but removable).
    create: 'write',
    duplicate: 'write',
    // Conservative: not on the undo stack, and every name-keyed store is cascaded to the new name.
    rename: 'irreversible'
  },
  // SetParameterCommand / SetParametersCommand / DeleteParameterCommand are all undoable.
  edit_parameter: { set: 'write', delete: 'write' },
  // Tag groups and values are only created (additive); assignments are SetTagCommand (undoable).
  edit_tags: {
    create_group: 'write',
    add_value: 'write',
    assign: 'write',
    merge_value: 'write',
    merge_group: 'write'
  },
  // View only ("nothing is deleted"): positions, viewport and the background reference boxes.
  canvas_view: {
    jump: 'read',
    layout: 'write',
    clear: 'write',
    remove: 'write',
    show: 'read',
    open_model: 'write',
    open_page: 'write'
  },
  // Undo/redo rewrite state the user may not expect: one global stack, whatever is on top.
  // Undo/redo take back (or redo) the agent's OWN change and are themselves reversible via the
  // other one; asking before each cost three clicks for one rename test (V390):
  // the agent may undo without a card — "ask before every write" still asks.
  history: { undo: 'write', redo: 'write' },
  explain_result: { tree: 'read', flows: 'read', inventory: 'read', matrix: 'read' },
  // SetStudyMetaCommand is undoable.
  model_info: { get: 'read', set: 'write' },
  // Every exchange command is undoable; replace_input is add + remove.
  edit_exchange: {
    add: 'write',
    set_amount: 'write',
    set_formula: 'write',
    set_comment: 'write',
    remove: 'write',
    replace_input: 'write'
  },
  lookup: { geographies: 'read', classification: 'read', source: 'read' }
}

const RANK: Record<ToolEffect, number> = { read: 0, write: 1, irreversible: 2 }

function worst(effects: ToolEffect[]): ToolEffect {
  return effects.reduce<ToolEffect>((w, e) => (RANK[e] > RANK[w] ? e : w), 'read')
}

function named(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * The effect of ONE call. Fails closed: an unknown tool or an unknown action is 'irreversible'.
 * A call without an action takes the tool's worst action, because a default (`edit_parameter` falls
 * back to "set") or a batch path (`edit_tags` assignments) may route it anywhere in the tool. Batch
 * items that carry their own action (`edit_exchange` exchanges[]) count too, and the worst one wins.
 */
export function effectOf(tool: string, args: Record<string, unknown> | undefined): ToolEffect {
  const table = TOOL_EFFECTS[tool]
  if (!table) return 'irreversible'
  if ('*' in table) return table['*']
  const param = ACTION_PARAM[tool]
  const top = param ? named(args?.[param]) : undefined
  if (!top) return worst(Object.values(table))
  const actions = [top]
  for (const v of Object.values(args ?? {})) {
    if (!Array.isArray(v)) continue
    for (const item of v) {
      const a = item && typeof item === 'object' ? named((item as Record<string, unknown>)[param]) : undefined
      if (a) actions.push(a)
    }
  }
  return worst(actions.map((a) => table[a] ?? 'irreversible'))
}

/**
 * The calls that change what the canvas DRAWS — boxes appear or go, arrows are drawn or removed — as
 * opposed to what it labels (amounts, names, tags). After a turn with one of these the chat fits the
 * canvas to the view (after an agent run the new processes sat outside the frame
 * and "Fit view" had to be pressed by hand). A turn that only read, calculated or set parameters
 * leaves the view where the user put it. `history` is in because an undo can take back anything.
 */
const STRUCTURE_ACTIONS: Record<string, readonly string[] | '*'> = {
  create_process: '*',
  delete_process: '*',
  edit_exchange: ['add', 'remove', 'replace_input'],
  history: '*'
}

/** Did this call change the canvas's structure? A call without an action counts if any could. */
export function changesStructure(tool: string, args: Record<string, unknown> | undefined): boolean {
  const rule = STRUCTURE_ACTIONS[tool]
  if (!rule) return false
  if (rule === '*') return true
  const param = ACTION_PARAM[tool]
  const top = param ? named(args?.[param]) : undefined
  if (!top) return true
  const actions = [top]
  for (const v of Object.values(args ?? {})) {
    if (!Array.isArray(v)) continue
    for (const item of v) {
      const a = item && typeof item === 'object' ? named((item as Record<string, unknown>)[param]) : undefined
      if (a) actions.push(a)
    }
  }
  return actions.some((a) => rule.includes(a))
}

/** MCP tool annotations. A tool with mixed actions is annotated conservatively (not read-only). */
export function toolAnnotations(tool: string): {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint?: boolean
} {
  const table = TOOL_EFFECTS[tool]
  if (!table) return { readOnlyHint: false, destructiveHint: true }
  const effects = Object.values(table)
  return {
    readOnlyHint: effects.every((e) => e === 'read'),
    destructiveHint: effects.some((e) => e === 'irreversible')
  }
}
