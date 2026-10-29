/**
 * App settings the main process needs — kept in `userData`, not in the renderer's store.
 *
 * These used to live in `localStorage`, which had two consequences worth fixing rather than
 * moving:
 *
 *  - **The cost brake was set by the side it limits.** The renderer read `prism.ai.maxCostUsd` and
 *    sent the number along with each `ai:send`; whatever arrived was the limit. Now the limit lives
 *    here and `clampCost()` takes the *smaller* of the two, so a request can ask for less and never
 *    for more.
 *  - **Zero-data-retention held the default until the renderer said otherwise.** The renderer
 *    mirrored the setting at startup, which is a race the code named honestly and lived with. Main
 *    now knows it before a window exists.
 *
 * Everything here is a *preference of the application* — not project data. Project data lives in the
 * backend (see `engine/view_store.py`); a machine's settings do not belong in a study that gets
 * exported and sent to somebody.
 *
 * Unknown keys are kept: a newer build's setting must survive this one being run once. Same rule as
 * the view store and the model bundle.
 */
import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  clampMaxTokens,
  clampWebLookups,
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_RESEARCH_QUESTIONS,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MIN_THROUGHPUT,
  DEFAULT_MAX_TOKENS,
  DEFAULT_WRITER_MAX_TOKENS,
  DEFAULT_MODEL_ID,
  DEFAULT_WEB_LOOKUPS_PER_ANSWER,
  DEFAULT_ZDR_EXCEPT_ANTHROPIC,
  DEFAULT_ZDR_EXCEPT_GOOGLE,
  DEFAULT_ZDR_EXCEPT_OPENAI,
  DEFAULT_ZERO_DATA_RETENTION,
  sanitiseReasoningEfforts
} from '../shared/aiDefaults'
import { DEFAULT_TRANSPORT, sanitiseTransport } from '../shared/distanceDefaults'
import { ALL_SPELLCHECK_DICTS } from '../shared/spellcheck'
import type { AppSettings } from '../shared/ipc'
import { DEFAULT_DISPLAY, sanitiseDisplay } from '../shared/displayDefaults'
import { sanitiseRecentModels } from '../shared/startPage'
import { getModels } from './ai/models'

/** Bumped only for a change that cannot be read additively. A new setting is a new key.
 *
 * Schema 2: `maxResearchQuestions` 4 → 6. The default was raised to 6 (V80), but a
 * file written before that had materialised the old default as a stored value, so the raise never
 * reached any existing installation — runs repeatedly noted "effectively 4; the
 * default 6 applies only after a reset". Migrated only when the stored value IS the old default:
 * a 4 in a schema-1 file is the materialised default with near certainty, while any other number
 * was typed by someone and stays. This is the one thing a schema bump is for — a stored value whose
 * meaning ("whatever the default is") cannot be told from its content.
 *
 * Schema 3: `stealth/ox-alpha` → `z-ai/glm-5.3-flash`. OpenRouter retired the stealth id on
 * 2026-08-26 and its endpoint answers 404 with "This model was ZAI's GLM-5.3 Flash". A stored id
 * outlives the catalogue — a picker that no longer offers a model does nothing for the person who
 * already chose it — so anyone who had set it for the chat, the research legs, the reviewer, the
 * writer or the summariser would go on calling a dead endpoint, and find out by losing a paid run
 * (sixteen 404s inside one report run, measured). The successor is the same weights under their real
 * name, so the value moves rather than being cleared.
 *
 * Schema 4: `maxCostUsd` 2 → 15. Same shape as schema 2 and the same reason: a file written before
 * that raise materialised the old default as a stored value, so the raise would never reach an
 * existing installation — the one case where the stored number means "whatever the default is"
 * rather than a decision. Migrated only when it IS 2; any other figure was typed by someone. */
//: The stealth model OpenRouter retired on 2026-08-26, and the id it told us to move to. Kept as
//: named constants because the migration below and any future note about them should not drift apart.
const RETIRED_STEALTH_ID = 'stealth/ox-alpha'
const STEALTH_SUCCESSOR_ID = 'z-ai/glm-5.3-flash'

const SCHEMA = 4

// The shape lives in shared/ipc.ts — the renderer's store shows the same fields, and two copies
// of this interface had to be kept in step by hand. Re-exported because this module owns the file
// behind it and every main-side importer points here.
export type { AppSettings } from '../shared/ipc'

/** English always — the UI's language — plus the OS language when a report can be written in it.
 *  `app` is optional-chained because the unit tests mock a bare `app` with only `getPath`. */
