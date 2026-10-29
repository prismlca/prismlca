import { useState } from 'react'
import { currentReview } from '../../lib/report/chapterStatus'
import type { ReportSection } from '../../lib/report/model'

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
 * asks nothing of anyone. A draft that could not be finished says why, in one sentence.
 */
export default function ReviewDetails({
  section,
  draftReason,
  busy,
  onKeep,
  onFix
}: {
  section: ReportSection
  /** Set when a refused or unfinished draft is held for this chapter. */
  draftReason?: string | null
  busy: boolean
  onKeep: (quote: string) => Promise<void>
  onFix: () => void
}): JSX.Element | null {
  const [keeping, setKeeping] = useState<string | null>(null)
  const review = currentReview(section)
  if (draftReason)
    return (
      <p className="rsec-findings rsec-review-draft" style={{ listStyle: 'none', paddingLeft: 10 }}>
        The writer could not finish this chapter: {draftReason}
      </p>
    )
  if (!review) return null
  const open = review.issues.filter((i) => i.status === 'open')
  const settled = review.issues.filter((i) => i.status !== 'open')
  return (
    <div className="rsec-review">
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
      <details className="rsec-review-log">
        <summary>
          Read by <code>{review.reviewer}</code>
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
    </div>
  )
}
