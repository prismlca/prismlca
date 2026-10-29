/**
 * The start page's two app settings: which models were opened lately, and whether the news card may
 * fetch on its own.
 *
 * Shared because both sides coerce the same list — main when it reads `settings.json`
 * (`getSettings`), the renderer's test fixture when it stands in for main — and two copies of a
 * sanitiser drift apart the first time one of them is touched.
 */

/** One "I opened this model" — per Brightway project, because a model name is only unique inside one. */
export interface RecentModel {
  project: string
  /** The model's database name. A rename moves it (lib/recentModels.ts `renameRecentModel`). */
  db: string
  /** ISO timestamp of the open. */
  openedAt: string
}

/** How many opens the file keeps, across all projects. The card shows five of the current project. */
export const RECENT_MODELS_CAP = 10

const keyOf = (r: { project: string; db: string }): string => JSON.stringify([r.project, r.db])

/**
 * Whatever the file (or a patch) holds, made into a clean list: well-formed entries only, newest
 * first, one entry per project + model (the newest open wins), at most `RECENT_MODELS_CAP`.
 *
 * An entry whose date does not parse is dropped rather than kept at the end: it could never be
 * placed in the order, and "opened at some point" is not something the card can show.
 */
export function sanitiseRecentModels(raw: unknown): RecentModel[] {
  if (!Array.isArray(raw)) return []
  const valid: Array<RecentModel & { t: number }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (typeof e.project !== 'string' || typeof e.db !== 'string' || typeof e.openedAt !== 'string') continue
    if (!e.db) continue
    const t = Date.parse(e.openedAt)
    if (!Number.isFinite(t)) continue
    valid.push({ project: e.project, db: e.db, openedAt: e.openedAt, t })
  }
  // Stable sort, so two opens with the same stamp keep the order they were written in.
  valid.sort((a, b) => b.t - a.t)
  const seen = new Set<string>()
  const out: RecentModel[] = []
  for (const { project, db, openedAt } of valid) {
    const k = keyOf({ project, db })
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ project, db, openedAt })
    if (out.length >= RECENT_MODELS_CAP) break
  }
  return out
}
