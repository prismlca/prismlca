/** Renderer-side helpers for the assistant: the main-process agent bridge (streaming, tools) and
 * the backend chat-history / skills endpoints. */
import { api } from './api'
import type {
  AgentEvent,
  AttachmentMeta,
  ChapterReview,
  KeyStatus,
  ToolTrace,
  WriteAllOutcome,
  WritePhaseEvent
} from '../../../shared/ipc'
import type { ChatPlan, ChatRun, RunOutcome } from '../../../shared/plan'
import { trackWriteAll } from './report/writeAllRuns'

export interface AiModelInfo {
  id: string
  /** Which API serves this model; absent = 'openrouter'. Pickers show only the active provider's. */
  provider?: 'openrouter' | 'openai'
  label: string
  descriptor: string
  temperature: number | null // null = vendor default (parameter not sent)
  intelligence: number | null
  agentic: number | null
  vision: boolean
  pricing: { input: number; output: number; cachedInput?: number } | null
  /** 'list' = hand-maintained list prices from the catalogue (OpenAI has no pricing API);
   *  absent = fetched live from OpenRouter. The table labels the two differently. */
  pricingSource?: 'list'
  /** false = info/cost tables only, not offered as a chat model (e.g. the Whisper STT model). */
  selectable?: boolean
  /** true = from the user's own models.json, not from PrismLCA's list. Marked as such, never rated. */
  userAdded?: true
  /** Whether the model is offered the `plan` tool (main/ai/models.ts). Absent = true. A plan left by
   *  an earlier model is shown frozen while a model with `false` is selected. */
  planTool?: boolean
  /** Usable context in tokens (main/ai/models.ts); absent = unknown. The context meter's 100 %. */
  contextTokens?: number
  /** The reasoning-effort levels the model's API accepts (main/ai/models.ts); absent = default only. */
  reasoningEfforts?: ReasoningEffort[]
}

// The event union lives in shared/ipc.ts — one definition for main, preload and renderer. The old
// copy here ("the two processes cannot share a type across the preload boundary") had already fallen
// behind twice: on the token counts, and it was missing the `provider` event entirely. `AiEvent`
// stays as this side's long-standing name for it.
export type AiEvent = AgentEvent

export interface UiToolRequest {
  reqId: string
  name: string
  args: Record<string, unknown>
  chatId?: string
  /** The external-agent session asking (MCP); a request with it is not for any chat panel. */
  sessionId?: string
  clientName?: string
  /** The model the requesting run works on; absent from older payloads. */
  database?: string
}

export interface ChatSummary {
  id: string
  title: string
  created: string
  updated: string
  message_count: number
}
// ToolTrace lives in shared/ipc.ts; `status`/`ms` are optional there for exactly this side's
// in-flight rows (absent status = still running) and for stored traces from before every field
// existed.
export type { AttachmentMeta, ToolTrace } from '../../../shared/ipc'
import type { PendingAsk } from '../../../shared/ipc'
import type { ReasoningEffort } from '../../../shared/aiDefaults'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  ts?: string
  /** Files sent with a user turn. Only the description is stored — the files themselves live in the
   *  project's sources, so a reloaded chat can still show what was attached. `content` stays the
   *  prose the user typed, which is also what the main process matches its transcript against. */
  attachments?: AttachmentMeta[]
  tools?: ToolTrace[]
  /** USD this turn cost, as OpenRouter billed it. Shown on the turn's collapsed tool trace. */
  cost?: number
  /** What the turn consumed — snake_case because these come back from the chat API as stored.
   *  `prompt_tokens` INCLUDES `cached_tokens`: the cached share is the part of the same prompt the
   *  provider served from its prefix cache. The chat header sums all three over the conversation. */
  prompt_tokens?: number
  cached_tokens?: number
  completion_tokens?: number
  /** The prompt size of the turn's last round — how full the context was when it answered. */
  context_tokens?: number
  /** Which OpenRouter endpoint served the turn. Routing picks one per request, so the same model
   *  can be four times slower from one message to the next — this is what says which one it was. */
  provider?: string
  /** The turn's id — the key of its stored transcript (main). */
  turn_id?: string
  /** How a stopped turn ended; absent on an answered one. Structured, so nothing reads the italic
   *  stop note in `content` to decide whether "Continue" is offered. */
  outcome?: RunOutcome
}
export interface FullChat {
  id: string
  title: string | null
  messages: ChatMessage[]
  /** The assistant's checklist for this chat, absent when it keeps none (shared/plan.ts). */
  plan?: ChatPlan | null
  /** The chat's run state — what the plan card's Continue reads. Absent = idle. */
  run?: ChatRun | null
}
export interface Skill {
  id: string
  name: string
  description: string
  content: string
  enabled: boolean
  builtin?: boolean // ships with the app: toggleable, but not editable or deletable
}

