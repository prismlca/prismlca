/**
 * A review that came back without a result: what `review_model` answers, and that it does not send the same
 * model to the same reviewer twice in one chat.
 *
 * A reviewer that thinks past its deadline does so again on the same dossier. In one run a slow reasoner
 * timed out on both attempts (600 s and 360 s), the tool said to continue without it, and the assistant
 * called it again at once: the same sixteen minutes, again nothing — half of the run's hour. So a timeout or
 * an empty answer is remembered for the chat and the model, with a fingerprint of the model's processes and
 * exchanges and the reviewer it went to. Until one of the two changes, the next call answers at once with
 * that outcome instead of waiting again.
 *
 * The fingerprint covers the inventory — what the reviewer judges — and nothing else. A study field written
 * afterwards (the honest critical-review sentence this answer asks for) does not make a slow reviewer faster,
 * and an edit in another model is no reason at all. A request that failed outright (`error`) is not
 * remembered: a provider that could not be reached may be back a minute later. Memory only: after a restart
 * the app tries again.
 */
import { createHash } from 'node:crypto'
import type { ToolCtx } from '../context'

type Review = Awaited<ReturnType<NonNullable<ToolCtx['review']>>>

/** What `critical_review` says when there was no critical review — the sentence the health check gives too
 *  (backend `health_study.NO_CRITICAL_REVIEW`; a test holds the two together). */
export const NO_CRITICAL_REVIEW = 'No critical review according to ISO 14044 §7.3.3 was carried out.'

/** The half every failed review says: nothing was judged, and where that leaves the study fields. A model
 *  once wrote "an internal AI second opinion was obtained" into critical_review after both attempts had
 *  timed out — against the note it had just been given. The sentence is offered only for a field without a
 *  review by experts: told plainly "the honest entry is …", a test model overwrote a named review panel. */
const NOT_REVIEWED =
  'Nothing was judged, so do not present the study as reviewed — not in your answer and not in any study ' +
  'field. This attempt does not belong in model_info critical_review: leave that field as it is if it ' +
  'names a critical review by independent experts; if it is empty or mentions this attempt, the honest ' +
  `entry is "${NO_CRITICAL_REVIEW}"`

const SAME_ANSWER = 'Calling review_model again on this model as it stands gives this same answer.'

/** One remembered review without a result. */
interface FailedReview {
  /** Fingerprint of the model's processes and exchanges the reviewer was given. */
  model: string
  /** The reviewer model it went to. */
  reviewer: string
  outcome: 'timeout' | 'empty'
  /** What the tool answered then — repeated when it is asked again. */
  detail: string
}

/** Enough for every chat of a long session; the oldest goes first. */
const MAX_REMEMBERED = 50
const failed = new Map<string, FailedReview>()
const keyOf = (chatId: string, db: string): string => `${chatId}\u0000${db}`

/** The model as the reviewer judges it, as one value: equal when no process, exchange, amount, formula or
 *  comment has changed. The listing is sorted by the backend, so the same model gives the same value. */
export function modelFingerprint(activities: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(activities ?? null))
    .digest('hex')
}

/** Where a review is asked for: which chat, which model and its fingerprint (null when the processes could
 *  not be read — then nothing is held back), and which reviewer. */
export interface ReviewSubject {
  chatId?: string
  db: string
  model: string | null
  reviewer: string
}

/** The answer to a call this chat already made on the same model with the same reviewer, when that one
 *  came back without a result — or null, and the reviewer runs. */
export function notRunAgain(s: ReviewSubject): Record<string, unknown> | null {
  if (!s.chatId || !s.model) return null
  const earlier = failed.get(keyOf(s.chatId, s.db))
  if (!earlier || earlier.model !== s.model || earlier.reviewer !== s.reviewer) return null
  return {
    database: s.db,
    review: null,
    review_failed: earlier.outcome,
    not_run_again: true,
    detail:
      'Not run again: the review of this model in this chat already came back without a result, and ' +
      `neither the model nor the review model has changed since. ${earlier.detail}`,
    note:
      `Continue without a review and tell the user that none could be done. ${NOT_REVIEWED} The user can ` +
      'choose another review model under Settings → AI → Models; with it, or once the model has changed, ' +
      'review_model runs again. Do not change the model only to get a review.'
  }
}

/** Keeps a review without a result for the next call; false when there is nothing to key it on (no chat, or
 *  processes that could not be read). */
function remember(s: ReviewSubject, outcome: FailedReview['outcome'], detail: string): boolean {
  if (!s.chatId || !s.model) return false
  const key = keyOf(s.chatId, s.db)
  failed.delete(key) // re-inserted last, so the oldest entry is the first to go
  failed.set(key, { model: s.model, reviewer: s.reviewer, outcome, detail })
  for (const old of failed.keys()) {
    if (failed.size <= MAX_REMEMBERED) break
    failed.delete(old)
  }
  return true
}

/** A review with a result: whatever failed before on this model is forgotten. */
export function reviewSucceeded(s: ReviewSubject): void {
  if (s.chatId) failed.delete(keyOf(s.chatId, s.db))
}

/**
 * The answer to a review without a result. Not a clean bill of health: this branch once returned the single
 * sentence "The reviewer returned nothing.", the model read it as "no findings" and shipped the study
 * unreviewed. So it says which failure it was, that the model system has NOT been reviewed, and — for a
 * timeout or an empty answer — remembers it, so the same model is not sent to the same reviewer again.
 */
export function reviewFailed(s: ReviewSubject, gaps: string[], review: Review): Record<string, unknown> {
  const stats =
    `${Math.round(review.ms / 1000)} s, ${Math.round(review.reasoning_chars / 1000)}k characters of ` +
    `reasoning, finish_reason=${review.finish_reason ?? 'not stated'}`
  const base = { database: s.db, gaps, review: null, review_failed: review.outcome }
  if (review.outcome === 'error')
    return {
      ...base,
      detail: `The reviewer could not be reached (${review.error ?? 'stream failed'}).`,
      note:
        'This is a FAILED review, not a clean one: the reviewer was never reached. Call review_model ' +
        `again later, or continue without it and tell the user. ${NOT_REVIEWED}`
    }
  const timedOut = review.outcome === 'timeout'
  const detail = timedOut
    ? `The reviewer wrote nothing before its deadline in ${review.attempts} attempts (${stats}).`
    : `The reviewer produced no text in ${review.attempts} attempts (${stats}).`
  const remembered = remember(s, timedOut ? 'timeout' : 'empty', detail)
  return {
    ...base,
    detail,
    note:
      (timedOut
        ? 'The review timed out — continue without it and tell the user. '
        : 'This is a FAILED review, not a clean one: no conclusion about the model may be drawn from it. ' +
          'Continue without it and tell the user. ') +
      NOT_REVIEWED +
      (remembered ? ` ${SAME_ANSWER}` : '')
  }
}
