/** Small shared result/argument helpers for the tool handlers. */
import type { ToolCtx } from './context'

export const AI = { source: 'ai' } as const
export const S = (v: unknown): string => JSON.stringify(v)

/**
 * Keep the scenario that was written and drop the copy of every other one.
 *
 * The scenario endpoints answer with `{scenario, scenarios: [all of them]}`, which the Scenarios page
 * throws away and reloads for itself — only the assistant is charged for it, and a batch fans out to
 * one call per scenario, so creating five echoed 1+2+3+4+5 = 15 records. Measured 2026-08-12: in the
 * first 6,000 characters of one `edit_scenario` answer the first scenario appeared six times, the
 * second five, the third four. Exactly the shape `set_parameter` was already fixed for.
 */
export const oneScenario = (r: any): unknown =>
  r && typeof r === 'object' && r.scenario ? { scenario: r.scenario } : r
/** Cap a list so a huge model/search never blows the context; note how many were dropped. */
export function cap<T>(arr: T[], n: number): { items: T[]; note?: string } {
  if (arr.length <= n) return { items: arr }
  return { items: arr.slice(0, n), note: `… ${arr.length - n} more not shown (limit ${n}).` }
}
/** Cap a serialised block, saying so — a silently cut JSON string reads as complete but is not. */
export function capText(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n)} … [truncated, ${text.length} characters in total]`
}

/**
 * The foreground model an argument set refers to: an explicit name if given, otherwise the model open
 * on the canvas. Every model tool used to demand `database` on every call, which is both a wasted
 * argument (the chat is *about* one model) and one more long string to copy correctly.
 */
export function fgDb(a: any, ctx: ToolCtx): string | null {
  const explicit = a?.database ?? a?.activity_database
  const name = typeof explicit === 'string' ? explicit.trim() : ''
  return name || ctx.activeDb || null
}

export const NO_MODEL = S({
  error: 'No model open and no database given. Open a model or pass "database".'
})

/** Fold a batch of per-item results into one compact tool result. */
export function batchResult(
  results: Array<{ ok: boolean; item: unknown; result?: unknown; error?: string }>
): string {
  const failed = results.filter((r) => !r.ok)
  return S({
    total: results.length,
    succeeded: results.length - failed.length,
    failed: failed.length,
    // Successes are summarised, failures reported in full: a batch where item 7 of 20 failed is only
    // actionable if you can see which one and why.
    results: results.map((r, i) =>
      r.ok ? { i, ok: true, result: r.result } : { i, ok: false, item: r.item, error: r.error }
    ),
    hint: failed.length
      ? 'Some items failed; the rest were applied. Fix and retry only the failed ones.'
      : undefined
  })
}

/** Run one batch item, turning a throw into a per-item error instead of failing the whole call. */
export async function runItem(
  item: unknown,
  fn: () => Promise<unknown>
): Promise<{ ok: boolean; item: unknown; result?: unknown; error?: string }> {
  try {
    return { ok: true, item, result: await fn() }
  } catch (e) {
    return { ok: false, item, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * How the `research_web` question ceiling is described when the run has not said what it is.
 *
 * It used to name a number — "6 by default" — while the enforced value came from a setting. On the
 * 2026-08-13 apple-sauce run the setting was 4; the model asked exactly 4 and wrote in its own
 * critique "I asked 4 questions (under the limit of 6)", believing it had two questions of headroom
 * it did not have. A fifth would have been listed under `not_researched` unannounced. The static
 * text states the mechanism only, and `toolSpecs` substitutes the figure the run will enforce.
 */
export const RESEARCH_CAP_PHRASE = '(a limit the user sets in Settings → AI → Limits)'
