/**
 * What a re-review is told about the review before it: the latest review THIS chat ran on the model,
 * its findings, the outcome the assistant recorded for each (fixed / rejected / open), and whether the
 * model has been edited since — the PREVIOUS REVIEW section of the dossier.
 *
 * Without it a second review starts from zero: in one run three reviews in a row opened with the same
 * finding, because the reviewer could not know it had raised it before, and nothing told it to check
 * that the points reported as fixed really were. Only the same chat's review counts: in another chat,
 * "rejected, because …" was never part of the conversation, and a reviewer anchored on an older
 * stranger's findings argues points nobody here raised.
 */
import { capText } from '../format'

/** One entry of the model's review log as GET /provenance/review returns it. */
export interface LoggedReview {
  id?: string
  review?: string
  /** The chat that ran it; absent on reviews logged before the log kept it. */
  chat?: string
  /** Something was edited after the review — this model or another, the backend's counter is shared;
   *  null or absent = not known (an earlier backend session). */
  stale?: boolean | null
  /** The reviewer was stopped at its deadline: findings it had not reached are missing. */
  partial?: boolean
  resolutions?: Array<{ finding?: string; resolution?: string; reason?: string }>
}

/** The latest review in the log that this chat ran, or null — also for a log that is not a list. */
export function previousReviewOf(log: unknown, chatId: string | undefined): LoggedReview | null {
  if (!chatId || !Array.isArray(log)) return null
  for (let i = log.length - 1; i >= 0; i--) {
    const r = log[i] as LoggedReview | null
    if (r && r.chat === chatId && typeof r.review === 'string' && r.review.trim()) return r
  }
  return null
}

/** The dossier section: the earlier findings, their recorded outcomes, and how to treat them. */
export function previousReviewSection(r: LoggedReview): string {
  const changed =
    r.stale === true
      ? ' Edits have been made since (to this model or another one).'
      : r.stale === false
        ? ' Nothing has been edited since.'
        : ''
  const cut = r.partial ? ' It was cut off at its deadline, so findings it had not reached are missing.' : ''
  const outcomes = (r.resolutions ?? [])
    .filter((x) => x && typeof x.finding === 'string' && x.finding.trim())
    .map((x) => `- ${x.resolution ?? 'open'}: ${x.finding}${x.reason ? ` — ${x.reason}` : ''}`)
  return [
    `PREVIOUS REVIEW (run earlier in this chat on this model).${changed}${cut} Its findings:`,
    capText(String(r.review ?? '').trim(), 6_000),
    outcomes.length
      ? `The assistant's recorded outcome per finding:\n${capText(outcomes.join('\n'), 4_000)}`
      : 'No outcome was recorded for any of its findings.',
    'Check each finding recorded as "fixed" against the dossier above and say so if it is not fixed. ' +
      'Raise a "rejected" finding again only with evidence its reason does not answer, and quote that evidence.'
  ].join('\n')
}
