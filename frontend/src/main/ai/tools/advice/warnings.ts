// Honesty signals attached to search answers, and per-run repeat/noise suppression.
import type { ToolCtx } from '../context'

/**
 * Note on a background search that this run has already asked the same words (V112).
 *
 * Only the exact same content words, and only when there are any: `market for tap water` reduces to
 * an empty signature, and treating two empty signatures as "the same search" would fire on every
 * generic query in the run. Geography is part of the key because DE and RER genuinely return
 * different datasets.
 *
 * Says nothing about the database — a search that returns nothing useful twice may still be the
 * wrong query. What it can say truthfully is that *this* query has been answered already, which is
 * the fact the model needed and did not have: a real apple-sauce run asked for "apple juice"
 * and "tinplate" six times each, in five different calls, and spent three rounds on it.
 *
 * The compound case was already covered and is deliberately left alone: `split_match_warning` fired
 * on all three "apple juice" searches of that run, with the right words ("Check whether the
 * combination exists at all"). It was read past. A sixth signal saying the same thing would be read
 * past too; a statement about the run's own history is a different kind of fact.
 */
/**
 * `record: false` looks the query up WITHOUT filing it — for a query that travels in a batch.
 *
 * The warning means "you asked this, you saw the answer, and you asked again". Inside one batched
 * call nothing has been seen yet: the queries go out together, `Promise.all` returns them in
 * whatever order they finish, and the first to land was filing its key while its siblings were
 * still in flight. So a legitimate sibling was told it was a repeat — of a query the model had not
 * yet read, sent in the same breath (V276). The batch therefore checks every
 * query against what came BEFORE it, and files them all afterwards.
 */
/**
 * Keep the dimension_check boilerplate sentence to ONE appearance per run (V282).
 *
 * The data fields stay on every answer — `amount_must_be_in` and `parameter_units` differ per
 * formula and are the point of the check. The `note` explaining that units are labels is the same
 * sentence every time; in one run it rode along verbatim on 13 of 75 answers, and the
 * model's own critique called it attention noise. The first note of a run survives (a batch of
 * eight formulas keeps one), everything after is stripped at the serialized level — the sentence
 * contains no quotes and always ends the object, so the JSON stays valid.
 */
export function trimUnitNotes(serialized: string, ctx: ToolCtx): string {
  if (!serialized.includes('"dimension_check"')) return serialized
  const NOTE_RE = /,"note":"The amount is in [^"]*exchange comment\."/g
  const keep = ctx.unitNoteSaid ? -1 : 0
  let seen = 0
  const out = serialized.replace(NOTE_RE, (m) => (seen++ === keep ? m : ''))
  if (seen > 0) ctx.unitNoteSaid = true
  return out
}

/** Where a search looked and what it looked for beyond the words — part of "the same search". */
export interface SearchScope {
  databases?: string[]
  types?: string[]
  /** Searched as typed, without the spelled-out abbreviation. A literal retry is the way out of a
   *  wrong reading ("pet food" → polyethylene terephthalate) and must not be told it is a repeat. */
  literal?: boolean
}

export function alreadyAsked(
  result: any,
  geo: unknown,
  ctx: ToolCtx,
  record = true,
  scope: SearchScope = {}
): any {
  const terms: unknown = result?.content_terms
  if (!ctx.searched || !Array.isArray(terms) || !terms.length) return result
  // Databases and activity types are part of the question: "steel" in ecoinvent and "steel" in the
  // library are two searches, and the second was told it was repeating itself.
  const key =
    `${[...terms].sort().join(' ')}|${Array.isArray(geo) ? [...geo].sort().join(',') : ''}` +
    `|${[...(scope.databases ?? [])].sort().join(',')}|${[...(scope.types ?? [])].sort().join(',')}` +
    (scope.literal ? '|literal' : '')
  const before = ctx.searched.get(key)
  if (!before) {
    if (record) ctx.searched.set(key, { query: String(result.query ?? ''), hits: Number(result.count ?? 0) })
    return result
  }
  return {
    ...result,
    already_searched: {
      earlier_query: before.query,
      earlier_results: before.hits,
      note:
        `You already searched these words in this chat ("${before.query}", ${before.hits} results) ` +
        'and the database has not changed since. Repeating a search cannot make a dataset appear. ' +
        'If none of the results is the material, that is the answer: pick the closest proxy, write ' +
        'why it stands in into the exchange comment, and record the gap as a limitation.'
    }
  }
}

/**
 * One `warnings` list at the TOP of a search answer, repeating every honesty signal the answer
 * carries in words.
 *
 * Not a new signal — a consolidation. The signals grew one at a time (weak_match, unmatched_terms,
 * terms_not_in_results/proxy_warning, best_match_words/split_match_warning, already_searched, the
 * research-question hint), each added because the previous one did not cover a measured failure, and
 * each a separately named field somewhere in a JSON object. Measured on a real apple-sauce
 * run: `split_match_warning` fired on all three "apple juice" searches, with the right words, and was
 * read past all three times — six queries and three rounds went into a material the first answer had
 * already flagged. Individually named fields get skimmed; one block in a fixed place, first key in
 * the object, is the salience fix. The fields themselves stay untouched — they are the source of
 * truth, and existing readers (tests, the renderer) keep working.
 */
export function withSearchWarnings(result: any): any {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result
  const w: string[] = []
  if (result.weak_match === true)
    w.push(
      'Nothing in this list truly resembles the query — treat every hit as a non-match, not as a ' +
        'weak candidate.'
    )
  if (Array.isArray(result.unmatched_terms) && result.unmatched_terms.length)
    w.push(
      `No hit carries the specifier(s) ${result.unmatched_terms.map((t: unknown) => `'${t}'`).join(', ')} — ` +
        'the exact variant may not exist here. Do not accept a neighbouring variant (EURO 5 for ' +
        'EURO 6) without saying so.'
    )
  if (typeof result.proxy_warning === 'string' && result.proxy_warning) w.push(result.proxy_warning)
  if (typeof result.split_match_warning === 'string' && result.split_match_warning)
    w.push(result.split_match_warning)
  // The hard geography filter hid a dataset named exactly like the query (V333): the one signal that
  // says the thing IS in here, one region over.
  if (typeof result.outside_geography_filter === 'string' && result.outside_geography_filter)
    w.push(result.outside_geography_filter)
  if (typeof result.already_searched?.note === 'string' && result.already_searched.note)
    w.push(result.already_searched.note)
  if (typeof result.hint === 'string' && result.hint) w.push(result.hint)
  // Insertion order puts `warnings` first in the serialised object — that placement is the point.
  return w.length ? { warnings: w, ...result } : result
}
