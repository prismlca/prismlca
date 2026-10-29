/**
 * Models the user added themselves, read from `<userData>/models.json`.
 *
 * Why this exists: the catalogue in `models.ts` is compiled into the asar, so a model that appears
 * after a release is unreachable until the next one — and that path is currently blocked anyway
 * (`electron-builder.yml` still points `publish.url` at a placeholder, and unsigned builds make
 * every Windows update a SmartScreen prompt). This file is the way out.
 *
 * Each limit below was chosen against an adversarial review of the first draft. The three that
 * shape this module:
 *
 *  - **Read ONCE, at startup.** No mtime watch, no re-read per access. `runAgent` resolves its
 *    model before the first await and reuses it for the whole turn, while the price lookup and the
 *    provider check read later — a file that changes mid-run would have let accounting and
 *    execution disagree about which model was used. One process, one catalogue.
 *  - **New ids only.** An id the built-in catalogue already carries is refused. Overriding one
 *    could point a role default at a user-modified entry, and changing its `provider` would defeat
 *    the fallback in `findModel`.
 *  - **OpenRouter only.** There the provider reports `usage.cost` itself, so the spend breaker
 *    works without a price in our table. The direct-OpenAI route computes cost from the catalogue,
 *    and a user-supplied price there opens holes a mandatory field does not close (a missing
 *    `cachedInput` yields NaN, which `agent.ts` accepts as a number and adds to the running total).
 *
 * Everything here is written so that NOTHING can throw out of `loadUserModels`. A throw would be
 * swallowed by the Electron wrapper below and reported as "no models, no problems" — the one
 * outcome worse than a refusal, because the user's six role choices would silently read as unset
 * with nothing on screen to explain it.
 */
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AiModel } from './models'

/** Bigger than any honest list of models, small enough that a synchronous read is unmeasurable. */
const MAX_BYTES = 256 * 1024
const MAX_ENTRIES = 50
/**
 * OpenRouter ids: `vendor/model`, with `:free`-style suffixes kept, and an optional leading `~`.
 *
 * The tilde is not decoration: it is how OpenRouter marks its moving "latest" pointers, and
 * thirteen of the 437 listed models carry one (`~anthropic/claude-fable-latest`,
 * `~z-ai/glm-latest`, …). Without it in the pattern the Add-model dialog offered those thirteen and
 * then refused them on click — found by opening the actual dialog, not by any test.
 *
 * Everything that could steer a URL stays out: the id is interpolated into
 * `/models/{id}/endpoints`, and `~` is a legal, unreserved path character that survives
 * encodeURIComponent unchanged.
 */
const ID_RE = /^~?[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:-]+$/
/**
 * Context window for an entry that does not state one, and the smallest one PrismLCA can actually
 * serve. `clampMaxTokens` puts a floor of MIN_MAX_TOKENS (20 000) under the OUTPUT limit of every
 * request regardless of model, so a model whose whole window is smaller than that can never be
 * given a valid request. Accepting it would produce a picker entry that fails on first use.
 */
const MIN_CONTEXT = 64_000
const MAX_CONTEXT = 10_000_000
const DEFAULT_CONTEXT = 128_000

export interface UserModelLoad {
  models: AiModel[]
  /** One line per refusal, in English — they are shown to the user under the settings table.
   *  Silence would be the worst outcome: someone would hunt for a model that never arrived. */
  problems: string[]
}

/** A value in a message, without ever calling a user-supplied `toString`. `String(x)` on
 *  `{"toString": 0}` throws, and that throw used to take the whole file down with it. */
