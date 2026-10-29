import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import useChapterWriter from './useChapterWriter'
import type { StoredReportFull } from '../../lib/report/model'
import { renderWithPrism } from '../../test/render'

const BASE = '/api/v1/report/one/db/rep-1'

/**
 * "Write all" on a report with nothing written must open its plan without calculating anything: there is
 * no text to check, and whether review findings need translating is a question for the review log. The
 * full translations endpoint builds the analysis snapshot — every indicator of every variant — and once
 * held this dialog in "checking" for minutes on an empty report.
 */
describe('the Write all plan on an empty report', () => {
  function Host(props: Parameters<typeof useChapterWriter>[0]): JSX.Element {
    const writer = useChapterWriter(props)
    return (
      <>
        <button onClick={() => void writer.planAll()}>plan</button>
        <output>{writer.plan ? (writer.plan.checking ? 'checking' : 'ready') : 'closed'}</output>
      </>
    )
  }

  it('asks the review log, not the snapshot', async () => {
    const user = userEvent.setup()
    const empty = {
      id: 'rep-1',
      lang: 'en',
      sections: [
        { id: 's1', kind: 'goal_scope', title: '', text: '' },
        { id: 's2', kind: 'lcia', title: '', text: '' }
      ]
    } as unknown as StoredReportFull
    const loadStaleness = vi.fn(async () => ({}))
    const { prism } = renderWithPrism(
      <Host
        base={BASE}
        database="db"
        reportLang="en"
        studyLang="en"
        studyLangGuessed={false}
        reportRef={{ current: empty }}
        stale={{}}
        blocker={() => null}
        load={async () => {}}
        loadStaleness={loadStaleness}
        setStale={vi.fn()}
        setStaleFailure={vi.fn()}
        setError={vi.fn()}
        openChapter={vi.fn()}
      />,
      { routes: { [`POST ${BASE}/translations/foreign`]: { foreign: [] } } }
    )

    await user.click(screen.getByRole('button', { name: 'plan' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('ready'))
    expect(prism.calls.some((c) => c.path === `${BASE}/translations/foreign`)).toBe(true)
    // The full translations list builds the snapshot; the light one answers from the review log.
    expect(prism.calls.some((c) => c.path === `${BASE}/translations`)).toBe(false)
    // With nothing written the hook checks no chapter itself; it asks the page's own check, which the
    // backend answers without computing when no chapter holds text.
    expect(prism.calls.some((c) => c.path === `${BASE}/staleness`)).toBe(false)
    expect(loadStaleness).toHaveBeenCalledTimes(1)
  })
})