// --- main-process agent bridge ---------------------------------------------
export const aiHasKey = (): Promise<boolean> => window.prism.ai.hasKey()

export type { KeyStatus } from '../../../shared/ipc'

// `provider` picks whose key ('openrouter' | 'openai'); omitted = OpenRouter (the older callers).
export const aiKeyStatus = (provider?: 'openrouter' | 'openai'): Promise<KeyStatus> =>
  window.prism.ai.keyStatus(provider)
/** Fired on `window` once a key was stored or cleared, so an open chat re-asks whether it may send. */
export const KEY_CHANGED_EVENT = 'prism:ai-key-changed'
const announceKeys = <T>(p: Promise<T>): Promise<T> =>
  p.finally(() => window.dispatchEvent(new Event(KEY_CHANGED_EVENT)))
export const aiSetKey = (
  key: string,
  provider?: 'openrouter' | 'openai'
): Promise<{ ok: boolean; error?: string }> => announceKeys(window.prism.ai.setKey(key, provider))
export const aiClearKey = (provider?: 'openrouter' | 'openai'): Promise<{ ok: boolean }> =>
  announceKeys(window.prism.ai.clearKey(provider))

/** One model's usage in one month, as the main process books it (see main/ai/usage.ts). `cost` is
 *  what the provider actually charged — the prompt-cache discount is already included.
 *  `categories` splits the totals by kind of work (modelling / reporting / embedding / speech);
 *  spend recorded before the split existed carries none (V127). */
export interface UsageEntry {
  cost: number
  prompt: number
  cached: number
  /** Output tokens, reasoning included — absent on entries booked before this was recorded, which is
   *  "not measured" rather than zero. Without it a correction round billing 13× as much per prompt
   *  token as the chapter it corrected had no explanation anywhere in the app. */
  completion?: number
  calls: number
  categories?: Partial<
    Record<
      'modelling' | 'reporting' | 'embedding' | 'speech',
      { cost: number; prompt: number; cached: number; completion?: number; calls: number }
    >
  >
}
export const aiUsage = (): Promise<Record<string, Record<string, UsageEntry>>> => window.prism.ai.usage()

export const aiModels = (): Promise<AiModelInfo[]> => window.prism.ai.models() as Promise<AiModelInfo[]>

/** One row of OpenRouter's model list, as the "Add model" dialog shows it. */
export interface OrCatalogueRow {
  id: string
  name: string
  contextTokens: number | null
  vision: boolean
  pricing: { input: number; output: number } | null
  /** Has a zero-retention endpoint. Without one the model cannot be served while the privacy
   *  rule is on — the dialog says so rather than letting the first use fail. */
  /** null = OpenRouter's ZDR listing could not be fetched; nothing is known either way. */
  zdr: boolean | null
  /** Already offered by PrismLCA, built-in or added: shown, but not addable again. */
  inCatalogue: boolean
}

/** Every model OpenRouter lists, for the picker. Cached an hour in main. */
export const orCatalogue = (): Promise<OrCatalogueRow[]> =>
  window.prism.ai.openrouterCatalogue() as Promise<OrCatalogueRow[]>

/** Fired on `window` once a user model was added or removed, so a catalogue cached elsewhere (the
 *  composer's model picker) re-reads instead of resolving the new id to a default. */
