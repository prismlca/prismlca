/**
 * The Electron side of the MCP server: settings switch, the renderer's channels, and everything the
 * host needs from the app — window, keys, user-data path, the model that is open. The server itself
 * (main/mcp/server.ts) knows none of that and is tested without Electron.
 */
import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { McpHost } from '../mcp/server'
import { bridgeDisplayEnv, bridgeLaunchCommand } from '../mcp/proxyMain'
import {
  CLIENTS,
  claudeCodeAddCommand,
  claudeDesktopSnippet,
  codexSnippet,
  jsonHasEntry,
  mergeCodexToml,
  mergeJsonConfig,
  tomlHasEntry,
  type ClientId
} from '../mcp/clientConfig'
import { getSettings, setSettings } from '../settings'
import { computeDistances, distancesAvailable } from '../distance/service'
import { TurnBudget } from '../distance/types'
import { distanceKeys } from './distance'
import { queryEurostatEol } from '../eurostat/service'
import type { AiIpcDeps } from './shared'
import type { UiBridge } from './uiBridge'
import type {
  McpApprovalMode,
  McpClientConfig,
  McpConfigureResult,
  McpEvent,
  McpStatus,
  McpTestResult
} from '../../shared/ipc'

export interface McpControl {
  /** Called once the backend is ready: starts the server if the user switched it on earlier. */
  startIfEnabled: () => Promise<void>
  /** At quit: remove the endpoint file and drop the listener without waiting for anything. */
  shutdownNow: () => void
}

const APPROVAL_MODES: ReadonlySet<string> = new Set<McpApprovalMode>(['every-write', 'irreversible', 'never'])

/** Where each client keeps the file our entry goes into, on this platform. */
function clientConfigPath(id: ClientId): string {
  const home = homedir()
  switch (id) {
    case 'claude-code':
      return join(home, '.claude.json')
    case 'codex':
      return join(home, '.codex', 'config.toml')
    case 'claude-desktop':
      if (process.platform === 'win32')
        return join(
          process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
          'Claude',
          'claude_desktop_config.json'
        )
      if (process.platform === 'darwin')
        return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      return join(
        process.env.XDG_CONFIG_HOME ?? join(home, '.config'),
        'Claude',
        'claude_desktop_config.json'
      )
  }
}

function readIfExists(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null
  } catch {
    return null
  }
}

