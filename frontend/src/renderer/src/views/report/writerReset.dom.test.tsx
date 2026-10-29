import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import useChapterWriter from './useChapterWriter'
import type { StoredReportFull } from '../../lib/report/model'

/**
 * `reset` is listed in the dependency array of the effect in `ReportSections` that switches reports,
 * and that effect calls `setReport(null)`. So a `reset` with a fresh identity per render makes the
 * effect fire on every render: the report is nulled as fast as it loads, the panel never leaves
 * "Loading…", and the renderer spins.
 *
 * That is not a thought experiment — it shipped. Measured on the running app on 2026-09-01: the
 * Report page sat at 101 % CPU on one core with "Loading…" while `GET /report/one/...` answered in
 * 32 ms, and the Overview page next to it used 0 %. The report was never openable at all.
 */
describe('useChapterWriter', () => {
  it('hands out the same reset function across renders', () => {
    const props = {
      base: '/api/v1/report/one/db/rep-1',
      database: 'db',
      reportLang: 'en',
      studyLang: 'en',
      studyLangGuessed: false,
      reportRef: { current: null as StoredReportFull | null },
      stale: {},
      blocker: () => null,
      load: async () => {},
      loadStaleness: async () => null,
      setStale: vi.fn(),
      setStaleFailure: vi.fn(),
      mergeCorrectionTried: vi.fn(),
      setError: vi.fn(),
      openChapter: vi.fn(),
      openWriterReport: vi.fn()
    }
    const { result, rerender } = renderHook((p: typeof props) => useChapterWriter(p), {
      initialProps: props
    })
    const first = result.current.reset

    rerender({ ...props })
    expect(result.current.reset).toBe(first)

    // And a prop that really did change must not shake it loose either — the panel re-renders on
    // every keystroke in the chapter list.
    rerender({ ...props, reportLang: 'de' })
    expect(result.current.reset).toBe(first)
  })
})
