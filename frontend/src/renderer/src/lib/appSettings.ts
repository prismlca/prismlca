/**
 * The app settings that live in the main process (`userData/settings.json`), as seen from the renderer.
 *
 * They used to live here, in `localStorage`, which meant clearing the browser store reset the cost
 * brake, the disabled tools and the zero-data-retention decision — and, worse, that the cost brake
 * was a number this side sent along with each run. Main owns them now and clamps what it is sent; see
 * `main/settings.ts`.
 *
 * Shape kept deliberately dull: a synchronous snapshot plus a subscribe, so a component can read a
 * setting during render (`getAS().maxCostUsd`) exactly where it used to call `readLs`. The snapshot is
 * seeded from the old `localStorage` keys at module load, so the first render is already right, and
 * replaced by main's answer a tick later — which for an upgrade is the same values, since that is
 * what got seeded into the file.
 */
import { useSyncExternalStore } from 'react'
import {
  clampMaxTokens,
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_RESEARCH_QUESTIONS,
  DEFAULT_MIN_THROUGHPUT,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_WRITER_MAX_TOKENS,
  DEFAULT_MODEL_ID,
  DEFAULT_WEB_LOOKUPS_PER_ANSWER,
  DEFAULT_ZDR_EXCEPT_ANTHROPIC,
  DEFAULT_ZDR_EXCEPT_GOOGLE,
  DEFAULT_ZDR_EXCEPT_OPENAI,
  DEFAULT_ZERO_DATA_RETENTION
} from '../../../shared/aiDefaults'
import { DEFAULT_TRANSPORT } from '../../../shared/distanceDefaults'
import type { AppSettings as MainAppSettings } from '../../../shared/ipc'
import { readLs } from './persist'
import { sanitiseDisplay, type DisplaySettings } from '../../../shared/displayDefaults'

/**
 * Main's `AppSettings` (shared/ipc.ts — the one definition both processes read), loosened for this
 * store's two quirks: the bridge takes a plain record, so the index signature keeps that assignment
 * honest without a cast; and `spellcheckLanguages` is optional because the pre-init snapshot is
 * seeded from legacy localStorage keys, which never held it — main's answer fills it in.
 */
export type AppSettings = Omit<MainAppSettings, 'spellcheckLanguages'> & {
  [key: string]: unknown
  spellcheckLanguages?: string[]
}

/** The legacy keys. Read once at module load as the first snapshot, and handed to main once
 *  as the seed — after that the file is the truth and these are ignored. */
function legacy(): AppSettings {
  return {
    // Newer than the move to a file — no legacy key ever existed; main's default fills it in.
    provider: 'openrouter',
    model: readLs('prism.ai.model', DEFAULT_MODEL_ID),
    writerModel: readLs('prism.ai.writerModel', ''),
    researchModel: readLs('prism.ai.researchModel', ''),
    // Never had a localStorage key of their own: the split is newer than the move to a file, so the
    // seed just hands over the empty default and main's migration fills the reviewer in.
    reviewModel: '',
    matchModel: '',
    maxCostUsd: readLs('prism.ai.maxCostUsd', DEFAULT_MAX_COST_USD),
    maxRounds: readLs('prism.ai.maxRounds', DEFAULT_MAX_ROUNDS),
    maxTokens: clampMaxTokens(readLs('prism.ai.maxTokens', DEFAULT_MAX_TOKENS)),
    // Newer than the move to a file: no legacy key, the default stands until main answers.
    writerMaxTokens: DEFAULT_WRITER_MAX_TOKENS,
    maxResearchQuestions: DEFAULT_MAX_RESEARCH_QUESTIONS,
    minThroughput: DEFAULT_MIN_THROUGHPUT,
    disabledTools: readLs<string[]>('prism.ai.disabledTools', []),
    zeroDataRetention: readLs('prism.ai.zeroDataRetention', DEFAULT_ZERO_DATA_RETENTION),
    zdrExceptAnthropic: DEFAULT_ZDR_EXCEPT_ANTHROPIC,
    zdrExceptOpenai: DEFAULT_ZDR_EXCEPT_OPENAI,
    zdrExceptGoogle: DEFAULT_ZDR_EXCEPT_GOOGLE,
    focusTools: readLs('prism.ai.focusTools', false),
    voiceEnabled: readLs('prism.ai.voiceEnabled', true),
    voiceLanguage: readLs('prism.ai.voiceLanguage', ''),
    webSearchEnabled: readLs('prism.ai.webSearchEnabled', true),
    // Newer than the move to a file: no legacy key, the default stands until main answers.
    webLookupsPerAnswer: DEFAULT_WEB_LOOKUPS_PER_ANSWER,
    // Newer than the move to a file: no legacy key, the default stands until main answers.
    eurostatEnabled: true,
    preferredBackground: '',
    transport: DEFAULT_TRANSPORT,
    display: legacyDisplay(),
    // Never had a browser key: the tour is newer than the move to a file. False here only means
    // "until main answers" — and main's answer is the file, which is the one that decides.
    welcomeTourDone: false,
    // Both newer than the move to a file: no browser key ever existed, main's answer decides.
    newsAutoLoad: false,
    mcpEnabled: false,
    // Newer than the move to a file; the default stands until main answers.
    keepAwake: true,
    recentModels: [],
    // Newer than the move to a file; the default stands until main answers.
    chatApproval: 'irreversible',
    reasoningEffort: {}
  }
}

/** The Display/Modelling values as `lib/settings.ts` kept them in the browser (V353). */
function legacyDisplay(): DisplaySettings {
  const old = readLs<{ round?: unknown; modelling?: { freeUnits?: unknown } }>('prism.settings.v1', {})
  return sanitiseDisplay({ round: old.round, freeUnits: old.modelling?.freeUnits })
}