/** The three clients as Settings shows them: snippet, the proposed file, and whether it is done. */
function clientConfigs(): McpClientConfig[] {
  const cmd = bridgeLaunchCommand()
  return CLIENTS.map((spec): McpClientConfig => {
    const configPath = clientConfigPath(spec.id)
    const current = readIfExists(configPath)
    const base = {
      id: spec.id,
      label: spec.label,
      configHint: spec.configHint,
      configPath,
      exists: current !== null
    }
    try {
      if (spec.id === 'codex') {
        // Codex hands MCP servers a reduced environment; on Linux the bridge then has no display
        // and cannot start the app. The table carries the session's display variables.
        const codexCmd = { ...cmd, env: bridgeDisplayEnv() }
        return {
          ...base,
          configured: tomlHasEntry(current, codexCmd),
          snippet: codexSnippet(codexCmd),
          proposed: mergeCodexToml(current, codexCmd)
        }
      }
      return {
        ...base,
        configured: jsonHasEntry(current, cmd),
        snippet: spec.id === 'claude-code' ? claudeCodeAddCommand(cmd) : claudeDesktopSnippet(cmd),
        proposed: mergeJsonConfig(current, cmd)
      }
    } catch (e) {
      return {
        ...base,
        configured: false,
        snippet:
          spec.id === 'codex'
            ? codexSnippet(cmd)
            : spec.id === 'claude-code'
              ? claudeCodeAddCommand(cmd)
              : claudeDesktopSnippet(cmd),
        proposedError: `The file could not be read as ${spec.id === 'codex' ? 'TOML' : 'JSON'}: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  })
}

/** Write our entry — after the user saw `proposed` and clicked. The current file is kept beside it. */
function configureClient(id: ClientId): McpConfigureResult {
  const cfg = clientConfigs().find((c) => c.id === id)
  if (!cfg) return { ok: false, error: 'Unknown client.' }
  if (!cfg.proposed) return { ok: false, error: cfg.proposedError ?? 'Nothing to write.' }
  try {
    mkdirSync(dirname(cfg.configPath), { recursive: true })
    let backup: string | null = null
    if (existsSync(cfg.configPath)) {
      backup = `${cfg.configPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      copyFileSync(cfg.configPath, backup)
    }
    writeFileSync(cfg.configPath, cfg.proposed, 'utf-8')
    return { ok: true, path: cfg.configPath, backup }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Spawn our bridge exactly as a client would and run the handshake through it. */
async function testConnection(): Promise<McpTestResult> {
  const started = Date.now()
  const { command, args } = bridgeLaunchCommand()
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  const transport = new StdioClientTransport({ command, args, env, stderr: 'ignore' })
  const client = new Client({ name: 'PrismLCA self-test', version: app.getVersion() })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools(undefined, { timeout: 20_000 })
    const version = client.getServerVersion()?.version ?? '?'
    return { ok: true, tools: tools.length, version, ms: Date.now() - started }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await client.close().catch(() => undefined)
  }
}

export function registerMcpIpc(deps: AiIpcDeps, bridge: UiBridge): McpControl {
  const emit = (ev: McpEvent): void => {
    deps.getWindow()?.webContents.send('mcp:event', ev)
  }
  const host = new McpHost({
    version: app.getVersion(),
    userData: () => app.getPath('userData'),
    apiRaw: deps.apiRequest,
    emit,
    cancel: (sessionId, reason) => bridge.cancelSession(sessionId, reason),
    onActivity: deps.onMcpActivity,
    onBusy: deps.onMcpBusy,
    // The model the window shows, when there is a window (asked through the bridge, like
    // get_current_model does per call); otherwise the model opened most recently — the start
    // page's own notion of "current" — provided it still exists. Measured on the first bridge run
    // (01.10.2026): the two differed, and the session was pinned to the wrong one.
    currentModel: async () => {
      if (bridge.hasWindow()) {
        try {
          const state = (await bridge.call('get_state', {})) as { active_model?: unknown } | null
          if (state && typeof state.active_model === 'string' && state.active_model) return state.active_model
          if (state && state.active_model === null) return null
        } catch {
          // The window exists but did not answer (still loading): fall through to the recent list.
        }
      }
      const recent = getSettings().recentModels[0]?.db
      if (!recent) return null
      try {
        const { status, body } = await deps.apiRequest('GET', '/api/v1/databases')
        const list = status < 400 && Array.isArray(body) ? (body as Array<{ name?: string }>) : []
        return list.some((d) => d.name === recent) ? recent : null
      } catch {
        return null
      }
    },
    session: {
      ui: (sessionId, clientName, activeDb, name, args, signal) =>
        bridge.call(name, args, { sessionId, clientName, activeDb, signal }),
      settings: () => {
        const s = getSettings()
        return {
          disabledTools: s.disabledTools,
          preferredBackground: s.preferredBackground,
          eurostatEnabled: s.eurostatEnabled
        }
      },
      // Same three conditions as the chat (ipc/chat.ts): the app setting, a geocoding key — and
      // here one call budget per MCP call, because one call is the external agent's turn.
      makeDistances: (signal) => {
        const transport = getSettings().transport
        const keys = distanceKeys()
        if (!transport.toolEnabled || !distancesAvailable(transport, keys)) return undefined
        const turn = new TurnBudget(transport.perTurnCalls)
        return (mode, pairs) =>
          computeDistances(mode, pairs, { settings: transport, keys, turn, backend: deps.apiRequest, signal })
      },
      eurostat: (args) => queryEurostatEol(args)
    }
  })

  const status = (): McpStatus & { enabled: boolean } => ({
    enabled: getSettings().mcpEnabled,
    ...host.status()
  })

  ipcMain.handle('mcp:status', () => status())
  ipcMain.handle('mcp:setEnabled', async (_e, on: boolean) => {
    // Write through, like every other setting — and the switch IS the consent (default off).
    setSettings({ mcpEnabled: on === true })
    if (on === true) await host.start()
    else await host.stop()
    return status()
  })
  ipcMain.handle('mcp:regenerateToken', async () => {
    await host.regenerateToken()
    return status()
  })
  ipcMain.handle('mcp:disconnect', async (_e, sessionId: string) => host.disconnect(String(sessionId)))
  ipcMain.handle('mcp:setApproval', (_e, sessionId: string, mode: string) =>
    APPROVAL_MODES.has(mode) ? host.setApproval(String(sessionId), mode as McpApprovalMode) : false
  )
  ipcMain.handle('mcp:clients', () => clientConfigs())
  ipcMain.handle('mcp:configureClient', (_e, id: string) =>
    CLIENTS.some((c) => c.id === id)
      ? configureClient(id as ClientId)
      : { ok: false, error: 'Unknown client.' }
  )
  ipcMain.handle('mcp:testConnection', () => testConnection())

  return {
    startIfEnabled: async () => {
      if (!getSettings().mcpEnabled) return
      await host.start().catch((e) => console.error('[prism-mcp] could not start:', e))
    },
    shutdownNow: () => host.shutdownNow()
  }
}
