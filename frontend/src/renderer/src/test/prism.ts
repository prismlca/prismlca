/**
 * One fake of the preload bridge, for every renderer test.
 *
 * The renderer has exactly ONE door to the backend: 28 modules import `lib/api.ts`, whose only
 * impurity is `window.prism.api(method, path, body)`. So a single fixture covers pure-logic tests
 * and mounted components alike, and — the point of testing at this layer — `api.ts`'s own status →
 * `ApiError` mapping runs for real in every component test instead of being mocked away.
 *
 * It is typed as the bridge itself on purpose: the day someone adds a method to `src/preload`,
 * `npm run typecheck` fails HERE rather than the fixture quietly drifting from what the app actually
 * talks to. The type is taken via `Window['prism']` rather than imported from `preload/index.ts`,
 * because `tsconfig.web.json` includes only the preload's `.d.ts` — the global declaration is the
 * one seam the renderer is allowed to see, which is exactly the seam a renderer fixture should copy.
 */
import { clampMaxTokens, clampMinThroughput, clampResearchQuestions } from '../../../shared/aiDefaults'
import { DEFAULT_TRANSPORT, sanitiseTransport } from '../../../shared/distanceDefaults'
import { sanitiseRecentModels } from '../../../shared/startPage'

type PrismApi = Window['prism']

/** What a route may answer with: a bare body, or a full envelope when the status matters. */
export type RouteReply = unknown | { status: number; body?: unknown }
export type RouteHandler = (body: unknown, path: string) => RouteReply | Promise<RouteReply>
/** Keyed `'GET /api/v1/models'`. A non-function value is served as `{ status: 200, body: value }`. */
export type Routes = Record<string, RouteHandler | unknown>

/** Overrides for the non-`api` half of the bridge — the model catalogue, the usage ledger, the key
 *  status. Anything not given keeps a harmless default. */
export interface PrismOverrides {
  ai?: Record<string, unknown>
  /** The transport-distance half: key status, availability, one lookup, the ledger. */
  distance?: Record<string, unknown>
  /** The start page's news feed (`news.fetch`). Default: an empty feed. */
  news?: Record<string, unknown>
  /** The manual update check (`updates.*`). Default: a dev build, the check unavailable. */
  updates?: Record<string, unknown>
  /** The MCP server for external agents (`mcp.*`). Default: off, nothing connected. */
  mcp?: Record<string, unknown>
  /** How this instance was started (`prism.bridge.*`). Default: by a person, claimed. Named
   *  `launch` because `bridge` below already means the top-level methods. */
  launch?: Record<string, unknown>
  status?: unknown
  /** Top-level bridge methods (`pickFiles`, `droppedFilePaths`, `openSource`, …), spread LAST so a
   *  test can replace any of them. */
  bridge?: Record<string, unknown>
}

export interface ApiCall {
  method: string
  path: string
  body?: unknown
}

export interface PrismFixture {
  prism: PrismApi
  /** Every backend call in order — so a test can assert what was WRITTEN, not just what is shown. */
  calls: ApiCall[]
  setRoute: (key: string, reply: RouteHandler | unknown) => void
  /** Push an agent event to whatever subscribed via `ai.onEvent` — this is what makes the chat testable. */
  emit: (ev: unknown) => void
  emitUiTool: (msg: unknown) => void
  /** Push a launch state to whatever subscribed via `bridge.onState` (e.g. main's answer to a claim). */
  emitBridgeState: (s: unknown) => void
  /** The settings main would hold, after the same clamping main applies. */
  settings: Record<string, unknown>
  reset: () => void
}

const DEFAULT_SETTINGS: Record<string, unknown> = {
  provider: 'openrouter',
  model: 'anthropic/claude-sonnet-5.5',
  writerModel: '',
  researchModel: '',
  maxCostUsd: 2,
  maxRounds: 150,
  maxTokens: 50_000,
  maxResearchQuestions: 4,
  minThroughput: 20,
  disabledTools: [],
  zeroDataRetention: true,
  focusTools: false,
  voiceEnabled: true,
  voiceLanguage: '',
  webSearchEnabled: true,
  preferredBackground: '',
  transport: DEFAULT_TRANSPORT,
  newsAutoLoad: false,
  keepAwake: true,
  recentModels: []
}

/** What a dev build's update check answers — the About page's default in every test. */
const DEV_UPDATE_STATE = {
  phase: 'unavailable' as const,
  current: '0.0.0-test',
  reason: 'Update checks work in the installed app only.'
}

