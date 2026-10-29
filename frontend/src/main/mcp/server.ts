/**
 * The MCP server PrismLCA hosts for external agents (Claude Code, Codex, Cowork): Streamable HTTP on
 * 127.0.0.1 with a random port and a bearer token, one transport + one protocol `Server` per session
 * (the SDK serves one session per `Server` instance), our tool catalogue with our own JSON schemas.
 *
 * Security posture: loopback only; every route authenticated, the
 * health probe included; the token compared in constant time; the SDK's DNS-rebinding protection on
 * with the exact hosts this server answers as; no CORS, no remote bind, no OAuth. The endpoint file
 * that publishes port + token is written by `start` and removed by `stop`.
 *
 * Electron-free — the window, the keys, the settings store and the user-data path come in through
 * `McpHostDeps`, so server.test.ts runs it under plain Node with a fake backend.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest
} from '@modelcontextprotocol/sdk/types.js'

import type { ApiRaw } from '../ai/execute'
import type { McpEvent, McpSessionSnapshot, McpStatus } from '../../shared/ipc'
import { INSTRUCTIONS } from './instructions'
import { McpSession, type SessionDeps } from './sessions'
import { MCP_ASK_TIMEOUT_MS } from './timeouts'

/** How often a pending card is reported as progress to the client. Test hook via `setProgressEvery`. */
let PROGRESS_EVERY_MS = 30_000
export function setProgressEvery(ms: number): void {
  PROGRESS_EVERY_MS = ms
}
import { removeEndpoint, writeEndpoint } from './endpoint'

export const MCP_PATH = '/mcp'
const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface McpHostDeps {
  version: string
  /** Where the endpoint file lives (Electron's userData); a function because the path is only
   *  knowable once the app is ready. */
  userData: () => string
  apiRaw: ApiRaw
  /** Everything a session needs from the app, minus the backend transport (see sessions.ts). */
  session: Omit<SessionDeps, 'apiRaw' | 'onChange' | 'onMutated'>
  /** The model the app has open right now, for pinning a new session to it; null = none known. */
  currentModel: () => Promise<string | null>
  /** Something for the renderer's panel (sessions changed, a model needs reloading, status). */
  emit: (ev: McpEvent) => void
  /** End what a session still waits on in the app (its open question cards) when it closes. */
  cancel?: (sessionId: string, reason: string) => void
  /** A session opened or a call finished — the sign of life the bridge-launched app's idle quit
   *  waits for (mcp/idleQuit.ts). */
  onActivity?: () => void
  /** A call is in flight (+1) / done (−1), human waits included — the idle clock pauses meanwhile. */
  onBusy?: (delta: 1 | -1) => void
}

interface Entry {
  transport: StreamableHTTPServerTransport
  server: Server
  session: McpSession
}

