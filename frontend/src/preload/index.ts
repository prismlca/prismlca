import { contextBridge, ipcRenderer, webUtils } from 'electron'

/** How a handed-over file ended up: where it landed, or that it did not. */
export interface DownloadOutcome {
  filename: string
  /** The real path on disk — empty unless `state` is 'completed'. */
  path: string
  bytes: number
  state: 'completed' | 'cancelled' | 'interrupted' | string
}

// The IPC payload types live in shared/ipc.ts — one definition for main, this bridge and the
// renderer. (An older comment here claimed the preload boundary "will not let us import" the main
// type; that was wrong for type-only imports, which are erased at compile time.)
import type {
  AttachmentMeta,
  ChapterReview,
  KeyStatus,
  WriteAllOutcome,
  WritePhaseEvent,
  PendingAsk
} from '../shared/ipc'
import type { NewsFeed } from '../shared/news'
import type { UpdateState } from '../shared/updates'
import type { BuildInfo } from '../shared/buildInfo'

export type { WritePhaseEvent }

/** More files than one drop can attach anyway (main caps a message at 10); the rest are not
 *  resolved, only counted, and come back as `overflow`. */
const MAX_DROPPED = 50

/** Minimal, explicit bridge — the renderer never talks to Node or the backend directly. */
const api = {
  /** Who started this process and whether a person has taken it over — the banner of an instance the
   *  MCP bridge launched (main/mcp/idleQuit.ts). */
  bridge: {
    state: () =>
      ipcRenderer.invoke('prism:bridgeState') as Promise<{
        launchedBy: 'human' | 'bridge' | 'diagnostic'
        claimed: boolean
        idleMinutes: number
      }>,
    keepOpen: () => ipcRenderer.invoke('prism:bridgeKeepOpen') as Promise<void>,
    onState: (
      cb: (s: {
        launchedBy: 'human' | 'bridge' | 'diagnostic'
        claimed: boolean
        idleMinutes: number
      }) => void
    ) => {
      const listener = (
        _e: unknown,
        s: { launchedBy: 'human' | 'bridge' | 'diagnostic'; claimed: boolean; idleMinutes: number }
      ): void => cb(s)
      ipcRenderer.on('prism:bridge', listener)
      return () => ipcRenderer.removeListener('prism:bridge', listener)
    }
  },
  /** The MCP server for external agents (Settings → AI → External agents; main/ipc/mcp.ts). */
  mcp: {
    status: () => ipcRenderer.invoke('mcp:status'),
    setEnabled: (on: boolean) => ipcRenderer.invoke('mcp:setEnabled', on),
    regenerateToken: () => ipcRenderer.invoke('mcp:regenerateToken'),
    disconnect: (sessionId: string) => ipcRenderer.invoke('mcp:disconnect', sessionId),
    setApproval: (sessionId: string, mode: string) => ipcRenderer.invoke('mcp:setApproval', sessionId, mode),
    clients: () => ipcRenderer.invoke('mcp:clients'),
    configureClient: (id: string) => ipcRenderer.invoke('mcp:configureClient', id),
    testConnection: () => ipcRenderer.invoke('mcp:testConnection'),
    /** Subscribe to server/session events. Returns an unsubscribe fn. */
    onEvent: (cb: (ev: unknown) => void) => {
      const listener = (_e: unknown, ev: unknown): void => cb(ev)
      ipcRenderer.on('mcp:event', listener)
      return () => ipcRenderer.removeListener('mcp:event', listener)
    }
  },
  status: () => ipcRenderer.invoke('prism:status'),
  info: () => ipcRenderer.invoke('prism:info'),
  /** Version, commit, build kind, Electron and OS — the About page and "Copy version info". */
  buildInfo: () => ipcRenderer.invoke('prism:buildInfo') as Promise<BuildInfo>,
  /** The computer's regional format (`de-DE`, `en-GB`) — what a spreadsheet reads a pasted number by. */
  systemLocale: () => ipcRenderer.invoke('prism:systemLocale') as Promise<string>,
  api: (method: string, path: string, body?: unknown) =>
    ipcRenderer.invoke('prism:api', { method, path, body }) as Promise<{
      status: number
      body: unknown
    }>,
  pickDirectory: () => ipcRenderer.invoke('prism:pickDirectory') as Promise<string | null>,
  /** Write several rendered files into one folder the user picks once (Results → Save charts).
   *  null = the user cancelled the folder dialog. */
  saveFilesTo: (files: { name: string; dataUrl: string }[]) =>
    ipcRenderer.invoke('prism:saveFilesTo', files) as Promise<{
      dir: string
      written: string[]
      errors: string[]
    } | null>,
  pickFile: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('prism:pickFile', filters) as Promise<string | null>,
  /** Several files at once — chat attachments. Empty array = the user cancelled. */
  pickFiles: (filters?: { name: string; extensions: string[] }[]) =>
    ipcRenderer.invoke('prism:pickFiles', filters) as Promise<string[]>,
  /** Where dropped `File`s actually live, and permission for `ai.attach` to read them once each.
   *  The renderer cannot ask a File for its path any more (Electron 32 removed `File.path`);
   *  `webUtils.getPathForFile` is the sanctioned replacement and exists only here. Resolving AND
   *  granting in the preload is the point: the page hands over `File` objects, never paths, so a
   *  script in the page cannot grant a path the user did not drop (main/attachGrants.ts). Anything
   *  not backed by a real file (a dragged browser image) resolves to nothing and is left out. */
  droppedFilePaths: async (files: File[]): Promise<{ paths: string[]; overflow: number }> => {
    // Nothing of the page's object is trusted but its elements, and those only through
    // getPathForFile: no `files.map`/`filter`/iterator (a page can hand over an object whose own
    // `map` returns any strings it likes), a length read once, index access, and a fresh array
    // out. getPathForFile throws for anything that is not a real File, and a File the page built
    // itself has no disk path — so only what the user dropped gets granted.
    let length: unknown = 0
    try {
      length = files?.length
    } catch {
      length = 0
    }
    // A primitive, finite number only — no `Number(…)`, which would run a page-supplied `valueOf`.
    const total = typeof length === 'number' && Number.isFinite(length) && length > 0 ? Math.floor(length) : 0
    const n = Math.min(MAX_DROPPED, total)
    const paths: string[] = []
    for (let i = 0; i < n; i++) {
      let p: unknown = ''
      try {
        p = webUtils.getPathForFile(files[i])
      } catch {
        continue
      }
      if (typeof p === 'string' && p) paths.push(p)
    }
    if (paths.length) await ipcRenderer.invoke('prism:grantDropped', paths)
    // What was past the cap is reported, not silently lost: the renderer puts a chip up for it.
    return { paths, overflow: total - n }
  },
  /** Open a chat attachment from the project's sources folder, or (reveal) show it in the file
   *  manager. Resolves with the path it acted on, or an `error` a caller can put on screen. */
  openSource: (id: string, reveal?: boolean) =>
    ipcRenderer.invoke('prism:openSource', id, reveal) as Promise<{ path?: string; error?: string }>,
  /** Open the bundled licence text (AGPL-3.0) as a local file. */
  openLicence: () => ipcRenderer.invoke('prism:openLicence') as Promise<{ error?: string }>,
  /** Open the bundled third-party notices as a local file. */
  openNotices: () => ipcRenderer.invoke('prism:openNotices') as Promise<{ error?: string }>,
  /** The notices' summary tables (Markdown), for the in-app sheet. */
  noticesSummary: () =>
    ipcRenderer.invoke('prism:noticesSummary') as Promise<{ text: string; error?: string }>,
  /** Stop a running AI assignment — batches already answered are kept. */
  stopImportMatch: () => ipcRenderer.invoke('import:match:stop') as Promise<void>,
  /** Run the matching model over everything the import's deterministic pass left open. */
  matchImport: () =>
    ipcRenderer.invoke('import:match') as Promise<{
      done: number
      total: number
      matched: number
      open: number
      error?: string
    }>,
  onImportMatchProgress: (
    fn: (p: { done: number; total: number; matched: number; open: number }) => void
  ) => {
    const listener = (_e: unknown, p: { done: number; total: number; matched: number; open: number }): void =>
      fn(p)
    ipcRenderer.on('import:match-progress', listener)
    return () => ipcRenderer.removeListener('import:match-progress', listener)
  },
  openExternal: (url: string) => ipcRenderer.invoke('prism:openExternal', url) as Promise<void>,

  /** What became of a file the app handed to the browser's downloads. Returns an unsubscribe fn.
   *  Only the download knows whether it landed, where, and under which name — the renderer must not
   *  claim "Saved" before this arrives (V157). */
  onDownload: (cb: (d: DownloadOutcome) => void) => {
    const listener = (_e: unknown, d: DownloadOutcome): void => cb(d)
    ipcRenderer.on('prism:download', listener)
    return (): void => {
      ipcRenderer.removeListener('prism:download', listener)
    }
  },

  /** App settings that main owns (userData/settings.json): the cost brake, the disabled tools, the
   *  zero-data-retention decision. Main clamps what a run may spend, so these are not just storage. */
  appSettings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<Record<string, unknown>>,
    set: (patch: Record<string, unknown>) =>
      ipcRenderer.invoke('settings:set', patch) as Promise<Record<string, unknown>>,
    /** One-time handover of the values that used to live in the renderer's own store. */
    seed: (legacy: Record<string, unknown>) =>
      ipcRenderer.invoke('settings:seed', legacy) as Promise<Record<string, unknown>>
  },

  /** Transport distances (main/distance): keys, one lookup, the ledger. The keys never cross. */
  distance: {
    keyStatus: (provider: 'ors' | 'mapbox') =>
      ipcRenderer.invoke('distance:keyStatus', provider) as Promise<KeyStatus>,
    setKey: (key: string, provider: 'ors' | 'mapbox') =>
      ipcRenderer.invoke('distance:setKey', key, provider) as Promise<{
        ok: boolean
        error?: string
        status?: KeyStatus
      }>,
    clearKey: (provider: 'ors' | 'mapbox') =>
      ipcRenderer.invoke('distance:clearKey', provider) as Promise<{ ok: boolean; status?: KeyStatus }>,
    /** Which keys exist and which geocoder will answer — what the panel and the chat "+" menu gate on. */
    availability: () =>
      ipcRenderer.invoke('distance:availability') as Promise<{
        ors: boolean
        mapbox: boolean
        geocoder: 'ors' | 'mapbox' | null
        available: boolean
      }>,
    /** One pair, one mode — the panel's lookup. Rejects with a sentence when nothing can run. */
    compute: (req: {
      mode: string
      from: string
      to: string
      fromCountry?: string
      toCountry?: string
      via?: 'shortest' | 'cape'
    }) => ipcRenderer.invoke('distance:compute', req) as Promise<unknown>,
    /** Stop this window's running lookup; `ok: false` when none was running. */
    cancel: () => ipcRenderer.invoke('distance:cancel') as Promise<{ ok: boolean }>,
    usage: () => ipcRenderer.invoke('distance:usage') as Promise<Record<string, unknown>>,
    /** Typeahead while typing a place: openrouteservice, or with `kind` the local airport / port
     *  catalogue (free, no key). The panel debounces. Empty on any failure. */
    suggest: (req: { text: string; country?: string; kind?: 'airport' | 'port'; majorOnly?: boolean }) =>
      ipcRenderer.invoke('distance:suggest', req) as Promise<
        Array<{ label: string; lat: number; lon: number; country?: string }>
      >
  },

  /** The start page's project news (main/news/feed.ts). Rejects with a short sentence when the feed
   *  cannot be reached or read. Called only when the user allowed it — the renderer decides that. */
  news: {
    fetch: () => ipcRenderer.invoke('news:fetch') as Promise<NewsFeed>
  },

  /** The manual update check (main/updater.ts): nothing here runs unless the user clicks. Every call
   *  answers with the new state; `onEvent` pushes each change (progress included). */
  updates: {
    state: () => ipcRenderer.invoke('updates:state') as Promise<UpdateState>,
    check: () => ipcRenderer.invoke('updates:check') as Promise<UpdateState>,
    download: () => ipcRenderer.invoke('updates:download') as Promise<UpdateState>,
    install: () => ipcRenderer.invoke('updates:install') as Promise<UpdateState>,
    /** Forget a downloaded update (nothing installs on quit), or clear an install error. */
    discard: () => ipcRenderer.invoke('updates:discard') as Promise<UpdateState>,
    /** After a failed install the backend is already stopped: restart the whole app. */
    relaunch: () => ipcRenderer.invoke('updates:relaunch') as Promise<UpdateState>,
    /** Main asks the page to save what it holds before the backend stops for an update; `fn`'s
     *  promise settling is the answer. Returns the unsubscribe. */
    onSaveRequest: (fn: () => Promise<void>) => {
      const listener = (_e: unknown, id: number): void => {
        void fn()
          .catch(() => undefined)
          .finally(() => ipcRenderer.send('updates:saved', id))
      }
      ipcRenderer.on('updates:save-now', listener)
      return (): void => {
        ipcRenderer.removeListener('updates:save-now', listener)
      }
    },
    onEvent: (fn: (s: UpdateState) => void) => {
      const listener = (_e: unknown, s: UpdateState): void => fn(s)
      ipcRenderer.on('updates:event', listener)
      return () => ipcRenderer.removeListener('updates:event', listener)
    }
  },

  /** In-app assistant (OpenRouter agent runs in the main process; key never reaches here). */
  ai: {
    hasKey: () => ipcRenderer.invoke('ai:hasKey') as Promise<boolean>,
    /** The key itself never crosses this bridge — only whether one is set, a masked hint, where it
     *  came from, and which OS store holds it (so Settings can be honest about "securely stored").
     *  `provider` picks whose key ('openrouter' | 'openai'); omitted = OpenRouter. */
    keyStatus: (provider?: string) => ipcRenderer.invoke('ai:keyStatus', provider) as Promise<KeyStatus>,
    setKey: (key: string, provider?: string) =>
      ipcRenderer.invoke('ai:setKey', key, provider) as Promise<{
        ok: boolean
        error?: string
        status?: unknown
      }>,
    clearKey: (provider?: string) =>
      ipcRenderer.invoke('ai:clearKey', provider) as Promise<{ ok: boolean; status?: unknown }>,
    // month → model → { cost, prompt, cached, calls }; see main/ai/usage.ts (older ledgers with a
    // bare cost number are migrated on load, so the renderer always sees this shape).
    usage: () =>
      ipcRenderer.invoke('ai:usage') as Promise<
        Record<string, Record<string, { cost: number; prompt: number; cached: number; calls: number }>>
      >,
    models: () => ipcRenderer.invoke('ai:models') as Promise<unknown[]>,
    modelIssues: () => ipcRenderer.invoke('ai:modelIssues') as Promise<string[]>,
    openrouterCatalogue: () => ipcRenderer.invoke('ai:openrouterCatalogue') as Promise<unknown[]>,
    addUserModel: (entry: unknown) =>
      ipcRenderer.invoke('ai:addUserModel', entry) as Promise<{ ok: boolean; problems: string[] }>,
    removeUserModel: (id: string) =>
      ipcRenderer.invoke('ai:removeUserModel', id) as Promise<{ ok: boolean; problems: string[] }>,
    tools: () => ipcRenderer.invoke('ai:tools') as Promise<unknown[]>,
    // Write one report chapter (Report page button; not part of the agent's tool surface).
    writeSection: (payload: {
      brief: unknown
      model?: string
      database?: string | null
      checkPath?: string
    }) =>
      ipcRenderer.invoke('ai:writeSection', payload) as Promise<{
        text: string
        model: string
        lookups: Array<{ name: string; args: string; result: string }>
        findings: Array<{ kind: string; detail: string }>
        attempts: number
        figure: Record<string, unknown> | null
        incomplete?: boolean
        review?: ChapterReview | null
      }>,
    /**
     * What the chapter writer is doing right now — see reportWriter.WritePhase. `id` is present only
     * for a chapter inside a "Write all" run, so the panel can tell one lane of four from the single
     * Write it is actually watching. Returns an unsubscribe fn.
     */
    onWritePhase: (cb: (p: WritePhaseEvent) => void) => {
      const listener = (_e: unknown, p: WritePhaseEvent): void => cb(p)
      ipcRenderer.on('ai:writePhase', listener)
      return () => ipcRenderer.removeListener('ai:writePhase', listener)
    },
    /** The whole "Write all" run — the main process owns waves, lanes, abort and progress. */
    writeAll: (payload: {
      base: string
      waves: Array<Array<{ id: string; mode?: 'write' | 'update' }>>
      model?: string
      database?: string | null
      /** One cost account across the run's calls — see main/ipc/report. */
      costRun?: string
    }) => ipcRenderer.invoke('ai:writeAll', payload) as Promise<WriteAllOutcome[]>,
    /** Progress of a running "Write all" (one event per landed chapter). Returns an unsubscribe fn. */
    onWriteAllProgress: (cb: (p: { done: number; total: number; outcome?: { id: string } }) => void) => {
      const listener = (_e: unknown, p: { done: number; total: number; outcome?: { id: string } }): void =>
        cb(p)
      ipcRenderer.on('ai:writeAllProgress', listener)
      return () => ipcRenderer.removeListener('ai:writeAllProgress', listener)
    },
    expandAbbreviations: (payload: {
      candidates: string[]
      language?: string
      context?: string
      contexts?: Record<string, string>
      model?: string
      costRun?: string
    }) =>
      ipcRenderer.invoke('ai:expandAbbreviations', payload) as Promise<{
        resolved: Record<string, string>
        model: string
      }>,
    /**
     * Progress of a running study translation (one event per landed batch). Returns an unsubscribe fn.
     * The call itself is a plain invoke; only the "how far along" needs a channel of its own.
     */
    onTranslateProgress: (cb: (p: { done: number; total: number; batches: number }) => void) => {
      const listener = (_e: unknown, p: { done: number; total: number; batches: number }): void => cb(p)
      ipcRenderer.on('ai:translateProgress', listener)
      return () => ipcRenderer.removeListener('ai:translateProgress', listener)
    },
    /** Translate the study's own prose into the report language — candidates come from the backend. */
    translateStudyTexts: (payload: {
      candidates: Array<{ key: string; text: string }>
      language?: string
      model?: string
      costRun?: string
    }) =>
      ipcRenderer.invoke('ai:translateStudyTexts', payload) as Promise<{
        resolved: Record<string, string>
        model: string
      }>,
    /** Store the files the user just attached and describe them (size, pages, any warning). */
    attach: (paths: string[]) => ipcRenderer.invoke('ai:attach', paths) as Promise<AttachmentMeta[]>,
    send: (req: {
      chatId: string
      model: string
      activeDb: string | null
      history: Array<{ role: 'user' | 'assistant'; content: string }>
      userText: string
      attachments?: AttachmentMeta[]
      maxRounds?: number
      maxCostUsd?: number
      maxTokens?: number
      disabledTools?: string[]
      webSearch?: boolean
      webSearchAllowed?: boolean
      distancesAllowed?: boolean
      eurostatAllowed?: boolean
      focusTools?: boolean
      comparisonModels?: string[]
    }) => ipcRenderer.invoke('ai:send', req) as Promise<{ ok: boolean }>,
    cancel: (chatId: string) => ipcRenderer.invoke('ai:cancel', chatId) as Promise<{ ok: boolean }>,
    /** Queue a message for a chat's turn (running, or its next run); `queued: false` only for empty text. */
    steer: (chatId: string, text: string) =>
      ipcRenderer.invoke('ai:steer', chatId, text) as Promise<{ queued: boolean }>,
    /** Take a queued message back (by index), or all of them. */
    unsteer: (chatId: string, index?: number) =>
      ipcRenderer.invoke('ai:unsteer', chatId, index) as Promise<{ queued: string[] }>,
    steerQueue: (chatId: string) => ipcRenderer.invoke('ai:steerQueue', chatId) as Promise<string[]>,
    /** Does this chat have a run in flight? Asked when a chat is opened, because the renderer's own
     *  state cannot survive a reload while the run does (V274). */
    isRunning: (chatId: string) => ipcRenderer.invoke('ai:isRunning', chatId) as Promise<boolean>,
    /** The questions the assistant is waiting on right now (see main/ai/pendingAsks.ts). */
    pendingAsks: () => ipcRenderer.invoke('ai:pendingAsks') as Promise<PendingAsk[]>,
    /** Transcribe a finished voice recording (audio bytes pass through to OpenRouter untouched). */
    transcribe: (data: ArrayBuffer, format: string, language?: string) =>
      ipcRenderer.invoke('ai:transcribe', { data, format, language }) as Promise<{ text: string }>,
    /** Subscribe to streaming events (delta/tool/done/error). Returns an unsubscribe fn. */
    onEvent: (cb: (ev: unknown) => void) => {
      const listener = (_e: unknown, ev: unknown): void => cb(ev)
      ipcRenderer.on('ai:event', listener)
      return () => ipcRenderer.removeListener('ai:event', listener)
    },
    /** Subscribe to UI-tool requests from the agent. Returns an unsubscribe fn. */
    onUiTool: (
      cb: (msg: {
        reqId: string
        name: string
        args: Record<string, unknown>
        chatId?: string
        sessionId?: string
        clientName?: string
        /** The model the requesting run works on — the renderer refuses canvas actions for one not on screen. */
        database?: string
      }) => void
    ) => {
      const listener = (_e: unknown, msg: any): void => cb(msg)
      ipcRenderer.on('ai:ui-tool', listener)
      return () => ipcRenderer.removeListener('ai:ui-tool', listener)
    },
    /** Reply to a UI-tool request. */
    uiResult: (reqId: string, ok: boolean, result?: unknown, error?: string) =>
      ipcRenderer.send('ai:ui-result', { reqId, ok, result, error })
  }
}

contextBridge.exposeInMainWorld('prism', api)

export type PrismApi = typeof api
