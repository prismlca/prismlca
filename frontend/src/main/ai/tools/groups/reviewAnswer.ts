/**
 * What `review_model` tells the assistant beside the review itself: which model reviewed and whether
 * that was the assistant's own, what to do next, and — after outcomes are recorded — which of the
 * review's findings still have none.
 *
 * The reviewer is often the chat model itself (chosen in Settings, or the provider's default). The
 * assistant was not told, the skill promised "a DIFFERENT model", and closing answers called a model's
 * check of its own work an "independent reviewer" and a "second AI assessment".
 */

/** Who reviewed, for the answer: the reviewer's id, and whether it is the model the chat runs on. */
export interface ReviewerIdentity {
  reviewer?: string
  /** Absent when the chat model is not known (then nothing is claimed either way). */
  self_review?: boolean
}

export function reviewerIdentity(
  reviewer: string | undefined,
  chatModel: string | undefined
): ReviewerIdentity {
  if (!reviewer) return {}
  return chatModel ? { reviewer, self_review: reviewer === chatModel } : { reviewer }
}

/** The note on a finished review. */
export function afterReviewNote(who: ReviewerIdentity): string {
  const kind =
    who.self_review === true
      ? `The reviewer was ${who.reviewer}, the model you run on: this was your own model checking its own ` +
        "work in a fresh context — a self-review, not an independent review and not a second model's " +
        'opinion, so call it that wherever you mention it. Nor is it a critical review in the ISO 14044 sense'
      : who.self_review === false
        ? `This is a second opinion from another AI model (${who.reviewer}), not a critical review in the ` +
          'ISO 14044 sense'
        : 'This is a second opinion from an AI reviewer, not a critical review in the ISO 14044 sense'
  return (
    'When a finding makes you change the inventory, a formula or the cut-off: re-read the ' +
    'process comments and study fields that describe the old state and bring them up to date ' +
    '— prose written before a fix otherwise contradicts the model it describes. Afterwards, ' +
    'record each finding\'s outcome by calling review_model again with "resolutions" ' +
    '([{id, finding, resolution: fixed|rejected|open, reason}], id as the review tagged the finding: F1, F2, …); ' +
    'the report prints the open ones. After a structural change (new phase, swapped dataset that carries ' +
    'the result, changed allocation) run the review again — it sees its previous findings. ' +
    `${kind}: it does not go into critical_review.`
  )
}

/** The backend's answer to recorded resolutions (ReviewLogStore.record_resolutions). */
interface RecordedOutcomes {
  findings?: number
  no_outcome_yet?: Array<{ id: string; finding: string }>
  without_id?: number
  unknown_ids?: string[]
  tagged?: boolean
  [k: string]: unknown
}

/** The answer to a resolutions call: the backend's counts and lists, with what they mean said once. */
export function outcomesAnswer(r: RecordedOutcomes): RecordedOutcomes & { note?: string } {
  if (!r || typeof r !== 'object' || 'error' in r) return r
  const notes: string[] = []
  if (r.tagged === false)
    notes.push(
      'The review did not tag its findings with ids, so which of them still have no outcome cannot be ' +
        'listed — compare your resolutions against the review text yourself.'
    )
  const missing = r.no_outcome_yet ?? []
  if (missing.length)
    notes.push(
      `${missing.length} of the review's ${r.findings ?? '?'} findings have no recorded outcome yet ` +
        '(no_outcome_yet). Record one for each — fixed, rejected with the reason, or open — or name them ' +
        'to the user as unanswered; do not report the review as settled while any is listed.'
    )
  if (missing.length && r.without_id)
    notes.push(
      `${r.without_id} of your recorded outcomes name no id; if one of them answers a finding listed ` +
        'there, record it again with that id and the same finding text — it then replaces the entry ' +
        'without one.'
    )
  if (r.unknown_ids?.length)
    notes.push(`The review has no finding ${r.unknown_ids.join(', ')}: check those ids against the review.`)
  return notes.length ? { ...r, note: notes.join(' ') } : r
}
