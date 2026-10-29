/**
 * Composition point for the assistant's IPC surface. The handlers themselves live in `../ipc/*`,
 * one module per concern — chat (the agent run + UI-tool round-trip), keys, the report writers,
 * the read-only info surface, and the app settings (not an AI concern; registered here only
 * because this is where main wires its IPC).
 *
 * The registrars share exactly one piece of state: the run registry (`RunControllers`), created
 * HERE per call and handed to chat and report — never module state, so a test can build the whole
 * surface fresh.
 */
import type { BrowserWindow } from 'electron'

import { registerChatIpc, type ChatIpcControl } from '../ipc/chat'
import { UiBridge } from '../ipc/uiBridge'
import { importMatchRunning, registerImportIpc } from '../ipc/import'
import { registerMcpIpc, type McpControl } from '../ipc/mcp'
import { registerInfoIpc } from '../ipc/info'
import { registerKeyIpc } from '../ipc/keys'
import { registerReportIpc } from '../ipc/report'
import { registerSettingsIpc } from '../ipc/settings'
import type { AiIpcDeps, RunControllers } from '../ipc/shared'
import { activeWork } from './activeWork'

interface MainDeps {
  apiRequest: (
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ) => Promise<{ status: number; body: unknown }>
  getWindow: () => BrowserWindow | null
  /** MCP activity → the idle quit of a bridge-launched app (see AiIpcDeps). */
  onMcpActivity?: () => void
  onMcpBusy?: (delta: 1 | -1) => void
}

export function registerAi(deps: MainDeps): {
  mcp: McpControl
  chat: ChatIpcControl
  /** The runs in this process that keep the computer awake (main/keepAwake.ts). */
  work: () => string[]
} {
  const ipcDeps: AiIpcDeps = deps
  // Settings first: it applies the stored mirrors (privacy, provider, throughput, spell check)
  // before anything can run a model — see registerSettingsIpc.
  registerSettingsIpc()
  const controllers: RunControllers = new Map()
  // One bridge for every party that drives the renderer — chat runs and, later, external-agent
  // sessions — so there is one 'ai:ui-result' handler and one record of open questions.
  const bridge = new UiBridge({
    getWindow: deps.getWindow,
    emit: (ev) => deps.getWindow()?.webContents.send('ai:event', ev)
  })
  bridge.registerIpc()
  const chat = registerChatIpc(ipcDeps, controllers, bridge)
  registerReportIpc(ipcDeps, controllers)
  registerKeyIpc(ipcDeps)
  registerInfoIpc(ipcDeps)
  registerImportIpc(ipcDeps)
  // The MCP server for external agents shares the bridge: its sessions ask the user through the
  // same cards as the chat. Started later by main/index.ts, once the backend is ready.
  const mcp = registerMcpIpc(ipcDeps, bridge)
  const work = (): string[] =>
    activeWork(
      controllers.keys(),
      bridge.pendingAsks.list().map((ask) => ask.chatId),
      importMatchRunning()
    )
  return { mcp, chat, work }
}
