/**
 * How long an external agent's question or approval card may stay open. The client sees progress
 * notifications meanwhile (server.ts) and its own tool timeout is finite — fifteen minutes is the
 * longest a card waits before the call is answered "no answer" (a sensible bound,
 * not an open-ended wait). A plain module: uiBridge.ts (Electron) and server.ts (tested under Node)
 * both read it.
 */
export const MCP_ASK_TIMEOUT_MS = 15 * 60_000
