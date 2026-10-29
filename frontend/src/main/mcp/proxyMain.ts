/**
 * `PrismLCA --mcp-proxy`: the Electron binary as the stdio bridge (main/mcp/proxy.ts), so no client
 * ever needs Node or uv installed — the lesson of the Blender and Unity MCP issue trackers, and the
 * step JetBrains took when it folded its npm proxy into the IDE.
 *
 * The same build as the app: the catalogue it shows before the app answers is the app's registry,
 * and the version it checks against the endpoint file is the app's own. For an AppImage the client
 * command is the AppImage itself with `--mcp-proxy`; the mount path never has to be known.
 *
 * Stdout belongs to the protocol. Nothing in this mode may print there — console.log is routed to
 * stderr before anything else runs.
 */
import { app } from 'electron'
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { getSettings } from '../settings'
import { mcpToolDefs } from './catalog'
import { readEndpoint, type EndpointInfo } from './endpoint'
import { BridgeError, ProxyCore, createProxyServer, createShutdown } from './proxy'
import { appLaunchCommandFor } from './clientConfig'
import { resolveDisplayEnv } from './displayEnv'
import { BRIDGE_LAUNCH_FLAG } from './idleQuit'

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: the process exists but is not ours — alive as far as we are concerned.
    return (e as { code?: string }).code === 'EPERM'
  }
}

