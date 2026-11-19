/**
 * What the model's review log holds, told to the assistant at the moment it writes the study fields a review
 * claim goes into: `critical_review` and the limitations.
 *
 * Prose can claim a review that never ran. One assistant wrote "an internal AI second opinion was obtained"
 * into `critical_review` after both attempts of its review had timed out; another declared an "automated
 * model review" it had never called. Reading that prose afterwards for review words cannot tell the
 * assistant's reviewer from a review by people — "internal review by our LCA team" is a critical review under
 * ISO 14044 — and a finding raised from it could only be cleared by running an AI review, which a test model
 * then did. So nothing here judges the sentence. It states the one fact on record, beside the write that
 * may contradict it, and leaves the judging to the writer, who knows whose review the text means.
 *
 * Shared by the chat and the MCP server (both run `model_info`), so it names the reviewer, not the chat's
 * `review_model` tool, which an MCP client does not have.
 */
import type { ToolCtx } from '../context'

/** Said when the log is empty. Empty says "not recorded", never "did not happen": recording a finished review
 *  is best-effort (review.ts), and a log that cannot be read comes back empty too (`ReviewLogStore.ON_ERROR`).
 *  So the claim is left to what the writer saw. The last sentence is there because a fact like this reads as a
 *  gap to close: told only that no review was recorded, a test model ran one. */
const NONE =
  "No review by PrismLCA's AI reviewer is recorded for this model. If the text you just wrote says such a " +
  'review was obtained or carried out, nothing on record confirms it: keep it only if you saw that review ' +
  'return a result — one that timed out or failed was not carried out. A review by people, or by a tool ' +
  'outside PrismLCA, is never in this log — text that names one stays as it is. This is a fact for that ' +
  'text, not a request to run a review.'

/** The field rule, said only when `critical_review` was written: the same as its description says. */
const NOT_CRITICAL =
  ' An AI review is a second opinion, not a critical review under ISO 14044, and is not mentioned in ' +
  'critical_review.'

/**
 * The sentence for the answer of a `model_info` write, or undefined when the log cannot be read — the fact is
 * an aid to the writer, and a log that does not answer must never cost the write that already happened.
 */
export async function reviewLogFact(
  ctx: ToolCtx,
  db: string,
  criticalReviewWritten: boolean
): Promise<string | undefined> {
  let reviews: unknown
  try {
    reviews = await ctx.api('GET', `/api/v1/provenance/review?database=${encodeURIComponent(db)}`)
  } catch {
    return undefined
  }
  if (!Array.isArray(reviews)) return undefined
  if (!reviews.length) return NONE
  const latest = (reviews[reviews.length - 1] ?? {}) as { created?: unknown; partial?: unknown }
  const day = typeof latest.created === 'string' ? latest.created.slice(0, 10) : ''
  const n = reviews.length
  return (
    `PrismLCA's AI reviewer has ${n} review${n === 1 ? '' : 's'} on record for this model` +
    (day ? `, the latest from ${day}` : '') +
    (latest.partial ? ' (cut short at its deadline, so it judged only part of the model)' : '') +
    '.' +
    (criticalReviewWritten ? NOT_CRITICAL : '')
  )
}