let snapshot: AppSettings = legacy()
const subscribers = new Set<() => void>()
/** Has main answered yet? Until it has, `snapshot` is the legacy seed — right for most keys, but a
 *  guess for any setting that never had a browser key. A reader that must not act on a guess (the
 *  welcome tour: showing it to somebody who has seen it is worse than showing it a tick late) waits
 *  for this. Set even when the call fails: the seed is then the best answer there will be. */
let ready = false

function publish(next: AppSettings): void {
  snapshot = next
  for (const fn of subscribers) fn()
}

/**
 * The writes main has not answered yet, in the order they were sent.
 *
 * Main's answer is the whole settings object as it stood after THAT write — so an answer that arrives
 * while later writes are still in flight describes an older world. Taking it as the snapshot (what
 * this used to do) threw the later writes away: open A, open B, A's answer lands, open C —
 * and B was gone from "Last models"; ticking the tour's news box and pressing Finish reopened the
 * tour, because the box's answer still said "not finished". So an answer is laid down first
 * and every write sent after it is laid on top again; a write leaves this list when its own answer
 * (or failure) arrives. An answer older than one already applied is ignored — it knows less.
 */
let requestSeq = 0
let appliedSeq = 0
const pending: Array<{ id: number; patch: Partial<AppSettings> }> = []

function settle(id: number): void {
  const at = pending.findIndex((p) => p.id === id)
  if (at >= 0) pending.splice(at, 1)
}

function reconcile(id: number, answer: Partial<AppSettings>): void {
  if (id < appliedSeq) return
  appliedSeq = id
  let next: AppSettings = { ...snapshot, ...answer }
  for (const p of pending) if (p.id > id) next = { ...next, ...p.patch }
  publish(next)
}

/** Read a setting during render or inside an event handler — the replacement for `readLs`. */
export const getAS = (): AppSettings => snapshot

/**
 * Hand main the old browser-store values once, then take its answer as the truth.
 *
 * Called at renderer startup. `seed` only fills keys the file does not have yet, so a value set in a
 * later session is never overwritten by a stale copy in this browser.
 */
export async function initAppSettings(): Promise<void> {
  const id = ++requestSeq
  try {
    const next = await window.prism.appSettings.seed(legacy())
    if (next) reconcile(id, next)
    migrateZeroDataRetention()
  } catch {
    /* main not ready: the legacy snapshot is a working app until the next start */
  } finally {
    ready = true
    for (const fn of subscribers) fn()
  }
}

/** True once main's answer has landed (or failed) — see `ready`. */
export function appSettingsReady(): boolean {
  return ready
}

/** The one setting that stayed behind in localStorage — carried over once, then the key is dropped.
 *
 * Seeding cannot do it: the file already HAS a `zeroDataRetention`, seeded when the rest moved, so a
 * seed leaves it alone. Meanwhile the switch kept writing only to localStorage, so on any machine
 * where it was ever toggled the two disagree — and the browser copy is the one that was actually
 * driving the requests. It therefore wins here, exactly once. */
function migrateZeroDataRetention(): void {
  const KEY = 'prism.ai.zeroDataRetention'
  try {
    if (window.localStorage.getItem(KEY) === null) return
    const stored = readLs(KEY, DEFAULT_ZERO_DATA_RETENTION)
    window.localStorage.removeItem(KEY)
    if (stored !== snapshot.zeroDataRetention) setAS({ zeroDataRetention: stored })
  } catch {
    /* no localStorage (or it threw): nothing to migrate */
  }
}

/**
 * The last write main refused, until a later write goes through. Each write sends only its own patch,
 * so a refused one is never resent — and main applies nothing when it cannot save. The switch used to
 * keep the refused value anyway: zero data retention read as ON for the rest of the session while main,
 * and the requests, went on without it. Now the store asks main what it holds and the page says the
 * write failed.
 */
let writeError: { id: number; message: string } | null = null
const errorSubscribers = new Set<() => void>()

function setWriteError(next: { id: number; message: string } | null): void {
  writeError = next
  for (const fn of errorSubscribers) fn()
}

/** Write through — there are no Save buttons. Optimistic locally, then main's normalised answer. */
export function setAS(patch: Partial<AppSettings>): void {
  const id = ++requestSeq
  pending.push({ id, patch })
  publish({ ...snapshot, ...patch })
  void window.prism.appSettings
    .set(patch)
    .then((next) => {
      settle(id)
      if (next) reconcile(id, next)
      // Only a write sent after the failure clears it: an older one answering late knows nothing of it.
      if (writeError && writeError.id < id) setWriteError(null)
    })
    .catch((e: unknown) => {
      settle(id)
      if (!writeError || writeError.id < id) {
        setWriteError({ id, message: e instanceof Error ? e.message : String(e) })
      }
      // Main's handlers run in the order they are invoked, so this answer includes every write sent
      // before it, and reconcile lays every write sent after it on top again. Main may also have stored
      // the patch and failed only while applying it — then the stored value is what comes back.
      const truthId = ++requestSeq
      void window.prism.appSettings
        .get()
        .then((stored) => {
          if (stored) reconcile(truthId, stored)
        })
        .catch(() => {
          /* main cannot answer at all: the shown value is the best guess there is */
        })
    })
}

/** The last refused settings write, or null — for the one line on the Settings page that says so. */
export function useAppSettingsWriteError(): string | null {
  return useSyncExternalStore(
    (fn) => {
      errorSubscribers.add(fn)
      return () => errorSubscribers.delete(fn)
    },
    () => writeError?.message ?? null
  )
}

/** For stores derived from this one (see lib/settings.ts). */
export function subscribeAppSettings(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function useAppSettings(): AppSettings {
  return useSyncExternalStore(
    (fn) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    getAS,
    getAS
  )
}
