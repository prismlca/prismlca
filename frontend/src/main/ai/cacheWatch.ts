/**
 * Notices when the provider's prompt cache stops working during a run — from the figures alone.
 *
 * A run re-sends the whole conversation every round; a working prefix cache serves almost all of it at
 * a fraction of the price. The ways it was seen to fail, all unnoticed until the cost ledger:
 *
 * - **missed**, then **dropped**: a round reads nothing from the cache although earlier rounds of the
 *   same run did — a route that switched to an endpoint without the cached prefix, or a provider that
 *   lost it. Each such round is billed in full. One such round is said as what it is; a second in a row
 *   means the cache is not working on this route, and is said so.
 * - **partial**: a round is served far less than the previous round had already sent — an endpoint that
 *   still holds an older state of the conversation, or only its fixed head. Everything past that is
 *   billed in full again. Seen with one model at a third of the previous prompt; in every other run the
 *   hit was at least 97 % of it.
 * - **stuck**: the cached share stays at the same figure round after round while the prompt grows —
 *   only the fixed head (system prompt, tools, task) is served from the cache, every round's new part
 *   is billed in full again and again.
 *
 * A model or route that never caches never trips any rule: all need a hit first. A miss after a long
 * pause (the cache has expired) is not a fault. A compaction rewrites the conversation behind the fixed
 * head (`reset`): the stuck count starts over, and the round right after it may miss without a warning
 * — the head should still be served, but a provider that keys its cache on the whole previous request
 * will not. A cache that stays at zero after that round is reported as before.
 */

export type CacheAlarm = 'missed' | 'dropped' | 'partial' | 'stuck'
/** What the watch reports: an alarm, or that the cache works again after one. A single miss in the
 *  middle of a run (a route that switched endpoints once) would otherwise leave a warning standing
 *  for the rest of it, over rounds that are served from the cache again. */
export type CacheSignal = CacheAlarm | 'recovered'

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
/** "partial": the hit is below this share of the previous round's prompt… */
const PARTIAL_MAX_SHARE = 0.9
/** …and leaves at least this many tokens of it to be billed in full again. Block rounding and a note
 *  dropped from the tail cost a few hundred; this is several rounds' worth of new conversation. */
const PARTIAL_MIN_TOKENS = 8192

export interface CacheObservation {
  /** Prompt tokens of the round, cached share included. */
  prompt: number
  /** Of those, served from the provider's cache. */
  cached: number
  /** Time between the end of the previous round and this request; absent for the first round. */
  idleMs?: number
  /** The figures add up more than one pass of the model — a continued reply, the turns of a
   *  server-side search. Such a prompt is no prefix of the next round's, so it is no measure for it. */
  aggregate?: boolean
}

export interface CacheWatch {
  /** Read one round's figures; returns the alarm it raises, or null. "missed" and "partial" describe
   *  one round and are raised for each; "dropped" (the second miss in a row) and "stuck" once per
   *  episode: again only after the cache has worked in between. The first round that ends what was
   *  raised says so ("recovered"): after a miss or a partial hit, a round that covers what the round
   *  before had sent — a hit as short as before, or one that cannot be measured against the round
   *  before, ends nothing; after "stuck", a cached
   *  figure above the one it was stuck at — a figure that only fell is no recovery, and a hit after a
   *  miss inside a stall says "stuck" again. */
  observe(o: CacheObservation): CacheSignal | null
  /** The conversation was rewritten (compaction): earlier figures no longer describe this prefix. */
  reset(): void
}

export function createCacheWatch(): CacheWatch {
  /** Some round of this run was served from the cache — the provider caches on this route. */
  let seenHit = false
  /** Misses in a row that counted (not after a pause, not right after a compaction). */
  let misses = 0
  /** A miss or a partial hit was said and no full hit has come since. */
  let open = false
  /** The previous round, as the measure for this one's hit; unknown after a compaction. */
  let prev: CacheObservation | undefined
  /** The cached figure "stuck" was said for; cleared when the figure moves. */
  let stuckAt: number | undefined
  /** The last rounds with a hit, newest last (at most STUCK_ROUNDS). */
  let recent: CacheObservation[] = []
  /** Rounds still exempt from "dropped" — the one after a compaction. */
  let grace = 0
  /** An unresolved stall, with the cached figure a recovery has to exceed: the highest it stalled at;
   *  unknown right after a compaction until the next hit sets it. Kept through a full miss — a miss
   *  inside a stall ends the miss when hits return, not the stall. */
  let stall: { at?: number } | null = null

  return {
    observe(o) {
      if (!(o.prompt >= MIN_PROMPT_TOKENS)) {
        prev = undefined
        return null
      }
      const cached = Math.max(0, o.cached || 0)
      const exempt = grace > 0
      if (exempt) grace--
      const expired = (o.idleMs ?? 0) >= CACHE_TTL_MS
      const base = prev
      prev = { ...o, cached }
      if (cached === 0) {
        recent = []
        stuckAt = undefined
        if (!seenHit || expired || exempt) return null
        misses++
        open = true
        return misses === 1 ? 'missed' : misses === 2 ? 'dropped' : null
      }
      const afterMiss = misses > 0
      seenHit = true
      misses = 0
      // Measured against what the previous round sent: this prompt starts with it, so the cache should
      // serve nearly all of it. Not when either round's figures count several passes (the earlier one
      // is then larger than this prompt).
      const measurable = !!base && !base.aggregate && !o.aggregate && o.prompt >= base.prompt
      const covered =
        measurable && (base.prompt - cached < PARTIAL_MIN_TOKENS || cached >= base.prompt * PARTIAL_MAX_SHARE)
      // Said only where a short hit is a fault: not after a pause or a compaction, and not when the
      // figure did not move — that is a stall, which has its own rule. Such a round is no recovery
      // either: only a round that covers the previous prompt ends what was said.
      const partial = measurable && !covered && !expired && !exempt && cached !== base.cached
      if (stuckAt !== undefined && cached !== stuckAt) stuckAt = undefined
      recent = [...recent, { ...o, cached }].slice(-STUCK_ROUNDS)
      // Grown past the figure it stalled at, or served from the cache after a miss: the episode is over.
      // A hit right after a miss inside a stall ends the miss only — the bar says "stuck" again. The
      // same round cannot raise a new stall: its figure just grew, or it is the first hit after a miss.
      // After a compaction the old figure describes another prefix; the first hit is the new one.
      // Inside a stall a partial hit is not said: the bar already says the new part is billed in full.
      if (stall) {
        if (stall.at === undefined) stall.at = cached
        else if (cached > stall.at) {
          stall = null
          open = partial
          return partial ? 'partial' : 'recovered'
        }
        if (afterMiss) {
          open = false
          return 'stuck'
        }
      } else if (partial) {
        open = true
        return 'partial'
      } else if (open && covered) {
        open = false
        return 'recovered'
      }
      if (recent.length < STUCK_ROUNDS || stuckAt !== undefined) return null
      if (!recent.every((r) => r.cached === cached)) return null
      const growth = recent[recent.length - 1].prompt - recent[0].prompt
      if (growth < STUCK_MIN_GROWTH_TOKENS || growth < recent[0].prompt * STUCK_MIN_GROWTH_SHARE) return null
      stuckAt = cached
      // A lower plateau inside an unresolved stall keeps the higher figure as the bar to clear: back up
      // to where it stalled before is not recovery.
      stall = { at: Math.max(stall?.at ?? 0, cached) }
      return 'stuck'
    },
    reset() {
      recent = []
      stuckAt = undefined
      prev = undefined
      grace = 1
      if (stall) stall = {}
    }
  }
}
