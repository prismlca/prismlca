/**
 * How much of a tool's result reaches the model, and how it is cut when it must be.
 *
 * The old rule was one line: `resultStr.slice(0, 30_000)`. It was written before batching existed, and
 * batching is what broke it — a call now carries as many results as the model asked for. Measured on
 * one live run, 2 of 30 calls were cut: `get_skill` at 31,716 characters, so a skill's
 * INSTRUCTIONS ended mid-sentence, and a 12-query `search_background` at 34,939, so the JSON ended
 * inside an object and could not be parsed at all. Neither said a word about it. The model reported
 * both from the receiving end, which is the only reason they were found.
 *
 * Two rules follow, and they are the whole point of this module:
 *
 * 1. **The budget scales with what was asked for**, because a batch of twelve is twelve answers, not
 *    one. Not without limit: past a hard ceiling a single tool result would crowd the model out of its
 *    own context window, and a smaller answer is then genuinely better than a complete one.
 * 2. **Never cut inside a structure.** A JSON payload is trimmed by dropping whole entries off the end
 *    of its longest list, so what arrives still parses and says how many entries were dropped. Only
 *    plain text is cut by characters, and then it carries a marker.
 * 3. **Every requested entry gets a share, and an outsized entry is shrunk before any entry is
 *    dropped.** Rule 2 alone assumed entries are of similar size, and on 2026-08-12 they were not: a
 *    `get_process_details` for three codes came back 4,965 + 3,101 + **37,169** characters, because the
 *    third dataset carries 90 exchanges. One drop from the end took the answer from 108 % of budget to
 *    about 20 % — roughly 33,800 characters of budget left unspent — and what vanished was the one
 *    dataset the caller had asked about, whose sign it then never checked. Dropping the tail is right
 *    only when nothing smaller will do; trimming the giant's own exchange list keeps all three codes.
 */

/** One result, one item: unchanged from before, so a single call behaves exactly as it always did. */
export const RESULT_BASE_CHARS = 30_000
/**
 * Every additional batch item earns this much more.
 *
 * Was 6 000 until 10.09.2026, with the note "a per-query search hit list is a few thousand". It
 * no longer is: measured on the real hit projection, one query of sixteen hits serialises to
 * 10 400-19 600 characters depending on how many of them are markets carrying their supplier mix.
 * Every query in a batch was therefore underfunded by roughly 8 000 characters, and the gap grew
 * with every additional one — which is why a ten-query search lost most of its answer however much
 * payload was trimmed. This buys results that were being thrown away; the hard ceiling and the
 * share of the conversation below are untouched, so it cannot run away.
 */
export const RESULT_PER_ITEM_CHARS = 15_000
/**
 * Hard ceiling, for technical reasons rather than editorial ones: ~120k characters is ~30–35k tokens,
 * already a third of a 100k context and more than the models here allow themselves for output. A tool
 * result bigger than this does not help the model, it displaces it.
 */
export const RESULT_HARD_MAX_CHARS = 120_000
/**
 * Largest share of the CONVERSATION's character budget a single tool result may take.
 *
 * The scaling above knows how many items were asked for and nothing else, which is how the
 * 2026-08-13 solar-lamp run got a legitimate 72,313-character answer to one 8-query search: 30,000 +
 * 6,000 × 7 = 72,000, the biggest single result of that run. Nothing was broken — the formula simply
 * had no idea what it was spending. A batch may still earn more room than a single call, but not more
 * than this fraction of the room that exists.
 *
 * **The first attempt tied it to the wrong quantity, and that cost a run more than the problem it
 * solved.** It used `maxTokens`, which is the `max_tokens` of the request — Settings calls it "Max
 * tokens per reply" and means exactly that: how long the model's OWN ANSWER may be. A tool result is
 * not an answer, it is prompt. Tied to a 50,000-token reply limit the ceiling came out at 35,000
 * characters, BELOW the base-plus-scaling of every batch of two or more, and the 2026-08-13 apple-
 * sauce run lost to it: one of three requested skills ("End-of-life & what-if scenarios") thrown
 * away whole, one of four ANSWERED research questions thrown away whole (the glass recycling rate,
 * which is why that study's one unsourced figure is unsourced), and 7 of 12, 5 of 14 and 5 of 8
 * search hits. Meanwhile the model that lost them reads a million tokens of context.
 *
 * The quantity that decides how much a result may cost is the conversation's own character budget —
 * the same figure `compactThreshold` derives from the model's context window and already uses to
 * decide when history must shrink. A result competing for that room is the real constraint; a result
 * competing with the length of the reply is not a relationship at all.
 */