const show = (v: unknown): string => {
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 60)}…` : v
  if (v === null || v === undefined) return String(v)
  if (typeof v === 'object') return Array.isArray(v) ? '[array]' : '[object]'
  try {
    return JSON.stringify(v) ?? '[value]'
  } catch {
    return '[value]'
  }
}

const RESERVED = new Set(['__proto__', 'constructor', 'prototype'])

/** Reserved keys, checked on the PARSED object rather than on the JSON text: `"__proto__"`
 *  spells `__proto__` after decoding and slips straight past a text match. */
function hasReservedKey(v: unknown, depth = 0): boolean {
  if (depth > 8 || v === null || typeof v !== 'object') return false
  if (Array.isArray(v)) return v.some((x) => hasReservedKey(x, depth + 1))
  for (const k of Object.keys(v)) {
    if (RESERVED.has(k)) return true
    if (hasReservedKey((v as Record<string, unknown>)[k], depth + 1)) return true
  }
  return false
}

/** The file's path. Separate from settings.json: it is a catalogue extension, not a setting, and a
 *  typo while hand-editing must not take the settings with it. */
export function userModelsPath(userDataDir: string): string {
  return join(userDataDir, 'models.json')
}

/**
 * Read and validate the file. Pure enough to test: pass the path, get models and complaints.
 * Never throws.
 */
export function loadUserModels(builtinIds: Set<string>, path: string): UserModelLoad {
  try {
    return read(builtinIds, path)
  } catch (e) {
    // Belt and braces. If this ever fires it is a bug here, not in the user's file — but it must
    // still arrive as a visible refusal rather than as silence.
    return { models: [], problems: [`models.json could not be read (${(e as Error)?.message}) — ignored.`] }
  }
}

function read(builtinIds: Set<string>, path: string): UserModelLoad {
  const problems: string[] = []
  const models: AiModel[] = []
  const fail = (msg: string): UserModelLoad => ({ models: [], problems: [msg] })

  let raw: string
  try {
    const st = statSync(path)
    if (!st.isFile()) return fail('models.json is not a regular file — ignored.')
    if (st.size > MAX_BYTES) return fail(`models.json is larger than ${MAX_BYTES / 1024} KB — ignored.`)
    raw = readFileSync(path, 'utf-8')
  } catch (e) {
    // Absent is the normal case and not a problem. Anything else — no permission, a bad symlink, a
    // read error — is a problem, and used to be indistinguishable from "you have no models.json".
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { models: [], problems: [] }
    return fail(`models.json could not be opened (${(e as Error)?.message}) — ignored.`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return fail(`models.json is not valid JSON (${(e as Error).message}) — ignored.`)
  }
  if (hasReservedKey(parsed)) return fail('models.json contains a reserved key (__proto__) — ignored.')

  const doc = parsed as { version?: unknown; models?: unknown }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    return fail('models.json must be an object — ignored.')
  if (doc.version !== 1) return fail(`models.json needs "version": 1 (found ${show(doc.version)}) — ignored.`)
  if (!Array.isArray(doc.models)) return fail('models.json needs a "models" array — ignored.')

  const entries = doc.models as Array<Record<string, unknown>>
  if (entries.length > MAX_ENTRIES) {
    problems.push(`models.json lists ${entries.length} models; only the first ${MAX_ENTRIES} are read.`)
  }

  const seen = new Set<string>()
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    const where = (why: string): void => {
      problems.push(`models.json: ${why}`)
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      where('an entry is not an object — skipped.')
      continue
    }
    const id = typeof entry.id === 'string' ? entry.id : ''
    // Dot segments pass the pattern and survive encodeURIComponent, and the server then normalises
    // `/models/vendor/../endpoints` to a different resource. Refused explicitly.
    const segments = id.split('/')
    if (!id || !ID_RE.test(id) || segments.some((s) => s === '.' || s === '..')) {
      where(`${show(entry.id)} is not a valid OpenRouter id (vendor/model) — skipped.`)
      continue
    }
    if (builtinIds.has(id)) {
      where(`"${id}" is already in PrismLCA's own list — skipped. Only new models can be added.`)
      continue
    }
    if (seen.has(id)) {
      where(`"${id}" appears twice — the second one is skipped.`)
      continue
    }
    // Optional fields are REFUSED when wrong, not quietly replaced: a silently ignored `"vision":
    // "true"` is a model that never receives the screenshot the user expected it to see.
    const text = (key: 'label' | 'descriptor'): string | null | false => {
      const v = entry[key]
      if (v === undefined) return null
      if (typeof v !== 'string' || v.length === 0 || v.length > 80) {
        where(`"${id}": ${key} must be text of at most 80 characters — skipped.`)
        return false
      }
      return v
    }
    const label = text('label')
    if (label === false) continue
    const descriptor = text('descriptor')
    if (descriptor === false) continue

    const temperature = entry.temperature
    if (
      temperature !== undefined &&
      temperature !== null &&
      !(
        typeof temperature === 'number' &&
        Number.isFinite(temperature) &&
        temperature >= 0 &&
        temperature <= 2
      )
    ) {
      where(`"${id}": temperature must be a number between 0 and 2, or null — skipped.`)
      continue
    }
    if (entry.vision !== undefined && typeof entry.vision !== 'boolean') {
      where(`"${id}": vision must be true or false — skipped.`)
      continue
    }
    const ctx = entry.contextTokens
    if (
      ctx !== undefined &&
      !(typeof ctx === 'number' && Number.isInteger(ctx) && ctx >= MIN_CONTEXT && ctx <= MAX_CONTEXT)
    ) {
      where(
        `"${id}": contextTokens must be a whole number between ${MIN_CONTEXT} and ${MAX_CONTEXT} ` +
          `— skipped. PrismLCA asks for up to 20000 output tokens on every request, so a smaller window cannot work.`
      )
      continue
    }

    seen.add(id)
    models.push(
      Object.freeze({
        id,
        label: label ?? id,
        // Empty by default: the pickers append "— added by you" themselves, and a default of the
        // same words produced "added by you — added by you".
        descriptor: descriptor ?? '',
        // Not taken from the file, by design: `provider` fixed, ratings always absent
        // (OpenRouter's own AA figures are their join and were wrong for one of our twelve models),
        // `explicitCache` derived because it is a vendor rule, `selectable` because an entry you
        // cannot pick is pointless.
        provider: 'openrouter' as const,
        temperature: typeof temperature === 'number' ? temperature : null,
        intelligence: null,
        agentic: null,
        vision: entry.vision === true,
        contextTokens: typeof ctx === 'number' ? ctx : DEFAULT_CONTEXT,
        ...(id.startsWith('anthropic/') ? { explicitCache: true as const } : {}),
        userAdded: true as const
      })
    )
  }

  // Alphabetical among themselves: they carry no ratings, so there is nothing to rank them by.
  models.sort((a, b) => a.label.localeCompare(b.label))
  return { models, problems }
}

