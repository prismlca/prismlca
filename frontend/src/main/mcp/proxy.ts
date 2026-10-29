/**
 * The stdio bridge: what a client spawns (`PrismLCA --mcp-proxy`) and what talks to the server
 * inside the running app on its behalf. Stdio is the one transport all three target clients share;
 * Cowork has nothing else, and a client's startup timeout (Codex: 10 s) is shorter than an app
 * start — so the bridge answers `initialize` and `tools/list` at once and connects lazily.
 *
 * A state machine, not a pass-through:
 *
 *   idle → discovering (endpoint file: present, same version, process alive, health answers)
 *        → launching   (the app is not running: start it, wait for its endpoint file)
 *        → connected   (one MCP session in the app, held for the bridge's lifetime)
 *        → disconnected (the app closed the session or quit: back to discovering on the next call)
 *
 * Rules: a mutation with an unclear outcome is never repeated — a call is forwarded exactly once,
 * and a dropped connection mid-call is reported as an error. The app outlives the bridge: when the
 * client closes stdin, the bridge ends its session and exits, the window stays.
 *
 * Electron-free: the platform bits (paths, settings, spawning the app) come in through `ProxyDeps`,
 * so proxy.test.ts drives it against an in-process McpHost.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'

import type { EndpointInfo } from './endpoint'
import { INSTRUCTIONS } from './instructions'
import type { McpToolDef } from './catalog'

export interface ProxyDeps {
  /** This bridge's own version — a running app of another version is refused, never driven. */
  version: string
  /** The endpoint file as it is right now (null = absent or unreadable). */
  endpoint: () => EndpointInfo | null
  isPidAlive: (pid: number) => boolean
  /** GET /health with the token: does the server behind the file answer? */
  health: (info: EndpointInfo) => Promise<boolean>
  /** Settings → AI → MCP: is the server switched on at all? Off = launching would not help. */
  mcpEnabled: () => boolean
  /** Start the app (detached; it keeps running when the bridge exits). Throw a BridgeError when it
   *  cannot be started — the text reaches the client's model. May resolve late, after an early-exit
   *  check. */
  launchApp: () => void | Promise<void>
  /** The catalogue to show before the app answers — the same registry, the same switches. */
  catalogFallback: () => McpToolDef[]
  /** The client the bridge announces itself as towards the app. */
  clientInfo: { name: string; version: string }
  log: (msg: string) => void
  /** Test hook: how often to poll while launching (ms). */
  pollMs?: number
}

export interface EnsureOpts {
  /** May the bridge start the app when it is not running? */
  launch: boolean
  timeoutMs: number
  onProgress?: (message: string, elapsedMs: number) => void
}

/** Why the bridge could not reach the app — the text the client's model reads. */
export class BridgeError extends Error {}

/** The client's per-request timeout towards the app: generous, because calculations run
 *  synchronously there and the bridge must not give up before the client would — and longer than
 *  the 15 minutes a question or approval card may wait on a person (timeouts.ts), so a human answer
 *  never arrives at a bridge that has already given up. Set when that wait was 30
 *  minutes and kept: the margin costs nothing. */
export const FORWARD_TIMEOUT_MS = 31 * 60_000

export class ProxyCore {
  private client: Client | null = null
  private transport: StreamableHTTPClientTransport | null = null
  /** How often this bridge started the app — for the tests and the log; never a guard. */
  launches = 0
  /** Why starting the app failed, if it did — every later call is told at once instead of waiting. */
  private launchFailure: BridgeError | null = null
  private connecting: Promise<Client> | null = null

  constructor(private readonly deps: ProxyDeps) {}

  get connected(): boolean {
    return this.client !== null
  }

