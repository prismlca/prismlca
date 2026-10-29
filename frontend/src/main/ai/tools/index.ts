/**
 * Barrel of the tool package — every name the monolithic tools.ts used to export, unchanged,
 * so `import … from './tools'` (agent, ipc, tests, the manifest dump) keeps resolving.
 */
export type { Tool, ToolCtx } from './context'
export { TOOLS, TOOL_BY_NAME, NON_TOOL_IMPL_NAMES, MUTATING_TOOLS, PARALLEL_SAFE_TOOLS } from './registry'
export { toolCatalog } from './catalog'
export type { ToolCatalogEntry } from './catalog'
export { toolSpecs, groupsForConversation } from './focus'
export { RESEARCH_CAP_PHRASE } from './format'
export {
  inspectedKey,
  NEEDS_A_LOOK,
  NEEDS_A_LOOK_TOP_N,
  NEEDS_A_LOOK_FLOOR,
  linkedHotspots,
  needsALook,
  unopenedLinkedHotspots
} from './advice/hotspots'
export type { LinkedHotspot } from './advice/hotspots'
export { trimUnitNotes, withSearchWarnings } from './advice/warnings'