export class McpHost {
  private http: HttpServer | null = null
  private port = 0
  private token = ''
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly deps: McpHostDeps) {}

  get running(): boolean {
    return this.http !== null
  }

  get url(): string | null {
    return this.http ? `http://127.0.0.1:${this.port}${MCP_PATH}` : null
  }

  status(): McpStatus {
    return {
      running: this.running,
      url: this.url,
      token: this.running ? this.token : null,
      sessions: this.sessions()
    }
  }

  sessions(): McpSessionSnapshot[] {
    return [...this.entries.values()].map((e) => e.session.snapshot())
  }

  async start(): Promise<string> {
    if (this.http) return this.url!
    this.token = this.token || randomBytes(32).toString('base64url')
    const http = createServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        console.error('[prism-mcp] request failed:', e instanceof Error ? e.message : e)
        if (!res.headersSent) this.json(res, 500, { error: 'Internal error.' })
        else res.end()
      })
    })
    await new Promise<void>((resolve, reject) => {
      http.once('error', reject)
      http.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = http.address()
    this.port = typeof addr === 'object' && addr ? addr.port : 0
    this.http = http
    writeEndpoint(this.deps.userData(), {
      url: this.url!,
      token: this.token,
      pid: process.pid,
      version: this.deps.version,
      startedAt: new Date().toISOString()
    })
    console.log(`[prism-mcp] listening on ${this.url}`)
    this.emitStatus()
    return this.url!
  }

  async stop(): Promise<void> {
    const http = this.http
    if (!http) return
    this.http = null
    for (const id of [...this.entries.keys()]) await this.closeSession(id, 'PrismLCA stopped its MCP server.')
    await new Promise<void>((resolve) => http.close(() => resolve()))
    removeEndpoint(this.deps.userData())
    console.log('[prism-mcp] stopped')
    this.emitStatus()
  }

  /** At quit: drop the file and the listener now, without awaiting anything — the process is going. */
  shutdownNow(): void {
    const http = this.http
    if (!http) return
    this.http = null
    for (const e of this.entries.values()) e.session.end()
    this.entries.clear()
    http.close()
    removeEndpoint(this.deps.userData())
  }

  /** A new token: every session is ended (its client no longer holds a valid credential). */
  async regenerateToken(): Promise<void> {
    const wasRunning = this.running
    await this.stop()
    this.token = randomBytes(32).toString('base64url')
    if (wasRunning) await this.start()
  }

  async disconnect(sessionId: string): Promise<boolean> {
    if (!this.entries.has(sessionId)) return false
    await this.closeSession(sessionId, 'Disconnected by the user in PrismLCA.')
    return true
  }

  setApproval(sessionId: string, mode: McpSessionSnapshot['approval']): boolean {
    const e = this.entries.get(sessionId)
    if (!e) return false
    e.session.approval = mode
    this.emitSessions()
    return true
  }

  // --- HTTP -------------------------------------------------------------------------------------

  private authorised(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const given = Buffer.from(header.slice('Bearer '.length).trim())
    const want = Buffer.from(this.token)
    return given.length === want.length && timingSafeEqual(given, want)
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorised(req)) {
      // No hint about which part was wrong: a missing header and a stale token read the same.
      this.json(res, 401, { error: 'Unauthorized.' })
      return
    }
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/health') {
      this.json(res, 200, { ok: true, version: this.deps.version, sessions: this.entries.size })
      return
    }
    if (path !== MCP_PATH) {
      this.json(res, 404, { error: 'Not found.' })
      return
    }
    const sessionId = req.headers['mcp-session-id']
    const sid = typeof sessionId === 'string' ? sessionId : undefined
    if (sid) {
      const entry = this.entries.get(sid)
      if (!entry) {
        this.json(res, 404, { error: 'Unknown session — initialize again.' })
        return
      }
      const body = req.method === 'POST' ? await this.readJson(req) : undefined
      if (body === INVALID) {
        this.json(res, 400, { error: 'Body is not JSON.' })
        return
      }
      await entry.transport.handleRequest(req, res, body)
      return
    }
    // No session: only an initialize request may open one.
    if (req.method !== 'POST') {
      this.json(res, 400, { error: 'No session. Send an initialize request first.' })
      return
    }
    const body = await this.readJson(req)
    if (body === INVALID || !isInitializeRequest(body)) {
      this.json(res, 400, { error: 'Expected an initialize request.' })
      return
    }
    let entry: Entry
    try {
      entry = await this.openSession()
    } catch (e) {
      if (e instanceof NoProjectError) {
        this.json(res, 503, {
          error: 'PrismLCA has no active workspace right now — open one in the app and try again.'
        })
        return
      }
      throw e
    }
    await entry.transport.handleRequest(req, res, body)
    // The transport only takes the session id when the initialize went through; a request it
    // refused (a foreign Host header, a protocol mismatch) must not leave a half-opened session.
    if (!entry.transport.sessionId) await this.closeSession(entry.session.id, 'Initialize was refused.')
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of req) {
      size += (c as Buffer).length
      if (size > MAX_BODY_BYTES) return INVALID
      chunks.push(c as Buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text.trim()) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return INVALID
    }
  }

  // --- Sessions ---------------------------------------------------------------------------------

  private async openSession(): Promise<Entry> {
    const id = randomUUID()
    // No project, no session: a session without a project binding would follow whatever project
    // the app switches to. The client sees a 503 and tries again.
    const project = await this.currentProject()
    if (!project) throw new NoProjectError()
    const activeDb = await this.deps.currentModel().catch(() => null)
    const released = await this.releasedDatabases()
    const session = new McpSession(
      id,
      {
        ...this.deps.session,
        apiRaw: this.deps.apiRaw,
        onChange: () => this.emitSessions(),
        onMutated: (database) => this.deps.emit({ type: 'refresh', database })
      },
      activeDb,
      released,
      project
    )
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableDnsRebindingProtection: true,
      // Exactly the names this server answers as. A page in a browser on this machine cannot make
      // a request arrive with one of these Host headers pointing elsewhere (DNS rebinding).
      allowedHosts: [`127.0.0.1:${this.port}`, `localhost:${this.port}`, '127.0.0.1', 'localhost'],
      onsessionclosed: (sid) => {
        void this.closeSession(sid, 'The client ended the session.')
      }
    })
    const server = new Server(
      { name: 'PrismLCA', version: this.deps.version },
      { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
    )
    server.oninitialized = () => {
      const c = server.getClientVersion()
      session.setClient(c?.name, c?.version)
    }
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: session.catalog.map(({ _note: _n, ...t }) => {
        void _n
        return t
      })
    }))
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      // In flight — a human wait on a question card included — the idle clock of a bridge-launched
      // app pauses; done, it restarts (mcp/idleQuit.ts).
      this.deps.onBusy?.(1)
      // A card the user has to click leaves the client in silence for minutes; a client with a
      // finite tool timeout gives up and retries. So while the session waits on a person, say so
      // every half minute as a progress notification — the bridge forwards it, and SDK clients with
      // `resetTimeoutOnProgress` keep waiting.
      const progressToken = (extra._meta as { progressToken?: string | number } | undefined)?.progressToken
      const waiting =
        progressToken === undefined
          ? null
          : setInterval(() => {
              const w = session.humanWait
              if (!w) return
              const minutes = Math.max(1, Math.round((Date.now() - w.since) / 60_000))
              const what = w.tool === 'ask_user' ? 'answer to your question' : 'approval'
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress: Math.round((Date.now() - w.since) / 1000),
                    message: `Waiting for the user's ${what} in PrismLCA (${minutes} min of up to ${Math.round(MCP_ASK_TIMEOUT_MS / 60_000)}).`
                  }
                })
                .catch(() => undefined)
            }, PROGRESS_EVERY_MS)
      try {
        const args = (req.params.arguments ?? {}) as Record<string, unknown>
        const oc = await session.call(req.params.name, args, extra.signal)
        if (!oc.ok) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: oc.error }) }], isError: true }
        }
        const content: Array<Record<string, unknown>> = [{ type: 'text', text: oc.result }]
        if (oc.image) {
          const comma = oc.image.indexOf(',')
          content.push({ type: 'image', data: oc.image.slice(comma + 1), mimeType: 'image/png' })
        }
        // A refusal the tool returned is an error for the caller too — the model was told no.
        return { content, isError: !!oc.soft }
      } finally {
        if (waiting) clearInterval(waiting)
        this.deps.onBusy?.(-1)
        this.deps.onActivity?.()
      }
    })
    const entry: Entry = { transport, server, session }
    this.deps.onActivity?.()
    this.entries.set(id, entry)
    // BEFORE connect: the SDK chains an existing onclose in front of its own (which aborts the
    // signals of requests in flight). Set afterwards, ours would have replaced that one — and a
    // disconnect would no longer have cancelled anything.
    transport.onclose = () => {
      void this.closeSession(id, 'The connection closed.')
    }
    await server.connect(transport)
    this.emitSessions()
    return entry
  }

  private async closeSession(id: string, reason: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    // Order matters: end the session first (aborts its waits and its next backend request), then
    // its open cards, then the transport — whose onclose finds the entry gone and returns.
    entry.session.end()
    this.deps.cancel?.(id, reason)
    await entry.server.close().catch(() => undefined)
    this.emitSessions()
  }

  /** The project the app has open — the one a new session binds to. */
  private async currentProject(): Promise<string | null> {
    try {
      const { status, body } = await this.deps.apiRaw('GET', '/api/v1/projects')
      const list =
        status < 400 && Array.isArray(body) ? (body as Array<{ name?: string; is_active?: boolean }>) : []
      const active = list.find((p) => p.is_active && typeof p.name === 'string')
      return active?.name ?? null
    } catch {
      return null
    }
  }

  /** Every installed background and library database is released to an external session. */
  private async releasedDatabases(): Promise<{ backgroundDbs: string[]; libraryDbs: string[] }> {
    try {
      const { status, body } = await this.deps.apiRaw('GET', '/api/v1/databases')
      const list =
        status < 400 && Array.isArray(body) ? (body as Array<{ name?: string; kind?: string }>) : []
      const names = (kind: string): string[] =>
        list.filter((d) => d.kind === kind && typeof d.name === 'string').map((d) => d.name as string)
      return { backgroundDbs: names('background'), libraryDbs: names('library') }
    } catch {
      return { backgroundDbs: [], libraryDbs: [] }
    }
  }

  private emitSessions(): void {
    this.deps.emit({ type: 'sessions', sessions: this.sessions() })
  }

  private emitStatus(): void {
    this.deps.emit({ type: 'status', running: this.running, url: this.url })
  }
}

/** The backend named no active project, or could not be asked. */
class NoProjectError extends Error {
  constructor() {
    super('No active workspace.')
  }
}

/** Sentinel for "the body could not be read as JSON" (a valid body may be `undefined`). */
const INVALID = Symbol('invalid-json')
