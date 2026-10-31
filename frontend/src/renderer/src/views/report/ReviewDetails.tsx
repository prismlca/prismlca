import { useState } from 'react'
import type { Finding } from '../../../../shared/ipc'
import { currentReview } from '../../lib/report/chapterStatus'
import { plainFinding, plainReason } from '../../lib/report/findingText'
import type { ReportSection } from '../../lib/report/model'
import TypedNumberPoint from './TypedNumberPoint'
import type { Place } from './useReviewPoints'
import type { TypedPlace } from '../../lib/report/staleness'

const STATUS_LABEL: Record<string, string> = {
  resolved: 'Fixed',
  false_positive: 'Right as written',
  kept: 'Kept by you',
  open: 'Still in doubt'
}

/**
 * What the second reader made of this chapter, in the editor where the text is.
 *
 * Open points come first, each with the two things the author can do: keep the sentence as written, or
 * have the writer fix it (an update of this one chapter). What was settled between writer and reader
 * sits below, folded — it is there for whoever wants to see how the chapter got where it is, and it
 * asks nothing of anyone. Numbers the writer left typed out come first: the report cannot be approved
 * while one is undecided. A draft that could not be finished says why in one sentence of the author's,
 * with the check's own words for the writer under "Details".
 */
export default function ReviewDetails({
  section,
  draft,
  moved = [],
  busy,
  onKeep,
  onReplace,
  onFix
}: {
  section: ReportSection
  /** The findings of a refused or unfinished draft held for this chapter; null when there is none. */
  draft?: Finding[] | null
  /** Kept numbers whose values have moved since they were kept — asked about again. */
  moved?: TypedPlace[]
  busy: boolean
  onKeep: (quote: string, reason?: string, place?: Place) => Promise<void>
  onReplace: (quote: string, path: string, place?: Place) => Promise<void>
  onFix: () => void
}): JSX.Element | null {
  const [keeping, setKeeping] = useState<string | null>(null)
  const review = currentReview(section)
  if (draft)
    return (
      <div className="rsec-findings rsec-review-draft" style={{ paddingLeft: 10 }}>
        <p style={{ margin: 0 }}>The writer could not finish this chapter: {plainReason(draft)}</p>
        {draft.length ? (
          <details className="rsec-review-log">
            <summary>Details</summary>
            <ul>
              {draft.map((f, n) => (
                <li key={n}>
                  <b>{plainFinding(f) === f.detail ? f.kind : plainFinding(f)}</b>{' '}
                  <span className="rsec-review-why">{f.detail}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    )
  if (!review) return null
  const numbers = review.issues.filter(
    (i) =>
      i.origin === 'typed_number' &&
      (i.status === 'open' ||
        (i.status === 'kept' &&
          moved.some(
            (m) => m.quote === i.quote && m.offset === i.offset && (m.occurrence ?? 0) === (i.occurrence ?? 0)
          )))
  )
  const open = review.issues.filter((i) => i.status === 'open' && i.origin !== 'typed_number')
  const settled = review.issues.filter((i) => i.status !== 'open' && !numbers.includes(i))
  return (
    <div className="rsec-review">
      {numbers.length ? (
        <div className="rsec-review-open">
          <p className="rsec-review-head">
            {numbers.every((i) => i.status === 'kept')
              ? 'Numbers you kept as typed — the results have moved since'
              : numbers.length === 1
                ? 'A number is typed into the text — decide about it before you approve the report'
                : `${numbers.length} numbers are typed into the text — decide about each before you approve the report`}
          </p>
          {numbers.map((i, n) => (
            <TypedNumberPoint
              key={`${n}:${i.quote}`}
              point={i}
              again={i.status === 'kept'}
              busy={busy}
              onKeep={(quote, reason) =>
                onKeep(quote, reason, { offset: i.offset, occurrence: i.occurrence })
              }
              onReplace={(quote, path) =>
                onReplace(quote, path, { offset: i.offset, occurrence: i.occurrence })
              }
              onFix={onFix}
            />
          ))}
        </div>
      ) : null}
      {open.length ? (
        <div className="rsec-review-open">
          <p className="rsec-review-head">
            The second reader still doubts {open.length === 1 ? 'a sentence' : `${open.length} sentences`}
          </p>
          {open.map((i) => (
            <div key={i.quote} className="rsec-review-point">
              <p>
                “{i.quote}” — {i.problem}
              </p>
              <div className="rsec-review-acts">
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy || keeping !== null}
                  title="You have read the sentence and it is right: nothing is rewritten"
                  onClick={async () => {
                    setKeeping(i.quote)
                    try {
                      await onKeep(i.quote)
                    } finally {
                      setKeeping(null)
                    }
                  }}
                >
                  Keep as written
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy || keeping !== null}
                  title="The writer changes this sentence, and the reader reads it again"
                  onClick={onFix}
                >
                  Have it fixed
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {review.reviewer || settled.length ? (
        <details className="rsec-review-log">
          <summary>
            {review.reviewer ? (
              <>
                Read by <code>{review.reviewer}</code>
              </>
            ) : (
              'Not read by a second model'
            )}
            {review.rounds > 1 ? ` · ${review.rounds} readings` : ''}
            {/* "Nothing to object to" only when it is true — not under a point the reader still doubts. */}
            {settled.length
              ? ` · ${settled.length} point${settled.length === 1 ? '' : 's'} settled with the writer`
              : open.length
                ? ''
                : ' · nothing to object to'}
          </summary>
          {settled.length ? (
            <ul>
              {settled.map((i) => (
                <li key={i.quote}>
                  <b>{STATUS_LABEL[i.status] ?? i.status}:</b> “{i.quote}” — {i.problem}
                  {i.resolution ? <span className="rsec-review-why"> {i.resolution}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </details>
      ) : null}
    </div>
  )
}
