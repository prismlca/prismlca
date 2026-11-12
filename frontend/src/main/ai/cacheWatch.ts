/**
 * Notices when the provider's prompt cache stops working during a run — from the figures alone.
 *
 * A run re-sends the whole conversation every round; a working prefix cache serves almost all of it at
 * a fraction of the price. Two ways it was seen to fail, both unnoticed until the cost ledger:
 *
 * - **dropped**: a round reads nothing from the cache although earlier rounds of the same run did —
 *   a route that switched to an endpoint without the cached prefix, or a provider that lost it. Each
 *   such round is billed in full.
 * - **stuck**: the cached share stays at the same figure round after round while the prompt grows —
 *   only the fixed head (system prompt, tools, task) is served from the cache, every round's new part
 *   is billed in full again and again.
 *
 * A model or route that never caches never trips either rule: both need a hit first. A miss after a
 * long pause (the cache has expired) is not a fault. A compaction rewrites the conversation behind the
 * fixed head (`reset`): the stuck count starts over, and the round right after it may miss without a
 * warning — the head should still be served, but a provider that keys its cache on the whole previous
 * request will not. A cache that stays at zero after that round is reported as before.
 */

export type CacheAlarm = 'dropped' | 'stuck'

/** Below this the providers do not cache at all (their minimum is about 1k tokens). */
const MIN_PROMPT_TOKENS = 2048
/** How long a provider keeps a prefix — five minutes is the shortest of them. A round sent after a
 *  longer gap may miss for that reason alone. */
export const CACHE_TTL_MS = 5 * 60_000
/** Rounds in a row with the very same cached figure before "stuck" is said. */
const STUCK_ROUNDS = 3
/** …while the prompt grew by at least this much over those rounds (tokens, and share of the first). */
const STUCK_MIN_GROWTH_TOKENS = 4096
const STUCK_MIN_GROWTH_SHARE = 0.1

export interface CacheObservation {
  /** Prompt tokens of the round, cached share included. */
  prompt: number
  /** Of those, served from the provider's cache. */
  cached: number
  /** Time between the end of the previous round and this request; absent for the first round. */
  idleMs?: number
}

export interface CacheWatch {
  /** Read one round's figures; returns the alarm it raises, or null. Each alarm is raised once per
   *  episode: again only after the cache has worked in between. */
  observe(o: CacheObservation): CacheAlarm | null
  /** The conversation was rewritten (compaction): earlier figures no longer describe this prefix. */
  reset(): void
}

export function createCacheWatch(): CacheWatch {
  /** Some round of this run was served from the cache — the provider caches on this route. */
  let seenHit = false
  /** "dropped" was said and no hit has come since. */
  let dropRaised = false
  /** The cached figure "stuck" was said for; cleared when the figure moves. */
  let stuckAt: number | undefined
  /** The last rounds with a hit, newest last (at most STUCK_ROUNDS). */
  let recent: CacheObservation[] = []
  /** Rounds still exempt from "dropped" — the one after a compaction. */
  let grace = 0

  return {
    observe(o) {
      if (!(o.prompt >= MIN_PROMPT_TOKENS)) return null
      const cached = Math.max(0, o.cached || 0)
      const exempt = grace > 0
      if (exempt) grace--
      if (cached === 0) {
        recent = []
        stuckAt = undefined
        const expired = (o.idleMs ?? 0) >= CACHE_TTL_MS
        if (!seenHit || dropRaised || expired || exempt) return null
        dropRaised = true
        return 'dropped'
      }
      seenHit = true
      dropRaised = false
      if (stuckAt !== undefined && cached !== stuckAt) stuckAt = undefined
      recent = [...recent, { ...o, cached }].slice(-STUCK_ROUNDS)
      if (recent.length < STUCK_ROUNDS || stuckAt !== undefined) return null
      if (!recent.every((r) => r.cached === cached)) return null
      const growth = recent[recent.length - 1].prompt - recent[0].prompt
      if (growth < STUCK_MIN_GROWTH_TOKENS || growth < recent[0].prompt * STUCK_MIN_GROWTH_SHARE) return null
      stuckAt = cached
      return 'stuck'
    },
    reset() {
      recent = []
      stuckAt = undefined
      grace = 1
    }
  }
}
