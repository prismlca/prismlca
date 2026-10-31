import { useCallback } from 'react'
import { api } from '../../lib/api'
import { errMsg } from '../../lib/errors'
import type { ReportSection } from '../../lib/report/model'

/** Which of a chapter's typed numbers: its place in the sentence, and which of identical sentences. */
export interface Place {
  offset?: number
  occurrence?: number
}

/**
 * What the author decides about a chapter's reading — no model call, nothing rewritten by a writer:
 * keep a sentence the second reader still doubts, keep a number the writer left typed out (with the
 * reason it stays), or put the placeholder it was matched to in its place (engine/report_typed_numbers).
 */
export function useReviewPoints({
  base,
  load,
  loadStaleness,
  onChanged,
  setError
}: {
  base: string
  load: () => Promise<void>
  loadStaleness: () => Promise<unknown>
  onChanged?: () => void
  setError: (e: string | null) => void
}): {
  keepPoint: (section: ReportSection, quote: string, reason?: string, place?: Place) => Promise<void>
  replaceNumber: (section: ReportSection, quote: string, path: string, place?: Place) => Promise<void>
} {
  const keepPoint = useCallback(
    async (section: ReportSection, quote: string, reason?: string, place?: Place): Promise<void> => {
      setError(null)
      try {
        await api('POST', `${base}/sections/${section.id}/keep-point`, {
          quote,
          reason: reason ?? '',
          ...place
        })
        await load()
        // A kept number confirmed again clears its reminder — the out-of-date check says so.
        await loadStaleness()
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [base, load, loadStaleness, setError]
  )

  /** Goes through the gate like any write: the chapter changes, so the out-of-date check runs again. */
  const replaceNumber = useCallback(
    async (section: ReportSection, quote: string, path: string, place?: Place): Promise<void> => {
      setError(null)
      try {
        const verdict = await api<{ stored: boolean; findings: { kind: string; detail: string }[] }>(
          'POST',
          `${base}/sections/${section.id}/replace-number`,
          { quote, path, ...place }
        )
        if (!verdict.stored)
          setError(
            `The number could not be replaced: ${verdict.findings[0]?.detail ?? 'the check refused it.'}`
          )
        await load()
        await loadStaleness()
        onChanged?.()
      } catch (e) {
        setError(errMsg(e))
      }
    },
    [base, load, loadStaleness, onChanged, setError]
  )

  return { keepPoint, replaceNumber }
}
