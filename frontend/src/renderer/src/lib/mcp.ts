/**
 * The renderer's view of the MCP server for external agents (main/mcp, preload `prism.mcp`).
 * Thin wrappers, typed from shared/ipc.ts — one definition for main, preload and renderer.
 */
import type {
  McpApprovalMode,
  McpClientConfig,
  McpClientId,
  McpConfigureResult,
  McpEvent,
  McpStatus,
  McpTestResult
} from '../../../shared/ipc'

export type {
  McpApprovalMode,
  McpCallRecord,
  McpClientConfig,
  McpClientId,
  McpConfigureResult,
  McpEvent,
  McpSessionSnapshot,
  McpStatus,
  McpTestResult
} from '../../../shared/ipc'

/** What Settings and the panel show: the switch plus the live server state. */
export type McpStatusFull = McpStatus & { enabled: boolean }

export const mcpStatus = (): Promise<McpStatusFull> => window.prism.mcp.status() as Promise<McpStatusFull>
export const mcpSetEnabled = (on: boolean): Promise<McpStatusFull> =>
  window.prism.mcp.setEnabled(on) as Promise<McpStatusFull>
export const mcpRegenerateToken = (): Promise<McpStatusFull> =>
  window.prism.mcp.regenerateToken() as Promise<McpStatusFull>
export const mcpDisconnect = (sessionId: string): Promise<boolean> =>
  window.prism.mcp.disconnect(sessionId) as Promise<boolean>
export const mcpSetApproval = (sessionId: string, mode: McpApprovalMode): Promise<boolean> =>
  window.prism.mcp.setApproval(sessionId, mode) as Promise<boolean>
export const onMcpEvent = (cb: (ev: McpEvent) => void): (() => void) =>
  window.prism.mcp.onEvent((ev) => cb(ev as McpEvent))
/** The three clients: how each would be configured, and whether it already is. */
export const mcpClients = (): Promise<McpClientConfig[]> =>
  window.prism.mcp.clients() as Promise<McpClientConfig[]>
/** Write our entry into one client's configuration — only after the user saw the change and clicked. */
export const mcpConfigureClient = (id: McpClientId): Promise<McpConfigureResult> =>
  window.prism.mcp.configureClient(id) as Promise<McpConfigureResult>
/** Spawn our own bridge the way a client would and run initialize + tools/list through it. */
export const mcpTestConnection = (): Promise<McpTestResult> =>
  window.prism.mcp.testConnection() as Promise<McpTestResult>

export const APPROVAL_LABELS: Record<McpApprovalMode, string> = {
  'every-write': 'Ask before every change',
  irreversible: 'Ask only before irreversible operations',
  // Not "Never ask": deleting a model, a custom method or a family asks in every mode — they cannot
  // be undone and a client can approve calls on its own.
  never: 'Ask only before deleting'
}