export const RESULT_MAX_SHARE_OF_CONTEXT = 0.2

/** Container keys whose arrays are the payload, checked before falling back to any array. */
const LIST_KEYS = [
  'results',
  'skills',
  'hits',
  'items',
  'activities',
  'methods',
  'flows',
  'exchanges',
  'findings',
  'parameters',
  'scenarios'
]

export interface CappedResult {
  text: string
  /**
   * Present only when something was removed.
   *
   * `within_entries` = every requested entry survived and the oversized ones gave up part of their own
   * longest list; `entries` = whole entries were dropped from the end, the last resort; `characters` =
   * plain text, cut and marked.
   */
  truncated?: { kind: 'entries' | 'within_entries' | 'characters'; dropped: number; of?: number }
}

/** How many items a result represents — a batch says so itself via `total`. */
export function itemCount(parsed: unknown): number {
  if (!parsed || typeof parsed !== 'object') return 1
  const o = parsed as Record<string, unknown>
  if (typeof o.total === 'number' && Array.isArray(o.results)) return Math.max(1, o.total)
  for (const key of LIST_KEYS) {
    if (Array.isArray(o[key])) return Math.max(1, (o[key] as unknown[]).length)
  }
  return 1
}

/**
 * The character budget for a result that carries `items` answers.
 *
 * `conversationChars` is how many characters of conversation this model may hold before the history
 * has to be compacted (`compactThreshold` in agent.ts, derived from the context window). A single
 * call keeps its base budget whatever happens — the point is to stop a WIDE batch from crowding out
 * the conversation it is part of, not to shrink an ordinary answer on a small-context model.
 */
export function resultBudget(items: number, conversationChars?: number): number {
  const scaled = RESULT_BASE_CHARS + RESULT_PER_ITEM_CHARS * Math.max(0, items - 1)
  const ceilings = [RESULT_HARD_MAX_CHARS]
  if (Number.isFinite(Number(conversationChars)) && Number(conversationChars) > 0)
    ceilings.push(Math.max(RESULT_BASE_CHARS, Number(conversationChars) * RESULT_MAX_SHARE_OF_CONTEXT))
  return Math.min(scaled, ...ceilings)
}

/** The longest array in the payload, preferring the known container keys. Returns null if none. */
function longestList(o: Record<string, unknown>): { key: string; list: unknown[] } | null {
  let best: { key: string; list: unknown[] } | null = null
  for (const key of LIST_KEYS) {
    const v = o[key]
    if (Array.isArray(v) && v.length > 1 && (!best || v.length > best.list.length)) {
      best = { key, list: v }
    }
  }
  if (best) return best
  for (const [key, v] of Object.entries(o)) {
    if (Array.isArray(v) && v.length > 1 && (!best || v.length > best.list.length)) {
      best = { key, list: v }
    }
  }
  return best
}

/**
 * The longest array within two levels of an entry, as the PATH to it — what an oversized entry can
 * give up. A path rather than a reference so the entry can be rebuilt without mutating the original.
 * Two levels because batch items wrap their payload: `{i, ok, result: {exchanges: [...]}}`.
 */