/**
 * The dictionaries a fresh install checks against, for one locale: English plus the user's own
 * language when PrismLCA ships a dictionary for it (it ships five — the report languages).
 *
 * Pure, and exported, because the interesting part is the input. `de_DE.UTF-8`, `de-DE` and `de` all
 * have to mean German, and a locale we have no dictionary for (say `it-IT`) has to mean English alone
 * rather than a code Chromium would try to fetch.
 */
export function defaultDictsFor(locale: string): string[] {
  const langs = ['en-US']
  const tag = String(locale || '')
    .split(/[.@]/)[0]
    .replace('_', '-')
    .toLowerCase()
  const match = ALL_SPELLCHECK_DICTS.find((d) => tag.startsWith(d.slice(0, 2).toLowerCase()))
  if (match && match !== 'en-US') {
    // A generic "pt" locale reads as European Portuguese; an explicit pt-BR gets exactly itself.
    if (match.startsWith('pt')) langs.push(tag.startsWith('pt-br') ? 'pt-BR' : 'pt-PT')
    else langs.push(match)
  }
  return langs
}

/**
 * The locale to build that default from.
 *
 * `app.getLocale()` is only meaningful **after** the ready event, and this module is imported long
 * before it — so asking Electron at import time is how the whole branch came to be dead code: a
 * German system got English-only spell checking, and the German goal & scope in Model info was
 * underlined word for word (measured: `LANG=de_DE.UTF-8`, effective `['en-US']`). Hence
 * two sources, in this order: Electron once it is ready (the only one that knows on Windows and
 * macOS), and the environment before that (the one that knows on Linux, ready or not).
 */
function currentLocale(): string {
  try {
    if (app?.isReady?.() && app.getLocale?.()) return app.getLocale()
  } catch {
    /* no app, or none ready — the environment below is the answer then */
  }
  return process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || ''
}

function defaultSpellcheckLanguages(): string[] {
  return defaultDictsFor(currentLocale())
}

export const DEFAULTS: AppSettings = {
  provider: 'openrouter',
  model: DEFAULT_MODEL_ID,
  writerModel: '',
  researchModel: '',
  reviewModel: '',
  matchModel: '',
  maxCostUsd: DEFAULT_MAX_COST_USD,
  maxRounds: DEFAULT_MAX_ROUNDS,
  maxTokens: DEFAULT_MAX_TOKENS,
  writerMaxTokens: DEFAULT_WRITER_MAX_TOKENS,
  maxResearchQuestions: DEFAULT_MAX_RESEARCH_QUESTIONS,
  minThroughput: DEFAULT_MIN_THROUGHPUT,
  disabledTools: [],
  zeroDataRetention: DEFAULT_ZERO_DATA_RETENTION,
  zdrExceptAnthropic: DEFAULT_ZDR_EXCEPT_ANTHROPIC,
  zdrExceptOpenai: DEFAULT_ZDR_EXCEPT_OPENAI,
  zdrExceptGoogle: DEFAULT_ZDR_EXCEPT_GOOGLE,
  focusTools: false,
  voiceEnabled: true,
  voiceLanguage: '',
  webSearchEnabled: true,
  webLookupsPerAnswer: DEFAULT_WEB_LOOKUPS_PER_ANSWER,
  eurostatEnabled: true,
  // Shape only — the live answer is computed per read in `getSettings`, because at import time the app
  // is not ready and the locale is not knowable yet.
  spellcheckLanguages: defaultSpellcheckLanguages(),
  preferredBackground: '',
  transport: DEFAULT_TRANSPORT,
  display: DEFAULT_DISPLAY,
  // False on a fresh install, which is what makes the tour appear; only Finish on its last card
  // writes true. An existing installation has no key either, so upgraders see it once as well.
  welcomeTourDone: false,
  // Off: the start page fetches nothing from the internet until somebody says it may.
  newsAutoLoad: false,
  // On: an import or an index build left running overnight finishes instead of waiting for a key press.
  keepAwake: true,
  recentModels: [],
  // Off: no MCP listener, no external agent, until somebody switches it on.
  mcpEnabled: false,
  // On: the chat asks on a card before an irreversible tool action (main/ai/approval.ts).
  chatApproval: 'irreversible',
  // Nothing chosen: every model runs on its API's own reasoning default.
  reasoningEffort: {}
}

/** The five roles that name a model. Listed once — the retirement migration below walks the same
 *  set, and a sixth role added to one list and not the other is a silent gap. (`summaryModel` was
 *  once a sixth; a file that still carries it is read like any unknown key.) */
const MODEL_KEYS = ['model', 'writerModel', 'researchModel', 'reviewModel', 'matchModel'] as const

