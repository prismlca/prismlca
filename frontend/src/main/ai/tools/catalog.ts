import { TOOLS } from './registry'

/**
 * Human-readable catalog metadata for the Settings → AI-Tools panel: a friendly label plus a
 * one-line hover hint per tool, grouped for display. Every tool in TOOLS must have an entry
 * (toolCatalog falls back to the technical name so a missing entry degrades gracefully).
 */
export const TOOL_META: Record<string, { label: string; hint: string; group: string }> = {
  // read & search
  list_models: {
    label: 'List models & databases',
    hint: 'Lists your models and the read-only background databases.',
    group: 'Read & search'
  },
  get_current_model: {
    label: 'Get current model',
    hint: 'Tells the assistant which model is open on the canvas.',
    group: 'Read & search'
  },
  get_model_info: {
    label: 'Read goal & scope',
    hint: 'Reads a model’s study metadata (goal & scope, functional unit, …).',
    group: 'Read & search'
  },
  search_background: {
    label: 'Search background database',
    hint: 'Semantic search over the released background databases to find activities to use as inputs.',
    group: 'Read & search'
  },
  list_activities: {
    label: 'List processes',
    hint: 'Lists the processes of a model or database.',
    group: 'Read & search'
  },
  get_process_details: {
    label: 'Get process details',
    hint: 'Reads one process in full: fields, classification, inputs and outputs.',
    group: 'Read & search'
  },
  get_flow_properties: {
    label: 'Get flow properties',
    hint: 'Reads the reference product’s properties (carbon content, price, …).',
    group: 'Read & search'
  },
  get_model_graph: {
    label: 'Get model graph',
    hint: 'Reads the node-and-edge structure of a model, as shown on the canvas.',
    group: 'Read & search'
  },
  list_geographies: {
    label: 'List geographies',
    hint: 'Lists the regions available in a database, for filtering searches.',
    group: 'Read & search'
  },
  list_methods: {
    label: 'List impact methods',
    hint: 'Lists the available LCIA methods (GWP, ReCiPe, …).',
    group: 'Read & search'
  },
  search_elementary_flows: {
    label: 'Search elementary flows',
    hint: 'Finds biosphere flows (emissions/resources) to attach to a process.',
    group: 'Read & search'
  },
  lookup_classification: {
    label: 'Look up classifications',
    hint: 'Looks up valid ISIC sections and CPC classes.',
    group: 'Read & search'
  },
  list_tags: {
    label: 'List tags',
    hint: 'Lists tag groups and values, or one process’s assigned tags.',
    group: 'Read & search'
  },
  check_model_health: {
    label: 'Check model health',
    hint: 'Runs the structural model linter (missing units, broken links, …).',
    group: 'Read & search'
  },
  get_audit: {
    label: 'Read audit log',
    hint: 'Reads recent changes and undo/redo availability.',
    group: 'Read & search'
  },
  get_skill: {
    label: 'Load a skill',
    hint: 'Loads the full instructions of one of your skills.',
    group: 'Read & search'
  },
  // calculate
  calculate: {
    label: 'Calculate impact score',
    hint: 'Computes LCIA scores for a process and one or more methods.',
    group: 'Calculate'
  },
  contribution: {
    label: 'Analyse hotspots',
    hint: 'Finds the top contributing processes behind a score.',
    group: 'Calculate'
  },
  top_elementary_flows: {
    label: 'Top elementary flows',
    hint: 'Shows which emissions/resources drive a score.',
    group: 'Calculate'
  },
  compare: {
    label: 'Compare processes',
    hint: 'Scores several processes across several methods.',
    group: 'Calculate'
  },
  // edit model
  create_model: { label: 'Create model', hint: 'Creates a new empty foreground model.', group: 'Edit model' },
  duplicate_model: {
    label: 'Duplicate model',
    hint: 'Copies a foreground model under a new name.',
    group: 'Edit model'
  },
  rename_model: { label: 'Rename model', hint: 'Renames a foreground model.', group: 'Edit model' },
  delete_model: {
    label: 'Delete model',
    hint: 'Deletes a whole model — destructive and not undoable.',
    group: 'Edit model'
  },
  create_process: {
    label: 'Create process',
    hint: 'Creates a new process in a foreground model.',
    group: 'Edit model'
  },
  edit_process: {
    label: 'Edit process',
    hint: 'Changes a process’s name, product, unit, location or comment.',
    group: 'Edit model'
  },
  delete_process: { label: 'Delete process', hint: 'Deletes a foreground process.', group: 'Edit model' },
  add_exchange: {
    label: 'Add input / exchange',
    hint: 'Links an input (activity or elementary flow) to a process.',
    group: 'Edit model'
  },
  set_exchange_amount: {
    label: 'Change exchange amount',
    hint: 'Changes the amount of an existing exchange.',
    group: 'Edit model'
  },
  remove_exchange: {
    label: 'Remove exchange',
    hint: 'Removes an input link from a process.',
    group: 'Edit model'
  },
  set_classification: {
    label: 'Set classification',
    hint: 'Sets the ISIC section / CPC class of a process.',
    group: 'Edit model'
  },
  set_flow_properties: {
    label: 'Set flow properties',
    hint: 'Sets reference-product properties (carbon content, price, …).',
    group: 'Edit model'
  },
  set_model_info: {
    label: 'Update goal & scope',
    hint: 'Updates a model’s study metadata (goal & scope, functional unit, …).',
    group: 'Edit model'
  },
  // parameters & formulas
  list_parameters: {
    label: 'List parameters',
    hint: 'Lists the active model’s named variables, formulas and comments.',
    group: 'Parameters'
  },
  evaluate_formula: {
    label: 'Try a formula',
    hint: 'Works out what a formula would come to, without changing anything.',
    group: 'Parameters'
  },
  set_parameter: {
    label: 'Create / update parameter',
    hint: 'Creates or updates a parameter (value or formula) of the active model.',
    group: 'Parameters'
  },
  delete_parameter: {
    label: 'Delete parameter',
    hint: 'Deletes a parameter of the active model by name.',
    group: 'Parameters'
  },
  set_exchange_formula: {
    label: 'Drive amount by formula',
    hint: 'Makes an exchange amount follow a formula instead of a fixed number.',
    group: 'Parameters'
  },
  // tags
  create_tag_group: {
    label: 'Create tag group',
    hint: 'Creates a new tag group (dimension).',
    group: 'Tags'
  },
  add_tag_value: { label: 'Add tag value', hint: 'Adds an allowed value to a tag group.', group: 'Tags' },
  set_tag: { label: 'Assign tag', hint: 'Assigns a tag value to one or more processes.', group: 'Tags' },
  // history
  undo: { label: 'Undo', hint: 'Undoes the last action.', group: 'History' },
  redo: { label: 'Redo', hint: 'Redoes the last undone action.', group: 'History' },
  // canvas & UI
  set_chat_title: {
    label: 'Name the chat',
    hint: 'Gives this conversation a short title.',
    group: 'Canvas & UI'
  },
  ask_user: {
    label: 'Ask the user',
    hint: 'Asks you a question in the chat, with options or room for your own answer, and waits for it.',
    group: 'Canvas & UI'
  },
  jump_to_process: {
    label: 'Jump to process',
    hint: 'Centres and selects a process on the canvas.',
    group: 'Canvas & UI'
  },
  auto_layout: {
    label: 'Auto-layout canvas',
    hint: 'Re-arranges the canvas nodes automatically.',
    group: 'Canvas & UI'
  },
  get_canvas: {
    label: 'Read canvas',
    hint: 'Reads what is currently drawn on the canvas.',
    group: 'Canvas & UI'
  },
  clear_canvas: {
    label: 'Clear canvas view',
    hint: 'Removes background reference boxes from the view (nothing is deleted).',
    group: 'Canvas & UI'
  },
  remove_from_canvas: {
    label: 'Remove from canvas',
    hint: 'Removes one background reference box from the view.',
    group: 'Canvas & UI'
  },
  screenshot_canvas: {
    label: 'Screenshot canvas',
    hint: 'Captures the canvas as an image (vision models only).',
    group: 'Canvas & UI'
  },
  calculate_in_canvas: {
    label: 'Calculate in canvas',
    hint: 'Triggers the canvas Calculate and shows the result to the user.',
    group: 'Canvas & UI'
  },
  setup_results: {
    label: 'Set up results view',
    hint: 'Opens and configures the Results page.',
    group: 'Canvas & UI'
  },
  // consolidated tools (what the model actually sees)
  edit_scenario: {
    label: 'Create / change scenario',
    hint: 'Creates, copies, edits or deletes a scenario of the active model.',
    group: 'Scenarios'
  },
  edit_lcia_method: {
    label: 'Create / change LCIA method',
    hint: 'Duplicates or builds a custom method and edits its factors and flows.',
    group: 'LCIA methods'
  },
  manage_method_family: {
    label: 'Manage method family',
    hint: 'Creates, describes, renames or deletes one of your LCIA families.',
    group: 'LCIA methods'
  },
  manage_model: {
    label: 'Create / copy / rename model',
    hint: 'Creates a model, duplicates one, or renames it (not undoable).',
    group: 'Edit model'
  },
  edit_parameter: {
    label: 'Create / change parameter',
    hint: 'Sets a parameter (value or formula) or deletes it.',
    group: 'Parameters'
  },
  edit_tags: {
    label: 'Manage & assign tags',
    hint: 'Creates tag groups, adds allowed values and tags processes.',
    group: 'Tags'
  },
  canvas_view: {
    label: 'Change the canvas view',
    hint: 'Jumps to a process, re-arranges nodes, or clears background boxes from the view.',
    group: 'Canvas & UI'
  },
  history: { label: 'Undo / redo', hint: 'Undoes or redoes the last model change.', group: 'History' },
  plan: {
    label: 'Task plan',
    hint: 'Keeps the step list shown beside the chat on longer tasks (only on models that use one).',
    group: 'Plan'
  },
  explain_result: {
    label: 'Explain a result',
    hint: 'Contribution tree or top elementary flows behind a score.',
    group: 'Calculate'
  },
  model_info: {
    label: 'Read / update goal & scope',
    hint: 'Reads or merges the study metadata of a model.',
    group: 'Read & search'
  },
  edit_exchange: {
    label: 'Add / change exchange',
    hint: 'Adds an input, changes its amount, drives it by a formula, or removes it.',
    group: 'Edit model'
  },
  lookup: {
    label: 'Look up vocabularies',
    hint: 'Valid geographies, ISIC sections and CPC classes for arguments.',
    group: 'Read & search'
  },
  // research (sub-agent)
  research_bom: {
    label: 'Research a bill of materials',
    hint: 'Researches a product’s components, materials and masses on the web (isolated, read-only, with sources).',
    group: 'Research'
  },
  research_web: {
    label: 'Research a question on the web',
    hint: 'Sourced findings from an isolated web search — EoL splits, compositions, prices.',
    group: 'Research'
  },
  distances: {
    label: 'Transport distances',
    hint: 'Road, sea, air and rail kilometres between places via openrouteservice / searoute (needs a key under Settings → Transport distances).',
    group: 'Research'
  },
  eurostat_eol: {
    label: 'Eurostat EoL statistics',
    hint: 'Official EU waste-treatment mixes, packaging and municipal-waste statistics (Eurostat, free, no key) for end-of-life scenarios.',
    group: 'Research'
  },
  review_model: {
    label: 'Review the model critically',
    hint: 'Independent second opinion on a finished system: boundaries, proxies, method choice, hotspots.',
    group: 'Research'
  },
  // scenarios
  list_scenarios: {
    label: 'List scenarios',
    hint: 'Lists the active model’s what-if scenarios.',
    group: 'Scenarios'
  },
  create_scenario: {
    label: 'Create scenario',
    hint: 'Creates a scenario (named parameter overrides) for the active model.',
    group: 'Scenarios'
  },
  set_scenario_value: {
    label: 'Set scenario value',
    hint: 'Sets one parameter override in a scenario.',
    group: 'Scenarios'
  },
  duplicate_scenario: {
    label: 'Duplicate scenario',
    hint: 'Copies a scenario under a new name.',
    group: 'Scenarios'
  },
  delete_scenario: { label: 'Delete scenario', hint: 'Deletes a scenario by id.', group: 'Scenarios' },
  compare_scenarios: {
    label: 'Compare scenarios',
    hint: 'Scores the baseline and chosen scenarios for one indicator.',
    group: 'Scenarios'
  },
  // characterization factors
  get_characterization_factors: {
    label: 'Compare characterization factors',
    hint: 'Inspects/compares up to 4 indicators’ factors per flow.',
    group: 'Calculate'
  },
  // custom LCIA methods
  list_method_families: {
    label: 'List method families',
    hint: 'Lists LCIA families and indicators; marks your editable custom ones.',
    group: 'LCIA methods'
  },
  get_method_factors: {
    label: 'Read method factors',
    hint: 'Reads one method’s flows and characterization factors.',
    group: 'LCIA methods'
  },
  search_biosphere_flows: {
    label: 'Search flows for a method',
    hint: 'Finds biosphere flows (with ids) to add to a custom method.',
    group: 'LCIA methods'
  },
  duplicate_lcia_method: {
    label: 'Duplicate LCIA method',
    hint: 'Copies a method into an editable one in your family.',
    group: 'LCIA methods'
  },
  create_lcia_method: {
    label: 'Create LCIA method',
    hint: 'Creates an empty custom method in your family.',
    group: 'LCIA methods'
  },
  set_method_factor: {
    label: 'Set method factor',
    hint: 'Sets/adds a flow’s characterization factor in a custom method.',
    group: 'LCIA methods'
  },
  remove_method_flow: {
    label: 'Remove method flow',
    hint: 'Removes a flow from a custom method.',
    group: 'LCIA methods'
  },
  rename_lcia_method: {
    label: 'Rename LCIA method',
    hint: 'Renames a custom method.',
    group: 'LCIA methods'
  },
  set_method_family: {
    label: 'Create/describe family',
    hint: 'Creates a custom family or sets its description.',
    group: 'LCIA methods'
  },
  edit_method_family: {
    label: 'Edit family',
    hint: 'Renames a custom family and/or sets its description.',
    group: 'LCIA methods'
  },
  delete_lcia_method: {
    label: 'Delete LCIA method',
    hint: 'Deletes a custom method (asks to confirm; not undoable).',
    group: 'LCIA methods'
  },
  delete_method_family: {
    label: 'Delete family',
    hint: 'Deletes a custom family and its methods (asks to confirm).',
    group: 'LCIA methods'
  }
}

export interface ToolCatalogEntry {
  name: string
  label: string
  hint: string
  group: string
}

/** The full tool catalog for the Settings → AI-Tools panel (display order = definition order). */
export function toolCatalog(): ToolCatalogEntry[] {
  return TOOLS.map((t) => {
    const name = t.spec.function.name
    const meta = TOOL_META[name]
    return { name, label: meta?.label ?? name, hint: meta?.hint ?? '', group: meta?.group ?? 'Other' }
  })
}