function innerListPath(entry: unknown): { path: string[]; list: unknown[] } | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  let best: { path: string[]; list: unknown[] } | null = null
  const consider = (holder: Record<string, unknown>, prefix: string[]): void => {
    for (const [key, v] of Object.entries(holder)) {
      if (Array.isArray(v) && v.length > 1 && (!best || v.length > best.list.length)) {
        best = { path: [...prefix, key], list: v }
      }
    }
  }
  const top = entry as Record<string, unknown>
  consider(top, [])
  for (const [key, v] of Object.entries(top)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) consider(v as Record<string, unknown>, [key])
  }
  return best
}

/** A copy of `entry` with the array at `path` replaced and a `truncated` note beside it. */
function withShorterList(
  entry: unknown,
  path: string[],
  kept: unknown[],
  full: number
): Record<string, unknown> {
  const note = {
    dropped_entries: full - kept.length,
    of: full,
    field: path[path.length - 1],
    note:
      `The last ${full - kept.length} of ${full} "${path[path.length - 1]}" were dropped to fit this ` +
      "entry's share of the result budget. Every other field is unchanged — but any count or " +
      'summary it carries describes the FULL list, not the part you can see here. Ask for this one ' +
      'on its own if you need the rest.'
  }
  const clone = (node: Record<string, unknown>, depth: number): Record<string, unknown> => {
    const key = path[depth]
    if (depth === path.length - 1) return { ...node, [key]: kept, truncated: note }
    return { ...node, [key]: clone(node[key] as Record<string, unknown>, depth + 1) }
  }
  return clone(entry as Record<string, unknown>, 0)
}

/**
 * Fit the payload by giving each entry an equal share and shrinking the ones that overrun it.
 *
 * Returns null when this cannot bring the result under budget — then the caller falls back to dropping
 * whole entries, which is the older and blunter rule.
 */
function shareOut(
  o: Record<string, unknown>,
  found: { key: string; list: unknown[] },
  budget: number
): CappedResult | null {
  const n = found.list.length
  if (n < 2) return null
  // What the wrapper costs, so the shares are of what is actually left for the entries.
  const overhead = JSON.stringify({ ...o, [found.key]: [] }).length + 400
  const available = budget - overhead
  if (available / n < 500) return null // too many entries for this to mean anything — drop instead

  // Max-min fair allocation, not an equal split: an entry that needs less than its share hands the
  // difference back, and the surplus is shared out among the ones that overran. With three entries of
  // 5k, 3k and 37k against a 42k budget an equal split would cap the big one at 14k and leave 11k of
  // the small ones' share unspent — the very waste this function exists to stop.
  const sizes = found.list.map((e) => JSON.stringify(e).length)
  let share = Math.floor(available / n)
  for (let pass = 0; pass < 8; pass++) {
    const under = sizes.filter((s) => s <= share)
    if (!under.length || under.length === n) break
    const next = Math.floor((available - under.reduce((a, b) => a + b, 0)) / (n - under.length))
    if (next <= share) break
    share = next
  }

  let shrunkCount = 0
  const out = found.list.map((entry, i) => {
    if (sizes[i] <= share) return entry
    const inner = innerListPath(entry)
    if (!inner) return entry // nothing to give up; the fallback may drop it
    const full = inner.list.length
    // Halving rather than one-by-one: an entry with 90 exchanges would otherwise be serialised 80
    // times to find its size, and unlike the outer list these can be long.
    let keep = full - 1
    let best: Record<string, unknown> | null = null
    let lo = 1
    let hi = full - 1
    while (lo <= hi) {
      keep = Math.floor((lo + hi) / 2)
      const candidate = withShorterList(entry, inner.path, inner.list.slice(0, keep), full)
      if (JSON.stringify(candidate).length <= share) {
        best = candidate
        lo = keep + 1
      } else {
        hi = keep - 1
      }
    }
    if (!best) return entry
    shrunkCount++
    return best
  })

  const text = JSON.stringify({ ...o, [found.key]: out })
  if (text.length > budget) return null
  if (!shrunkCount) return { text }
  return { text, truncated: { kind: 'within_entries', dropped: shrunkCount, of: n } }
}

/**
 * Fit a tool result into its budget, structurally where possible.
 *
 * The budget is derived from the payload itself, so a caller does not have to know whether a given
 * tool batched this time — the batch says how many items it carries.
 */
