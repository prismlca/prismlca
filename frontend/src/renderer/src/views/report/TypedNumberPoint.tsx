import { useState } from 'react'
import type { StoredReview } from '../../lib/report/model'

type Point = StoredReview['issues'][number]

/**
 * One number the writer left typed out, and what the author can do about it (engine/report_typed_numbers).
 *
 * Replace it with a placeholder it was matched to — the sentence prints the same today and follows the
 * results from then on — keep it as written with a short reason (an input, a quoted figure), or have the
 * chapter fixed. A kept number is named again once the values it could be have moved (`again`): the
 * author confirms it against today's numbers, and the reason is for whoever reads it then.
 */
export default function TypedNumberPoint({
  point,
  again = false,
  busy,
  onKeep,
  onReplace,
  onFix
}: {
  point: Point
  /** Kept before, and the values it could be have moved since: asked about again. */
  again?: boolean
  busy: boolean
  onKeep: (quote: string, reason: string) => Promise<void>
  onReplace: (quote: string, path: string) => Promise<void>
  onFix: () => void
}): JSX.Element {
  const [reason, setReason] = useState(again ? (point.resolution ?? '') : '')
  const [acting, setActing] = useState(false)
  const act = async (run: () => Promise<void>): Promise<void> => {
    setActing(true)
    try {
      await run()
    } finally {
      setActing(false)
    }
  }
  const off = busy || acting
  return (
    <div className="rsec-review-point">
      <p>
        “{point.quote}” —{' '}
        {again
          ? `You kept “${point.number}” as typed, and the results have moved since. Is it still right?`
          : point.problem}
      </p>
      <div className="rsec-question-acts">
        {/* A kept number's candidates are positions in numbers that have moved since: not offered. */}
        {(again ? [] : (point.candidates ?? [])).map((c) => (
          <button
            key={c.path}
            type="button"
            className="btn sm"
            disabled={off}
            title={`Take the figure from the results instead: it prints “${c.prints}” today and follows every recalculation.`}
            onClick={() => void act(() => onReplace(point.quote, c.path))}
          >
            Replace with “{c.prints}”{c.label ? ` (${c.label})` : ''}
          </button>
        ))}
        <input
          className="rsec-question-own"
          aria-label="Why the number stays"
          placeholder="Why it stays (optional)…"
          maxLength={300}
          value={reason}
          disabled={off}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          type="button"
          className="btn sm"
          disabled={off}
          title="The number is right as typed — an input, a quoted figure. It stays, and you are reminded to check it after the next recalculation."
          onClick={() => void act(() => onKeep(point.quote, reason))}
        >
          {again ? 'Still right' : 'Keep this number'}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={off}
          title="The writer updates this chapter and takes the number from the results where it can"
          onClick={onFix}
        >
          Have it fixed
        </button>
      </div>
    </div>
  )
}