async function health(info: EndpointInfo): Promise<boolean> {
  const base = info.url.replace(/\/mcp$/, '')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 2000)
  try {
    const r = await fetch(`${base}/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: ctrl.signal
    })
    return r.ok
  } finally {
    clearTimeout(timer)
  }
}

/** How to start the app from the bridge: packaged = this very binary; dev = electron + the app dir. */
export function appLaunchCommand(): { command: string; args: string[] } {
  return appLaunchCommandFor({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
    appImage: process.env.APPIMAGE
  })
}

/**
 * How a client starts the bridge — the command the Settings page hands out. On Linux the headless
 * platform goes on the COMMAND LINE: Chromium chooses its platform before the main script runs, so
 * `app.commandLine.appendSwitch` in index.ts came too late (measured under Codex: the
 * bridge still died with "Missing X server or $DISPLAY" although the switch was appended).
 */
export function bridgeLaunchCommand(): { command: string; args: string[] } {
  const base = appLaunchCommand()
  const headless = process.platform === 'linux' ? ['--ozone-platform=headless'] : []
  return { command: base.command, args: [...base.args, '--mcp-proxy', ...headless] }
}

/** Launch logs older than a day go; the newest few stay for a user who wants to send one along. */
function sweepLaunchLogs(dir: string): void {
  try {
    const cutoff = Date.now() - 24 * 3600_000
    for (const name of readdirSync(dir)) {
      if (!/^mcp-launch-.*\.log$/.test(name)) continue
      const p = join(dir, name)
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
    }
  } catch {
    /* a sweep that fails costs a stale log file, nothing else */
  }
}

/**
 * The environment a client should hand the bridge on Linux so that it can start the app: the
 * display and session variables of the user's session, as the app sees them now. They are a
 * starting point — the bridge re-checks them against the live session at launch (resolveDisplayEnv).
 * Only for clients that strip the environment (Codex); Claude Code and Claude Desktop inherit theirs.
 */
export function bridgeDisplayEnv(): Record<string, string> {
  if (process.platform !== 'linux') return {}
  const out: Record<string, string> = {}
  for (const k of [
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'XAUTHORITY'
  ]) {
    const v = process.env[k]
    if (v) out[k] = v
  }
  return out
}

export async function runProxyMain(): Promise<void> {
  const log = (m: string): void => {
    process.stderr.write(`[prism-mcp-bridge] ${m}\n`)
  }
  // Logging is best effort: a client that stops reading stderr must not take the bridge with it. A line
  // written into the closed pipe raises EPIPE, and unheard that is the same uncaught crash as on stdout.
  process.stderr.on('error', () => {})
  // Belt and braces: anything that logs the old way lands on stderr, never in the protocol stream.
  console.log = (...a: unknown[]) => console.error(...a)
  console.info = (...a: unknown[]) => console.error(...a)
  await app.whenReady()
  const userData = app.getPath('userData')
  const deps = {
    version: app.getVersion(),
    endpoint: () => readEndpoint(userData),
    isPidAlive: pidAlive,
    health,
    mcpEnabled: () => getSettings().mcpEnabled,
    launchApp: async () => {
      const { command, args } = appLaunchCommand()
      // The app learns it was started by a bridge, not by a person — it may then quit when nobody
      // claims it and the clients fall silent (mcp/idleQuit.ts).
      args.push(BRIDGE_LAUNCH_FLAG)
      const env = { ...process.env }
      // Inherited from a client that runs us as Node, this would turn the app into a Node process.
      delete env.ELECTRON_RUN_AS_NODE
      // The app is a window; without a display it dies on start. The values a client hands us may be
      // stale (a configuration written in an earlier login), so they are checked against the
      // live session and repaired from it where possible — see resolveDisplayEnv.
      if (process.platform === 'linux') {
        const { env: fixed, notes } = resolveDisplayEnv(env, {
          exists: existsSync,
          list: (d) => {
            try {
              return readdirSync(d)
            } catch {
              return []
            }
          },
          home: homedir()
        })
        for (const n of notes) log(n)
        if (!fixed.DISPLAY && !fixed.WAYLAND_DISPLAY)
          throw new BridgeError(
            'PrismLCA is not running, and the bridge has no usable display (DISPLAY / WAYLAND_DISPLAY) to start ' +
              "it with. Start PrismLCA yourself, or add the display variables to the server's env in the client " +
              'configuration (Settings → AI → MCP writes them).'
          )
        Object.assign(env, fixed)
        // X without an authority file would be refused by the server; a Wayland socket is there —
        // take Wayland for this start, explicitly: the "auto" hint falls back to X11 unless
        // XDG_SESSION_TYPE says wayland, and a reduced environment carries no such variable.
        if (!fixed.XAUTHORITY && fixed.WAYLAND_DISPLAY) {
          args.push('--ozone-platform=wayland')
          log('no X authority file in this session — starting PrismLCA on Wayland.')
        }
      }
      // The app's output goes to a log file in userData, never to a pipe: a pipe the bridge stops
      // reading breaks the app (EPIPE on its continuous backend log — measured: the app
      // came up to the backend and never reached its window), and a file is also what a user can
      // send along when a start fails. Read after a moment for the first seconds' verdict.
      // One file per launch: two bridges starting the app at the same time must not read each
      // other's output — a fatal line of one would have killed the healthy child of the other.
      // Older launch logs are swept here, best effort.
      const logDir = app.getPath('userData')
      sweepLaunchLogs(logDir)
      const logPath = join(logDir, `mcp-launch-${process.pid}-${Date.now().toString(36)}.log`)
      const fd = openSync(logPath, 'w')
      const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd], env })
      closeSync(fd)
      // Three ways the first seconds can go: a clean exit 0 is the single-instance HANDOFF (another
      // PrismLCA is up or starting — keep polling for its endpoint); a fatal line in the log
      // or a crash is a failure worth its own words; silence means it is coming up.
      const FATAL =
        /Missing X server|platform failed to initialize|Authorization required|cannot open display/i
      const readLog = (): string => {
        try {
          return readFileSync(logPath, 'utf-8')
        } catch {
          return ''
        }
      }
      const early = await new Promise<'handoff' | string | null>((resolve) => {
        const timer = setTimeout(() => resolve(FATAL.test(readLog()) ? 'fatal' : null), 2500)
        child.once('exit', (code) => {
          clearTimeout(timer)
          resolve(code === 0 ? 'handoff' : `exit code ${code ?? 'signal'}`)
        })
        child.once('error', (e) => {
          clearTimeout(timer)
          resolve(e.message)
        })
      })
      if (early === 'handoff') {
        log('another PrismLCA instance holds the lock — waiting for its endpoint.')
        return
      }
      if (early !== null) {
        if (early === 'fatal') child.kill()
        const tail = readLog()
          .split('\n')
          .filter((l) => l.trim() && !/libva|Gtk-|dbus|bus\.cc/.test(l))
          .slice(-3)
          .join(' | ')
        throw new BridgeError(
          `PrismLCA could not start${early === 'fatal' ? '' : ` (${early})`}${tail ? `: ${tail}` : ''}. ` +
            `Its output is in ${logPath}. Start it yourself and try again.`
        )
      }
      child.unref()
    },
    catalogFallback: () => {
      const s = getSettings()
      // Distances need a key the bridge does not look at; the app's own list replaces this one
      // as soon as it answers.
      return mcpToolDefs({ disabledTools: s.disabledTools, distances: false, eurostat: s.eurostatEnabled })
    },
    clientInfo: { name: 'PrismLCA bridge', version: app.getVersion() },
    log
  }
  const core = new ProxyCore(deps)
  const server = createProxyServer(deps, core)
  const transport = new StdioServerTransport()
  // The client is gone when stdin ends or it signals us: end our session in the app and go. The
  // app stays — the user is working in it. The SDK's transport listens for data and errors only,
  // not for EOF, so stdin's own end/close are wired here, and the
  // shutdown is idempotent and bounded. Set before connect, so the SDK keeps onclose (see server.ts).
  const shutdown = createShutdown(core, (code) => app.exit(code))
  transport.onclose = shutdown
  process.stdin.once('end', shutdown)
  process.stdin.once('close', shutdown)
  // A client that quits closes its end of our stdout as well, and the next reply fails with EPIPE. Unheard,
  // that error is an uncaught exception in Electron's main process and kills the bridge with SIGTRAP — a
  // core dump and a lingering crash reporter per closed session. It is the same "client gone".
  process.stdout.on('error', shutdown)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(sig, shutdown)
  await server.connect(transport)
  log(`ready (PrismLCA ${app.getVersion()})`)
}