  /** A connected client, or the reason there is none. Serialised: two callers share one attempt. */
  ensureClient(opts: EnsureOpts): Promise<Client> {
    if (this.client) return Promise.resolve(this.client)
    if (!this.connecting) {
      this.connecting = this.connect(opts).finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(opts: EnsureOpts): Promise<Client> {
    const started = Date.now()
    const poll = this.deps.pollMs ?? 500
    let lastProgress = 0
    // One launch per connection ATTEMPT, not per bridge lifetime: the app a bridge started may quit
    // again when nobody uses it (mcp/idleQuit.ts), and the next call has to be able to start it
    // anew — a flag that stayed true for ever left every later call polling for an endpoint that
    // would never come. A second launch while the first is still
    // booting is harmless: it loses the single-instance lock and exits 0 (proxyMain.ts).
    let launched = false
    for (;;) {
      const info = await this.validEndpoint()
      if (info) return this.open(info)
      if (!this.deps.mcpEnabled()) {
        throw new BridgeError(
          'The MCP server is switched off in PrismLCA. Switch it on under Settings → AI → MCP → External agents, then try again.'
        )
      }
      if (!opts.launch) throw new BridgeError('PrismLCA is not running.')
      if (this.launchFailure) throw this.launchFailure
      if (!launched) {
        this.deps.log('PrismLCA is not running — starting it.')
        try {
          await this.deps.launchApp()
          launched = true
          this.launches++
        } catch (e) {
          // No display, no binary, an early exit: the reason, not a 90-second wait — now and on
          // every later call of this session.
          this.launchFailure =
            e instanceof BridgeError ? e : new BridgeError(`PrismLCA could not be started: ${msg(e)}`)
          throw this.launchFailure
        }
      }
      const elapsed = Date.now() - started
      if (elapsed >= opts.timeoutMs) {
        throw new BridgeError(
          `PrismLCA did not come up within ${Math.round(opts.timeoutMs / 1000)} s. It may still be starting — ` +
            'try again in a moment, or open it yourself and switch on the MCP server under Settings → AI → MCP.'
        )
      }
      if (opts.onProgress && elapsed - lastProgress >= 4000) {
        lastProgress = elapsed
        opts.onProgress('Starting PrismLCA…', elapsed)
      }
      await new Promise((r) => setTimeout(r, poll))
    }
  }

  /** The endpoint file, if it describes a server this bridge may use: same version, process alive,
   *  health answering. Anything else is stale and treated as absent — except another version, which
   *  is a running app that must not be driven by a bridge built for a different one. */
  private async validEndpoint(): Promise<EndpointInfo | null> {
    const info = this.deps.endpoint()
    if (!info) return null
    if (info.version !== this.deps.version) {
      throw new BridgeError(
        `PrismLCA ${info.version} is running, but this bridge belongs to version ${this.deps.version}. ` +
          'Use the bridge of the installed PrismLCA (reconfigure the client from its Settings → AI → MCP).'
      )
    }
    if (!this.deps.isPidAlive(info.pid)) return null
    if (!(await this.deps.health(info).catch(() => false))) return null
    return info
  }

  private async open(info: EndpointInfo): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(info.url), {
      requestInit: { headers: { Authorization: `Bearer ${info.token}` } }
    })
    // The app attributes every change to this name (audit log, drawer, study `ai_model`). The bridge
    // is the carrier, not the agent: "Claude Code via PrismLCA bridge", never just the bridge
    // (a whole agent session was once logged as "PrismLCA bridge 0.8.0").
    const up = this.upstream
    const client = new Client(
      up ? { name: `${up.name} via ${this.deps.clientInfo.name}`, version: up.version } : this.deps.clientInfo
    )
    // Before connect, so the SDK chains it in front of its own (see server.ts for the same lesson).
    transport.onclose = () => {
      if (this.transport === transport) {
        this.deps.log('The app closed the session.')
        this.client = null
        this.transport = null
      }
    }
    // A broken stream (the app quit mid-call) surfaces here, not in onclose (SDK 1.31, measured):
    // forget the connection, so the call's eventual error is the last one on it.
    transport.onerror = (e) => {
      if (this.transport === transport) {
        this.deps.log(`connection to the app failed: ${msg(e)}`)
        this.markLost()
      }
    }
    await client.connect(transport)
    this.client = client
    this.transport = transport
    this.deps.log(`connected to ${info.url}`)
    return client
  }