/**
 * Write the file back, atomically (tmp + rename, like settings.ts): a reader must never catch half
 * a file. Only the fields a user may set are written — the derived ones are recomputed on load, so
 * the file stays something a person can still edit by hand after PrismLCA has touched it.
 */
export function writeUserModels(path: string, models: AiModel[]): void {
  const doc = {
    version: 1,
    models: models.map((m) => ({
      id: m.id,
      ...(m.label && m.label !== m.id ? { label: m.label } : {}),
      ...(m.descriptor ? { descriptor: m.descriptor } : {}),
      ...(m.temperature != null ? { temperature: m.temperature } : {}),
      ...(m.vision ? { vision: true } : {}),
      ...(m.contextTokens ? { contextTokens: m.contextTokens } : {})
    }))
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8')
  renameSync(tmp, path)
}

/** The same, from Electron's userData. `app` is imported lazily and guarded so the catalogue can be
 *  loaded in a plain vitest process (no Electron): there it simply finds no user models, which is
 *  what keeps the built-in invariants testable. */
export function userDataDir(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as { app: { getPath: (n: string) => string } }
    return app.getPath('userData')
  } catch {
    return null // no Electron: a test process
  }
}

export function loadUserModelsFromUserData(builtinIds: Set<string>): UserModelLoad {
  let out: UserModelLoad
  try {
    const dir = userDataDir()
    if (!dir) return { models: [], problems: [] }
    out = loadUserModels(builtinIds, userModelsPath(dir))
  } catch {
    return { models: [], problems: [] } // no Electron = a test process, not a user with a problem
  }
  // Settings shows these too, but the log is what someone reaches for when the window will not
  // even open. Promised by the plan and previously not delivered.
  for (const p of out.problems) console.error(`[models.json] ${p}`)
  return out
}