export const MODELS_CHANGED_EVENT = 'prism:ai-models-changed'
const announceModels = <T>(p: Promise<T>): Promise<T> =>
  p.finally(() => window.dispatchEvent(new Event(MODELS_CHANGED_EVENT)))

export const addUserModel = (entry: {
  id: string
  label?: string
  descriptor?: string
  vision?: boolean
  contextTokens?: number | null
}): Promise<{ ok: boolean; problems: string[] }> => announceModels(window.prism.ai.addUserModel(entry))

export const removeUserModel = (id: string): Promise<{ ok: boolean; problems: string[] }> =>
  announceModels(window.prism.ai.removeUserModel(id))

/** What PrismLCA refused in the user's own models.json — one line each, shown under the table. */
export const aiModelIssues = (): Promise<string[]> => window.prism.ai.modelIssues()

/** The legacy localStorage key the zero-data-retention preference lived under before it moved to
 *  the settings file — kept only so Settings can list it among the keys to clean up. Main mirrors
 *  the setting itself on every `settings:set`/`settings:seed`; no renderer push exists any more. */
export const ZDR_KEY = 'prism.ai.zeroDataRetention'

export interface AiToolInfo {
  name: string
  label: string
  hint: string
  group: string
}

/** The assistant's tool catalog (friendly names + hover hints) for Settings → AI-Tools.
 * Optional-chained: during dev HMR the renderer can be newer than the running preload/main —
 * an empty catalog then is better than a white-screen TypeError. */
export const aiTools = (): Promise<AiToolInfo[]> =>
  (window.prism.ai.tools?.() ?? Promise.resolve([])) as Promise<AiToolInfo[]>

/** Ask a model to write one report chapter from the backend's brief. */
export const aiWriteSection = (
  brief: unknown,
  model?: string,
  database?: string | null,
  checkPath?: string
): Promise<{
  text: string
  model: string
  lookups: Array<{ name: string; args: string; result: string }>
  findings: Array<{ kind: string; detail: string }>
  attempts: number
  figure: Record<string, unknown> | null
  /** The text is an unchecked draft — see WriteSectionResult in main/ai/reportWriter. */
  incomplete?: boolean
  /** What writer and second reader settled; sent with the store as `review`/`reviewed_by`. */
  review?: ChapterReview | null
}> => window.prism.ai.writeSection({ brief, model, database, checkPath })

// The wire shape (phase union + the id a "Write all" run stamps on) lives in shared/ipc.ts as
// WritePhaseEvent; this side has always called it WritePhase, so the name is kept as an alias.
export type WritePhase = WritePhaseEvent

/** Subscribe to the inside of a chapter write. Returns an unsubscribe fn. */
export const onAiWritePhase = (cb: (p: WritePhase) => void): (() => void) => window.prism.ai.onWritePhase(cb)

export type { WriteAllOutcome } from '../../../shared/ipc'

/**
 * Run the whole "Write all" plan in the main process — waves, lanes, abort and progress live there;
 * this side sends the plan and paints the outcomes. Cancel with `aiCancel('report:ai')`.
 */
export const aiWriteAll = (payload: {
  base: string
  /** `update` brings a written chapter up to date instead of writing it anew. */
  waves: Array<Array<{ id: string; mode?: 'write' | 'update' }>>
  model?: string
  database?: string | null
  /** The run's cost account, shared with its translation and glossary calls. */
  costRun?: string
}): Promise<WriteAllOutcome[]> => trackWriteAll(payload.base, window.prism.ai.writeAll(payload))

/** Subscribe to "Write all" progress (one event per landed chapter, with which one it was). */
export const onAiWriteAllProgress = (
  cb: (p: { done: number; total: number; outcome?: { id: string } }) => void
): (() => void) => window.prism.ai.onWriteAllProgress(cb)

/** Ask a model what the document's abbreviations mean. The list itself is extracted server-side. */
export const aiExpandAbbreviations = (
  candidates: string[],
  language?: string,
  context?: string,
  model?: string,
  costRun?: string,
  /** One sentence per abbreviation, where the document uses it — the backend's `contexts` (V410). */
  contexts?: Record<string, string> | undefined
): Promise<{ resolved: Record<string, string>; model: string }> => {
  // Built as a variable rather than inline: the preload's payload type does not name `contexts` yet,
  // and an inline literal would be refused for it. The IPC channel passes the object through as is.
  const payload = { candidates, language, context, model, costRun, contexts }
  return window.prism.ai.expandAbbreviations(payload)
}

