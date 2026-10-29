/**
 * Persistent API-usage ledger: the real per-request figures OpenRouter reports
 * (`usage.include: true` → `usage.cost`, `prompt_tokens`, `prompt_tokens_details.cached_tokens`),
 * accumulated per calendar month and model. Stored in the app's userData dir so it survives restarts
 * and spans all projects.
 *
 * `cost` is what the provider actually charged — the prompt-cache discount is already inside it, so
 * it must never be applied a second time. The token counts are kept separately because they answer a
 * question the cost alone cannot: how much of the prompt was served from the cache. That varies wildly
 * between providers (measured over the same scenarios: 19 % on Gemini 3.5 Flash, 87 % on Kimi K2.6),
 * which makes it a real factor when picking a model.
 *
 * Shape: { "2026-07": { "anthropic/claude-sonnet-5.5": { cost, prompt, cached, calls }, … }, … }
 */
import { app } from 'electron'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** What kind of work a request billed for — the split reported in the usage view (V127): a modelling chat,
 *  the report writers, the search embeddings, and speech-to-text as the small fourth. */
/** What the money went into. `import` is its own share rather than part of `modelling`: an import
 *  is a single deliberate act with a size you can see beforehand (n open rows), and folding it into
 *  the chat spend makes "what did that import cost me" unanswerable. */
export type UsageCategory = 'modelling' | 'reporting' | 'embedding' | 'speech' | 'import'

export interface UsageBucket {
  cost: number
  prompt: number
  cached: number
  /** Output tokens, reasoning included — the half the price actually hangs on. A correction round
   *  billed 13× as much per prompt token as the chapter it corrected, and nothing in this file could
   *  say why, because the difference sat entirely in tokens nobody recorded. Absent on entries
   *  written before this existed; read it as "not measured", not as zero. */
  completion?: number
  calls: number
}
export interface UsageEntry extends UsageBucket {
  /** Per-category share of the totals above. Absent on entries recorded before the split existed —
   *  those stay as bare totals rather than being guessed into a category. */
  categories?: Partial<Record<UsageCategory, UsageBucket>>
}
export type UsageMap = Record<string, Record<string, UsageEntry>>

let _cache: UsageMap | null = null

function file(): string {
  return join(app.getPath('userData'), 'ai-usage.json')
}

/**
 * Read a ledger of any vintage. Before token counts existed an entry was a bare number (USD); those
 * are carried over as cost-only rather than discarded — a wiped cost history would be worse than
 * missing token columns for old months.
 */
export function migrate(parsed: unknown): UsageMap {
  if (!parsed || typeof parsed !== 'object') return {}
  const out: UsageMap = {}
  for (const [month, models] of Object.entries(parsed as Record<string, unknown>)) {
    if (!models || typeof models !== 'object') continue
    const bucket: Record<string, UsageEntry> = {}
    for (const [id, value] of Object.entries(models as Record<string, unknown>)) {
      if (typeof value === 'number') {
        bucket[id] = { cost: value, prompt: 0, cached: 0, calls: 0 }
      } else if (value && typeof value === 'object') {
        const v = value as Partial<UsageEntry>
        const entry: UsageEntry = {
          cost: Number(v.cost) || 0,
          prompt: Number(v.prompt) || 0,
          cached: Number(v.cached) || 0,
          calls: Number(v.calls) || 0
        }
        // Optional, and stays absent when it was: a missing output-token count means "not measured",
        // and writing a 0 there would claim a request produced nothing.
        if (Number(v.completion)) entry.completion = Number(v.completion)
        // Category shares survive a reload; anything malformed is dropped, never invented.
        if (v.categories && typeof v.categories === 'object') {
          const categories: UsageEntry['categories'] = {}
          for (const [name, raw] of Object.entries(v.categories)) {
            if (!raw || typeof raw !== 'object') continue
            const c = raw as Partial<UsageBucket>
            categories[name as UsageCategory] = {
              cost: Number(c.cost) || 0,
              prompt: Number(c.prompt) || 0,
              cached: Number(c.cached) || 0,
              calls: Number(c.calls) || 0,
              ...(Number(c.completion) ? { completion: Number(c.completion) } : {})
            }
          }
          if (Object.keys(categories).length) entry.categories = categories
        }
        bucket[id] = entry
      }
    }
    out[month] = bucket
  }
  return out
}

function load(): UsageMap {
  if (_cache) return _cache
  try {
    _cache = migrate(JSON.parse(readFileSync(file(), 'utf-8')))
  } catch {
    _cache = {} // no file yet / unreadable → start fresh
  }
  return _cache
}

/**
 * Add one request's usage for a model under the current month. Never throws.
 *
 * Called for every model that bills, including the side runs the main loop spawns (the history
 * summariser and the research sub-agent, which use their own cheaper models) — those used to be
 * invisible here, so the ledger understated what a turn really cost.
 */
export function recordUsage(
  modelId: string,
  u: { cost?: number; prompt?: number; cached?: number; completion?: number },
  category: UsageCategory = 'modelling'
): void {
  if (!modelId) return
  const cost = Number.isFinite(u.cost) ? Math.max(0, u.cost as number) : 0
  const prompt = Number.isFinite(u.prompt) ? Math.max(0, u.prompt as number) : 0
  const cached = Number.isFinite(u.cached) ? Math.max(0, u.cached as number) : 0
  const completion = Number.isFinite(u.completion) ? Math.max(0, u.completion as number) : 0
  // A free model (or one whose provider omits the cost) still burned tokens, and a request that
  // reported nothing at all still happened: `calls` counts requests, not receipts. Booking only the
  // ones that came with numbers understated the count by exactly the calls that produced nothing —
  // four correction calls in the dialog, three in this file (V166).
  try {
    const data = load()
    const month = new Date().toISOString().slice(0, 7) // "2026-07"
    const bucket = (data[month] ??= {})
    const entry = (bucket[modelId] ??= { cost: 0, prompt: 0, cached: 0, calls: 0 })
    entry.cost += cost
    entry.prompt += prompt
    entry.cached += cached
    if (completion) entry.completion = (entry.completion ?? 0) + completion
    entry.calls += 1
    // The category share beside the totals, so "what did the report writing cost" has an answer
    // (V127). The totals stay the source of truth; a pre-split entry simply has no shares.
    const categories = (entry.categories ??= {})
    const share = (categories[category] ??= { cost: 0, prompt: 0, cached: 0, calls: 0 })
    share.cost += cost
    share.prompt += prompt
    share.cached += cached
    if (completion) share.completion = (share.completion ?? 0) + completion
    share.calls += 1
    // Atomic (tmp + rename): a crash mid-write must not corrupt the ledger — the loader
    // would silently start over with an empty cost history.
    const tmp = `${file()}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf-8')
    renameSync(tmp, file())
  } catch {
    /* a failed cost write must never break a chat turn */
  }
}

/** Cost-only shorthand for callers that have no token counts (e.g. speech-to-text). */
export function recordCost(modelId: string, cost: number, category: UsageCategory = 'speech'): void {
  recordUsage(modelId, { cost }, category)
}

export function getUsage(): UsageMap {
  return load()
}