/**
 * What to call an entry that had to be dropped, so the caller can ask for THAT one again.
 *
 * "The last 1 of 4 entries were dropped" is a fact the model can do nothing with. On the 2026-08-13
 * apple-sauce run a `research_web` answer lost exactly one entry: the model read the note, could not
 * tell which of its four questions had gone, judged a fresh multi-minute research leg too expensive
 * for a guess, and shipped the gap — its study's only unsourced figure. The label costs one string.
 *
 * Two levels, because a batch wraps its payload: `{i, ok, result: {question, findings}}`.
 */
function entryLabel(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') return null
  const KEYS = ['question', 'name', 'query', 'title', 'code']
  const pick = (o: Record<string, unknown>): string | null => {
    for (const k of KEYS) if (typeof o[k] === 'string' && o[k]) return String(o[k]).slice(0, 200)
    return null
  }
  const top = entry as Record<string, unknown>
  const own = pick(top)
  if (own) return own
  const inner = top.result
  if (inner && typeof inner === 'object' && !Array.isArray(inner))
    return pick(inner as Record<string, unknown>)
  return null
}

export function capToolResult(
  text: string,
  budgetOverride?: number,
  conversationChars?: number
): CappedResult {
  // Cheap exit: the overwhelming majority of results are nowhere near the limit, and parsing a
  // 30k-character payload to discover that would be pure waste.
  if (text.length <= RESULT_BASE_CHARS && budgetOverride == null) return { text }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const budget = budgetOverride ?? resultBudget(itemCount(parsed), conversationChars)
  if (text.length <= budget) return { text }

  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>
    const found = longestList(o)
    if (found) {
      const full = found.list.length

      // First: give every entry a share and make the oversized ones give up their own longest list.
      // Only entries that HAVE something list-shaped inside can pay this way — a skill whose payload
      // is one long string cannot, and falls through to the drop below, which is right for it: half a
      // skill is not half as useful, it is misleading.
      const shrunk = shareOut(o, found, budget)
      if (shrunk) return shrunk

      let list = found.list.slice()
      // Drop from the end until it fits. Halving would be faster; entry-by-entry keeps as much as
      // possible, and these lists are tens of entries, not thousands.
      while (list.length > 1) {
        list = list.slice(0, -1)
        const dropped = found.list.slice(list.length).map(entryLabel).filter(Boolean) as string[]
        const candidate = {
          ...o,
          [found.key]: list,
          truncated: {
            dropped_entries: full - list.length,
            of: full,
            // Named where the entries carry a name at all: "one of your four questions is gone" is
            // actionable, "one entry is gone" is not. See entryLabel for what that cost once.
            ...(dropped.length === full - list.length ? { dropped } : {}),
            note:
              `The last ${full - list.length} of ${full} entries were dropped to fit the result ` +
              'budget. Nothing else was changed. Ask again for the missing ones specifically (a ' +
              'narrower query, or fewer items per call) rather than assuming they were empty.' +
              (dropped.length === full - list.length
                ? ` What was dropped, in order: ${dropped.join('; ')}.`
                : '')
          }
        }
        const out = JSON.stringify(candidate)
        if (out.length <= budget) {
          return { text: out, truncated: { kind: 'entries', dropped: full - list.length, of: full } }
        }
      }
    }
  }

  // Plain text, or a payload with nothing list-shaped to trim. Cut by characters, and SAY it — a
  // skill whose instructions stop mid-sentence otherwise looks like a skill that ends there.
  const marker =
    `\n\n[TRUNCATED: ${text.length - budget} of ${text.length} characters were cut to fit the ` +
    'result budget. This text is INCOMPLETE — request the rest specifically (e.g. one item per call) ' +
    'instead of acting as though it ended here.]'
  const keep = Math.max(0, budget - marker.length)
  return {
    text: text.slice(0, keep) + marker,
    truncated: { kind: 'characters', dropped: text.length - keep, of: text.length }
  }
}