/**
 * Subscribe to study-translation progress (one event per landed batch, in texts). The translation is
 * cut into batches in the main process, so it is the only side that can say how far along it is.
 */
export const onAiTranslateProgress = (
  cb: (p: { done: number; total: number; batches: number }) => void
): (() => void) => window.prism.ai.onTranslateProgress(cb)

/** Ask a model to translate the study's own prose. The candidate list is collected server-side. */
export const aiTranslateStudyTexts = (
  candidates: Array<{ key: string; text: string }>,
  language?: string,
  model?: string,
  costRun?: string
): Promise<{ resolved: Record<string, string>; model: string }> =>
  window.prism.ai.translateStudyTexts({ candidates, language, model, costRun })

export const aiSend = (req: {
  chatId: string
  model: string
  activeDb: string | null
  history: ChatMessage[]
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
  /** Model for the isolated sub-agents (research, BOM, review); '' = each keeps its own default. */
  researchModel?: string
  reviewModel?: string
  /** Background databases released to this chat (searched), so the prompt can name the data source exactly. */
  backgroundDbs?: string[]
  /** Installed background databases the user switched OFF for this chat — the prompt names them so the
   *  assistant says "switch it on" rather than "it does not exist". */
  withheldBackgrounds?: string[]
  libraryDbs?: string[]
  /** The comparison models (study metadata) this chat keeps switched on; main fetches their briefs. */
  comparisonModels?: string[]
}): Promise<{ ok: boolean }> => window.prism.ai.send(req)

/** Queue a message for the chat's turn — delivered after its current step, or with the chat's next
 *  run when none is going. `queued: false` only for an empty text. */
export const aiSteer = (chatId: string, text: string): Promise<{ queued: boolean }> =>
  window.prism.ai.steer(chatId, text)
export const aiUnsteer = (chatId: string, index?: number): Promise<{ queued: string[] }> =>
  window.prism.ai.unsteer(chatId, index)
export const aiSteerQueue = (chatId: string): Promise<string[]> => window.prism.ai.steerQueue(chatId)

/** Hand attached files to the main process: it reads them and the backend stores them with the
 *  project. One description per path, in order — a refused file comes back with `error` set. */
export const aiAttach = (paths: string[]): Promise<AttachmentMeta[]> => window.prism.ai.attach(paths)

/** Several files through the OS dialog (chat attachments); empty = cancelled. */
export const pickFiles = (filters?: { name: string; extensions: string[] }[]): Promise<string[]> =>
  window.prism.pickFiles(filters)

/** A drop, resolved: the real paths behind the dropped `File`s — only the preload can answer this
 *  (Electron 32 removed `File.path`) — each granted one read for `aiAttach`, and how many files
 *  past the preload's cap were not looked at. Files not on disk are left out. */
/** The preload's cap per drop (preload/index.ts MAX_DROPPED); only named here in the chip. */
const MAX_DROPPED = 50

export interface DroppedFiles {
  paths: string[]
  overflow: number
}
export const droppedFilePaths = (files: File[]): Promise<DroppedFiles> => window.prism.droppedFilePaths(files)

/** Attach a resolved drop: one description per path, plus one refused entry standing for the files
 *  past the cap — so a 51-file drop shows 51 files' worth of outcome, as the dialog route does. */
export async function attachDropped(dropped: DroppedFiles): Promise<AttachmentMeta[]> {
  const added = dropped.paths.length ? await aiAttach(dropped.paths) : []
  if (dropped.overflow <= 0) return added
  const n = dropped.overflow
  return [
    ...added,
    {
      id: '',
      name: `${n} more file${n === 1 ? '' : 's'}`,
      kind: 'text',
      bytes: 0,
      error: `${n} more file${n === 1 ? ' was' : 's were'} not attached: one drop reads at most ${MAX_DROPPED} files. Drop them in smaller groups.`
    }
  ]
}