type Stored = { schema: number } & Partial<AppSettings> & Record<string, unknown>

let _cache: Stored | null = null

const file = (): string => join(app.getPath('userData'), 'settings.json')

/** One-time, versioned fixes to an existing file. Saved immediately when anything changed, so the
 *  migration runs once per installation, not once per read. */
function migrate(data: Stored): Stored {
  const from = Number(data.schema) || 1
  if (from >= SCHEMA) return data
  if (from < 2 && data.maxResearchQuestions === 4) {
    // The old default, materialised — see the SCHEMA note. 6 is what the raise intended.
    data.maxResearchQuestions = DEFAULT_MAX_RESEARCH_QUESTIONS
  }
  if (from < 3) {
    // OpenRouter retired `stealth/ox-alpha` on 2026-08-26 and its endpoint now answers 404 with
    // "This model was ZAI's GLM-5.3 Flash". A stored id outlives the catalogue: anyone who picked
    // the stealth model — for the chat, the research legs, the summariser or the writer — would go
    // on calling a dead endpoint on every run, and find out by losing a paid one. The successor is
    // the same weights under their real name, so the value moves rather than being cleared.
    for (const key of MODEL_KEYS) {
      if (data[key] === RETIRED_STEALTH_ID) data[key] = STEALTH_SUCCESSOR_ID
    }
  }
  if (from < 4 && data.maxCostUsd === 2) {
    // The old default, materialised — see the SCHEMA note. A brake that ends normal work is not a
    // brake, and nobody who never opened the field chose the number that ends it.
    data.maxCostUsd = DEFAULT_MAX_COST_USD
  }
  data.schema = SCHEMA
  save(data)
  return data
}

function load(): Stored {
  if (_cache) return _cache
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf-8')) as Stored
    if (parsed && typeof parsed === 'object') return (_cache = migrate(parsed))
  } catch {
    /* absent, or unreadable — the defaults are a working app, an exception is not */
  }
  return (_cache = { schema: SCHEMA })
}

function save(data: Stored): void {
  const f = file()
  const tmp = `${f}.tmp`
  // tmp + rename like the usage ledger: a reader must never catch half a file.
  writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf-8')
  renameSync(tmp, f)
}