  /**
   * The session is gone (the app ended it, or quit): forget the client so the NEXT call opens a new
   * session. Streamable HTTP has no standing connection to tell us earlier — the first call after the
   * loss is the one that finds out, and it is reported, not repeated.
   */
  markLost(): void {
    const c = this.client
    this.client = null
    this.transport = null
    if (c) void c.close().catch(() => undefined)
  }

  private upstream: { name: string; version: string } | null = null

  /** Who sits on the other end of stdio, as it introduced itself in `initialize`. */
  setUpstreamClient(info: { name?: string; version?: string } | undefined): void {
    const name = (info?.name ?? '').trim()
    if (!name) return
    this.upstream = { name: name.slice(0, 40), version: (info?.version ?? '').trim().slice(0, 20) || '0' }
  }

  /** End the session in the app (best effort) and forget the client. */
  async close(): Promise<void> {
    const t = this.transport
    const c = this.client
    this.client = null
    this.transport = null
    if (t) await t.terminateSession().catch(() => undefined)
    if (c) await c.close().catch(() => undefined)
  }
}

/**
 * One shutdown, however many things trigger it (stdin EOF, the transport closing, SIGTERM): end the
 * session in the app, then exit — bounded, because a hung app must not keep the bridge alive.
 */
export function createShutdown(core: ProxyCore, exit: (code: number) => void, timeoutMs = 3000): () => void {
  let started = false
  return () => {
    if (started) return
    started = true
    const timer = setTimeout(() => exit(0), timeoutMs)
    void core.close().finally(() => {
      clearTimeout(timer)
      exit(0)
    })
  }
}

/** The MCP server the client talks to over stdio, forwarding to the app through `core`. */
export function createProxyServer(deps: ProxyDeps, core: ProxyCore): Server {
  const server = new Server(
    { name: 'PrismLCA', version: deps.version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  )
  // The stdio client's own name, known once `initialize` is in; the app's session is opened lazily
  // on the first call, so the name is there in time.
  server.oninitialized = () => core.setUpstreamClient(server.getClientVersion())
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Clients list tools right after initialize, and an app that is still booting cannot answer
    // in time: the registry's own list stands in. Three seconds is a lot less than a cold start.
    // Discovery NEVER starts the app (`launch: false`): a client that only ever lists the tools — a
    // code review, a thread that never touches PrismLCA — must not leave a running instance behind.
    // The first substantive call starts it.
    try {
      const client = await core.ensureClient({ launch: false, timeoutMs: 3000 })
      const { tools } = await client.listTools()
      return { tools }
    } catch (e) {
      if (!(e instanceof BridgeError)) deps.log(`tools/list fell back to the built-in catalogue: ${msg(e)}`)
      return { tools: deps.catalogFallback() }
    }
  })
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const progressToken = (extra._meta as { progressToken?: string | number } | undefined)?.progressToken
    const progress = (message: string, elapsedMs: number): void => {
      if (progressToken === undefined) return
      void extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: Math.round(elapsedMs / 1000), message }
      })
    }
    let client: Client
    try {
      client = await core.ensureClient({ launch: true, timeoutMs: 90_000, onProgress: progress })
    } catch (e) {
      return refusal(msg(e))
    }
    try {
      // Forwarded exactly once. A failure here is reported, never retried: the app may have
      // carried out the write before the connection broke.
      return await client.callTool(req.params, undefined, {
        signal: extra.signal,
        timeout: FORWARD_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        onprogress: (p) => progress(p.message ?? 'working…', (p.progress ?? 0) * 1000)
      })
    } catch (e) {
      const m = msg(e)
      // Anything that THROWS here is transport or protocol — a tool's own refusal comes back as an
      // `isError` result, not as an exception. So the connection is forgotten on every throw (a
      // timeout included: the app may have quit under the call), and the next call validates the
      // endpoint again and reconnects or relaunches. This call is reported, never repeated here.
      core.markLost()
      return refusal(
        `The connection to PrismLCA failed during this call (${m}). It will be re-established on your next call. ` +
          'If this call changed something, the change may have been applied — read the model before repeating it.'
      )
    }
  })
  return server
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const refusal = (text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } => ({
  content: [{ type: 'text', text: JSON.stringify({ error: text }) }],
  isError: true
})

export type { RequestHandlerExtra }