/** Open a file the user attached to a chat, or show it in the file manager (`reveal`). The stored
 *  copy in the project is the durable one — the context only ever holds a window onto it. */
export const openSource = (id: string, reveal?: boolean): Promise<{ path?: string; error?: string }> =>
  window.prism.openSource(id, reveal)

export const aiCancel = (chatId: string): Promise<{ ok: boolean }> => window.prism.ai.cancel(chatId)
/** Whether the main process still has a run in flight for this chat — the only party that knows
 *  after a reload, which is exactly when the panel's own `busy` has been reset (V274). */
export const aiIsRunning = (chatId: string): Promise<boolean> => window.prism.ai.isRunning(chatId)
/** The questions the assistant is waiting on, across chats and models. */
export const aiPendingAsks = (): Promise<PendingAsk[]> => window.prism.ai.pendingAsks()
export type { PendingAsk }

/** Send a finished voice recording to the main process for OpenRouter transcription.
 * `language` (ISO-639-1) pins the spoken language; omit for auto-detection. */
export const aiTranscribe = (
  data: ArrayBuffer,
  format: string,
  language?: string
): Promise<{ text: string }> => window.prism.ai.transcribe(data, format, language)

/** Languages offered for voice input (ISO-639-1 → label), 'auto' = let Whisper detect. */
export const VOICE_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pl', label: 'Polski' }
]

/** Default voice-input language: the system locale when we offer it, else auto-detect. Whisper's
 * auto-detect can return an English TRANSLATION of non-English speech, so a pinned default is
 * safer than 'auto' whenever the locale gives us a good guess. */
export const defaultVoiceLanguage = (): string => {
  const sys = (navigator.language || '').slice(0, 2).toLowerCase()
  return VOICE_LANGUAGES.some((l) => l.code === sys) ? sys : 'auto'
}

export const onAiEvent = (cb: (ev: AiEvent) => void): (() => void) =>
  window.prism.ai.onEvent((ev) => cb(ev as AiEvent))

export const onUiTool = (cb: (msg: UiToolRequest) => void): (() => void) => window.prism.ai.onUiTool(cb)

export const uiResult = (reqId: string, ok: boolean, result?: unknown, error?: string): void =>
  window.prism.ai.uiResult(reqId, ok, result, error)

// --- backend chat history + skills -----------------------------------------
const enc = encodeURIComponent
export const listChats = (db: string): Promise<{ chats: ChatSummary[] }> =>
  api('GET', `/api/v1/ai/chats/${enc(db)}`)
export const getChat = (db: string, id: string): Promise<FullChat> =>
  api('GET', `/api/v1/ai/chats/${enc(db)}/${enc(id)}`)
export const createChat = (db: string, title?: string): Promise<FullChat> =>
  api('POST', `/api/v1/ai/chats/${enc(db)}`, { title })
export const appendMessages = (db: string, id: string, messages: ChatMessage[]): Promise<FullChat> =>
  api('POST', `/api/v1/ai/chats/${enc(db)}/${enc(id)}/messages`, { messages })
export const deleteChat = (db: string, id: string): Promise<unknown> =>
  api('POST', `/api/v1/ai/chats/${enc(db)}/${enc(id)}/delete`)
export const renameChat = (db: string, id: string, title: string): Promise<unknown> =>
  api('POST', `/api/v1/ai/chats/${enc(db)}/${enc(id)}/rename`, { title })

export const listSkills = (): Promise<{ skills: Skill[] }> => api('GET', '/api/v1/ai/skills')
export const createSkill = (name: string, description: string, content: string): Promise<Skill> =>
  api('POST', '/api/v1/ai/skills', { name, description, content })
export const updateSkill = (
  id: string,
  patch: Partial<Pick<Skill, 'name' | 'description' | 'content' | 'enabled'>>
): Promise<Skill> => api('POST', `/api/v1/ai/skills/${enc(id)}`, patch)
export const deleteSkill = (id: string): Promise<unknown> =>
  api('POST', `/api/v1/ai/skills/${enc(id)}/delete`)
