/** What changed under a written chapter, as the staleness check reports it, and what the panel says
 * about it: the failed-check notice, the pending-approval count the export asks about, the check's progress.
 *
 * The repair offers that used to live here (Correct…, Accept as it is, the correction-round verdicts)
 * went with the correction dialog: "Update report" brings a chapter up to date now (lib/report/plan.ts).
 */
import { errMsg } from '../errors'

/**
 * What changed under a written chapter (engine/report_staleness). `remedy` is the most expensive
 * thing any finding asks for, and it is what the badge and "Write all" act on.
 */
/** Where a typed number stands: its sentence as printed, its place in it, and which of several identical
 *  sentences (engine/report_typed_numbers). */
export interface TypedPlace {
  quote: string
  offset?: number
  occurrence?: number
}

export interface StaleChapter {
  section_id: string
  remedy: 'none' | 'review' | 'rewrite'
  /** `path` is present on the findings that name one — a rank, a band, a member that has gone. */
  findings: { kind: string; severity: string; message: string; path?: string; points?: TypedPlace[] }[]
  /** Bindings whose member was only renamed — repairable for nothing, without touching a word. */
  rebindable: number
  reviewed_at?: string | null
  changed_since_reviewed?: boolean
  reviewed_text?: string | null
  /** The author's release of a model-written chapter, while it holds: `pending` until they release it,
   *  and again once the wording or the numbers under it move. `null` for a chapter no model wrote. */
  review?: 'released' | 'pending' | null
  /** Why it is pending: never released, wording changed, figures moved, or the check has findings (V396). */
  review_reason?: 'never' | 'text' | 'values' | 'findings' | null
}

/** A thrown thing as a sentence, and never an empty one — an unsaid reason reads as no reason. */
export const failureText = (e: unknown): string => errMsg(e).trim() || 'The request failed without a message.'

/**
 * The three answers a staleness check can leave behind — and which of them the page has to say aloud.
 *
 * Two speak for themselves: a check that found nothing leaves the badges empty, a check that found
 * something puts them on the rows. The third one had no way of appearing at all. `loadStaleness` knew
 * the difference and returned `null` for it, but it set the *displayed* map to `{}` — and `{}` draws
 * exactly like "nothing is out of date". So a report over a model the backend refused to compute read
 * "Every chapter written", in green, with no counter and no warning (V200, PVC run: a deleted parameter
 * left an applied scenario's overrides in place and every calculation answered 400).
 *
 * Silent when there was nothing to compare, because that is the case the swallowing was built for and
 * it is a real one: a report with no chapter written yet cannot be checked, and an error over it would
 * fire on every freshly created report. The question is therefore not "did the check fail" but "did it
 * fail over something".
 *
 * And the reason is the backend's own sentence, never a paraphrase of it. The one that found this named
 * the scenario still applied, said it could not be undone and listed the parameters to set back — an
 * author can act on that, and cannot act on "the check failed".
 */
export function stalenessNotice(
  /** Chapters carrying text: what the check would have had to compare. */
  written: number,
  /** What the failed check came back with — null while it answered. A string is a failure, even a
   *  blank one: "no message" is a poor reason but it is not the same as "no failure". */
  failure: string | null | undefined
): { lead: string; detail: string } | null {
  if (failure == null || written < 1) return null
  return {
    lead:
      `The out-of-date check did not run over the ${written} written ` +
      `chapter${written === 1 ? '' : 's'}, so nothing on this page reports what has changed under ` +
      `them:`,
    detail: failure.trim() || 'The check gave no reason.'
  }
}

/**
 * Chapters a model wrote or changed since the author last approved the report. The models checked
 * figures and wording between them; whether the report says what the author wants to say under their
 * name is the author's to judge, and this is how many still wait for that read. The export asks.
 */
export function reviewPendingCount(
  sections: { id: string; text?: string | null }[],
  stale: Record<string, { review?: string | null }>
): number {
  return sections.filter((s) => (s.text ?? '').trim() && stale[s.id]?.review === 'pending').length
}

/** What the export says when it stops over chapters the author has not read since they changed. */
export function reviewRefusal(pending: number): string {
  const one = pending === 1
  return (
    `${pending} chapter${one ? ' is' : 's are'} new since you last approved the report. Read ` +
    `${one ? 'it' : 'them'} and approve the report, or export anyway.`
  )
}

/** Where the study behind a running check stands — `GET …/progress`, see `report_snapshot.build_progress`. */
export interface CheckProgress {
  done: number
  total: number
  /** Seconds since the build started, on the backend's clock — the check may have joined a warm-up
   *  that started before it was asked. */
  elapsed: number
}

/**
 * The foot's line while the check waits for its study: how far, and roughly how long is left.
 *
 * The rest is a straight extrapolation, and only once a few solves and some seconds are in: the
 * first solve of a build also pays the factorisation, so an estimate made on it alone would promise
 * far too long. After that the solves are even (measured on a 3-variant × 16-indicator
 * check: 68 of them, about 2 s each, the last ones faster), so the straight line holds. Whole minutes,
 * rounded, and "under a minute" below that — a countdown in seconds would only jump about.
 */
export function checkProgressText(p: CheckProgress): string {
  const head = `checking what changed · ${p.done} of ${p.total}`
  if (p.done >= p.total) return `${head} · finishing up`
  if (p.done < 3 || p.elapsed < 10) return head
  const left = (p.elapsed / p.done) * (p.total - p.done)
  return left < 60 ? `${head} · under a minute left` : `${head} · about ${Math.round(left / 60)} min left`
}