/** Match `'GET /api/v1/x'` exactly, then allow `:param` segments, then give up loudly. */
function findRoute(routes: Routes, method: string, path: string): [string, RouteHandler | unknown] | null {
  const bare = path.split('?')[0]
  const exact = `${method} ${bare}`
  if (exact in routes) return [exact, routes[exact]]
  if (`${method} ${path}` in routes) return [`${method} ${path}`, routes[`${method} ${path}`]]
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ')
    if (m !== method || !pattern?.includes(':')) continue
    const pp = pattern.split('/')
    const ap = bare.split('/')
    if (pp.length !== ap.length) continue
    if (pp.every((seg, i) => seg.startsWith(':') || seg === ap[i])) return [key, routes[key]]
  }
  return null
}

/**
 * Build the fixture. `routes` may be extended later with `setRoute`.
 *
 * An unmatched route THROWS rather than answering 404 on purpose: a silent 404 shows up in a
 * component test as an empty render three assertions later, and costs an hour to trace back.
 */
export function makePrism(routes: Routes = {}, overrides: PrismOverrides = {}): PrismFixture {
  const table: Routes = { ...routes }
  const calls: ApiCall[] = []
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  const listeners = new Set<(ev: unknown) => void>()
  const uiListeners = new Set<(msg: unknown) => void>()
  const bridgeListeners = new Set<(s: unknown) => void>()

  const call = async (
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: unknown }> => {
    calls.push({ method, path, body })
    const hit = findRoute(table, method, path)
    if (!hit) {
      throw new Error(
        `prism fixture: no canned response for ${method} ${path} — add it to the routes passed to makePrism().`
      )
    }
    const reply = typeof hit[1] === 'function' ? await (hit[1] as RouteHandler)(body, path) : hit[1]
    const env = reply as { status?: unknown; body?: unknown }
    if (env && typeof env === 'object' && typeof env.status === 'number') {
      return { status: env.status, body: env.body ?? {} }
    }
    return { status: 200, body: reply }
  }

  // Clamped with the SHARED helpers main uses, so the fixture cannot be more permissive than the
  // real thing — the cost brake is the last place you want a lying stub.
  const applySettings = (patch: Record<string, unknown>): Record<string, unknown> => {
    Object.assign(settings, patch)
    if ('maxTokens' in patch) settings.maxTokens = clampMaxTokens(patch.maxTokens)
    if ('minThroughput' in patch) settings.minThroughput = clampMinThroughput(patch.minThroughput)
    if ('maxResearchQuestions' in patch)
      settings.maxResearchQuestions = clampResearchQuestions(patch.maxResearchQuestions)
    if ('transport' in patch) settings.transport = sanitiseTransport(patch.transport)
    if ('newsAutoLoad' in patch) settings.newsAutoLoad = patch.newsAutoLoad === true
    if ('recentModels' in patch) settings.recentModels = sanitiseRecentModels(patch.recentModels)
    return { ...settings }
  }

  const subscribe = <T>(set: Set<(v: T) => void>, cb: (v: T) => void): (() => void) => {
    set.add(cb)
    return () => set.delete(cb)
  }

  const prism = {
    status: async () => ({ state: 'ready' }),
    info: async () => ({ version: '0.0.0-test', app_version: '0.0.0-test' }),
    buildInfo: async () => ({
      version: '0.0.0-test',
      commit: 'abc1234',
      kind: 'dev',
      electron: '44.9.1',
      os: 'linux x64 6.19.10'
    }),
    api: call,
    pickDirectory: async () => null,
    saveFilesTo: async () => null,
    pickFile: async () => null,
    pickFiles: async () => [],
    droppedFilePaths: async () => ({ paths: [], overflow: 0 }),
    openSource: async () => ({}),
    openLicence: async () => ({}),
    openNotices: async () => ({}),
    noticesSummary: async () => ({
      text: '## Summary\n\n### Python runtime packages (1)\n\n| Package | Version | Licence | Note |\n|---|---|---|---|\n| bw2data | 4.7 | BSD-3-Clause |  |'
    }),
    openExternal: async () => undefined,
    appSettings: {
      get: async () => ({ ...settings }),
      set: async (patch: Record<string, unknown>) => applySettings(patch),
      seed: async () => ({ ...settings })
    },
    distance: {
      keyStatus: async () => ({
        present: true,
        hint: 'eyJvcmc…test',
        source: 'stored' as const,
        backend: 'test',
        trusted: true,
        available: true
      }),
      setKey: async () => ({ ok: true }),
      clearKey: async () => ({ ok: true }),
      availability: async () => ({ ors: true, mapbox: false, geocoder: 'ors' as const, available: true }),
      compute: async () => ({ mode: 'road', geocoder: 'ors', results: [], attribution: '', quota: {} }),
      cancel: async () => ({ ok: true }),
      usage: async () => ({}),
      suggest: async () => [],
      ...(overrides.distance ?? {})
    },
    news: {
      fetch: async () => ({ items: [], source: 'prismlca.com', fetchedAt: new Date().toISOString() }),
      ...(overrides.news ?? {})
    },
    updates: {
      state: async () => DEV_UPDATE_STATE,
      check: async () => DEV_UPDATE_STATE,
      download: async () => DEV_UPDATE_STATE,
      install: async () => DEV_UPDATE_STATE,
      discard: async () => DEV_UPDATE_STATE,
      relaunch: async () => DEV_UPDATE_STATE,
      onEvent: () => () => undefined,
      onSaveRequest: () => () => undefined,
      ...(overrides.updates ?? {})
    },
    mcp: {
      status: async () => ({ enabled: false, running: false, url: null, token: null, sessions: [] }),
      setEnabled: async (on: boolean) => ({
        enabled: on,
        running: on,
        url: on ? 'http://127.0.0.1:1/mcp' : null,
        token: on ? 't' : null,
        sessions: []
      }),
      regenerateToken: async () => ({
        enabled: true,
        running: true,
        url: 'http://127.0.0.1:1/mcp',
        token: 't2',
        sessions: []
      }),
      disconnect: async () => true,
      setApproval: async () => true,
      clients: async () => [],
      configureClient: async () => ({ ok: false, error: 'not in tests' }),
      testConnection: async () => ({ ok: false, error: 'not in tests' }),
      onEvent: (cb: (ev: unknown) => void) => subscribe(listeners, cb),
      ...(overrides.mcp ?? {})
    },
    ai: {
      hasKey: async () => true,
      keyStatus: async () => ({
        present: true,
        hint: 'sk-or-v…test',
        source: 'stored' as const,
        backend: 'test',
        trusted: true,
        available: true
      }),
      setKey: async () => ({ ok: true }),
      clearKey: async () => ({ ok: true }),
      usage: async () => ({}),
      models: async () => [],
      modelIssues: async () => [],
      openrouterCatalogue: async () => [],
      addUserModel: async () => ({ ok: true, problems: [] }),
      removeUserModel: async () => ({ ok: true, problems: [] }),
      tools: async () => [],
      writeSection: async () => ({}),
      writeAll: async () => ({}),
      cancelWriteAll: async () => undefined,
      onWriteAllProgress: (cb: (ev: unknown) => void) => subscribe(listeners, cb),
      onWritePhase: (cb: (ev: unknown) => void) => subscribe(listeners, cb),
      onTranslateProgress: (cb: (ev: unknown) => void) => subscribe(listeners, cb),
      send: async () => undefined,
      cancel: async () => undefined,
      steer: async () => ({ queued: true }),
      unsteer: async () => ({ queued: [] }),
      steerQueue: async () => [],
      isRunning: async () => false,
      pendingAsks: async () => [],
      transcribe: async () => ({ text: '' }),
      onEvent: (cb: (ev: unknown) => void) => subscribe(listeners, cb),
      onUiTool: (cb: (msg: unknown) => void) => subscribe(uiListeners, cb),
      uiResult: () => undefined,
      skills: async () => ({ skills: [] }),
      attach: async () => [],
      ...(overrides.ai ?? {})
    },
    bridge: {
      state: async () => ({ launchedBy: 'human', claimed: true, idleMinutes: 10 }),
      onState: (cb: (s: unknown) => void) => subscribe(bridgeListeners, cb),
      keepOpen: async () => undefined,
      ...(overrides.launch ?? {})
    },
    ...(overrides.status ? { status: async () => overrides.status } : {}),
    ...(overrides.bridge ?? {})
  } as unknown as PrismApi

  return {
    prism,
    calls,
    settings,
    setRoute: (key, reply) => {
      table[key] = reply
    },
    emit: (ev) => listeners.forEach((l) => l(ev)),
    emitUiTool: (msg) => uiListeners.forEach((l) => l(msg)),
    emitBridgeState: (st) => bridgeListeners.forEach((l) => l(st)),
    reset: () => {
      calls.length = 0
      Object.assign(settings, DEFAULT_SETTINGS)
    }
  }
}

/** An in-memory `localStorage`, for the migration paths that read and delete keys. */
export function memoryStorage(): Storage {
  const store: Record<string, string> = {}
  return {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
      store[k] = String(v)
    },
    removeItem: (k) => {
      delete store[k]
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k]
    },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length
    }
  } as Storage
}