/** Every setting, defaults filled in. Unknown stored keys are not returned but are never lost. */
export function getSettings(): AppSettings {
  const stored = load()
  const out = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS) as Array<keyof AppSettings>) {
    const v = stored[key]
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[key] = v
  }
  // The value crosses IPC and may come from a hand-edited file: anything unknown means the default.
  if (out.provider !== 'openai') out.provider = 'openrouter'
  out.maxTokens = clampMaxTokens(out.maxTokens)
  out.writerMaxTokens = clampMaxTokens(out.writerMaxTokens, DEFAULT_WRITER_MAX_TOKENS)
  out.webLookupsPerAnswer = clampWebLookups(out.webLookupsPerAnswer)
  out.maxCostUsd = Math.max(0, Number(out.maxCostUsd) || 0)
  out.maxRounds = Math.max(1, Math.round(Number(out.maxRounds) || DEFAULT_MAX_ROUNDS))
  if (!Array.isArray(out.disabledTools)) out.disabledTools = []
  // Only dictionaries that exist may be asked for — a stray code would make Chromium try (and fail)
  // to fetch a dictionary we do not ship. An empty array is a valid answer: checking off.
  // Computed per read, not taken from `DEFAULTS`: that object is built at import time, before the app
  // is ready, and the locale is only knowable later (see `currentLocale`). Asked of `stored`, not of
  // `out`, and that is the whole point — after the spread above `out` always holds an array, so a
  // check there can never see the case this exists for (the test caught exactly that). A stored value
  // wins, including the empty array that means "checking off".
  const storedDicts = stored.spellcheckLanguages
  out.spellcheckLanguages = Array.isArray(storedDicts)
    ? storedDicts.filter((l) => ALL_SPELLCHECK_DICTS.includes(l))
    : defaultSpellcheckLanguages()
  // A stored id that NO catalogue entry carries reads as "not set". Two reasons, and the second is
  // the important one:
  //
  //  - Someone removes a model from their own `models.json` and restarts. Without this, the chat
  //    would fall back (findModel resolves against the catalogue) while research, review,
  //    report and import matching kept sending to the removed endpoint — `modelForActive`
  //    (ipc/shared.ts) lets ANY non-empty id through on OpenRouter, and the transport passes it on.
  //    The UI would show "Default" while data still went to the model somebody had just deleted,
  //    possibly for privacy reasons. Found by an adversarial review of the models.json design.
  //  - The same hole is open today for any hand-edited id, and closing it here closes it once.
  //
  // Read-time only, never written back: put the model into models.json again and the choice
  // returns. Skipped if the catalogue is somehow empty, so a broken import cannot wipe six
  // settings at once.
  const catalogue = getModels()
  if (catalogue.length) {
    const known = new Set(catalogue.map((m) => m.id))
    for (const key of MODEL_KEYS) {
      if (out[key] && !known.has(out[key] as string)) out[key] = ''
    }
  }
  // A file written before the split said "research & review model" with one key, and it meant both.
  // Honour that reading rather than quietly moving somebody's reviewer back to the default; the
  // moment they pick a reviewer of their own, this stops applying.
  if (!out.reviewModel && stored.reviewModel === undefined) out.reviewModel = out.researchModel
  // An empty import matcher means its own default (providerDefaults().match, GPT-6 Luna) — not the
  // research model any more, and so not the chat model either when research is left empty, which is
  // where an unset matcher used to end up.
  // The one nested group: the overlay above copied whatever object the file held, so every field of
  // it is coerced here — a hand-edited factor of "abc" or a truncated `recent` list reads as default.
  out.transport = sanitiseTransport(stored.transport)
  out.display = sanitiseDisplay(stored.display)
  // A database name or nothing; anything else in the file reads as "let the assistant decide".
  out.preferredBackground = typeof out.preferredBackground === 'string' ? out.preferredBackground.trim() : ''
  // Anything but a literal true means the tour has not been finished — a truthy string in a
  // hand-edited file must not be what stops a first-run user ever seeing it.
  out.welcomeTourDone = out.welcomeTourDone === true
  // Same rule, same reason: only a literal true lets the start page reach the internet on its own.
  out.newsAutoLoad = out.newsAutoLoad === true
  // Only a literal false switches it off; it opens no channel, so a garbled value keeps the default.
  out.keepAwake = out.keepAwake !== false
  // Same rule again: only a literal true opens the door for external agents.
  out.mcpEnabled = out.mcpEnabled === true
  // Anything but the literal opt-out keeps the card: a hand-edited value must fail towards asking.
  out.chatApproval = out.chatApproval === 'never' ? 'never' : 'irreversible'
  // A map the overlay copied whole: only known levels under non-empty ids survive.
  out.reasoningEffort = sanitiseReasoningEfforts(stored.reasoningEffort)
  // A list the overlay copied wholesale — every entry checked, deduped, ordered and capped here.
  out.recentModels = sanitiseRecentModels(stored.recentModels)
  return out
}

/** Write through — there are no Save buttons in this app. Keys not sent are left as they are. */
export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const data = { ...load(), schema: SCHEMA }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    ;(data as Record<string, unknown>)[k] = v
  }
  // Save first: a write that fails (full disk) must not leave the cache claiming a value the file
  // and the transport mirrors do not have — zero data retention read as ON while requests still
  // went out without it. The throw reaches the caller; nothing was applied.
  save(data)
  _cache = data
  return getSettings()
}

/**
 * Take the settings from the renderer's store, once, so nobody's configuration resets on upgrade.
 *
 * Only fills keys the file does not have yet: after that the file is the truth, and a stale
 * `localStorage` copy must not overwrite a newer value set here.
 */
export function seedSettings(legacy: Partial<AppSettings>): AppSettings {
  const stored = load()
  const patch: Partial<AppSettings> = {}
  for (const key of Object.keys(DEFAULTS) as Array<keyof AppSettings>) {
    if (stored[key] === undefined && legacy[key] !== undefined) {
      ;(patch as Record<string, unknown>)[key] = legacy[key]
    }
  }
  return Object.keys(patch).length ? setSettings(patch) : getSettings()
}

/**
 * What a run may actually spend: the smaller of the stored limit and whatever the request asked for.
 *
 * The whole point of the move. `0` means "no limit" for the stored setting, so it does not clamp;
 * a request asking for more than the stored limit gets the stored limit.
 */
export function clampCost(requested?: number): number {
  const limit = getSettings().maxCostUsd
  const asked = Number(requested)
  if (!Number.isFinite(asked) || asked <= 0) return limit
  return limit > 0 ? Math.min(limit, asked) : asked
}

/** Same shape for the round budget: a request may ask for fewer rounds, never for more. */
export function clampRounds(requested?: number): number {
  const limit = getSettings().maxRounds
  const asked = Number(requested)
  if (!Number.isFinite(asked) || asked <= 0) return limit
  return Math.min(limit, Math.round(asked))
}

/** Test seam: forget the cached file so a test can write one and read it back. */
export function resetSettingsCache(): void {
  _cache = null
}
