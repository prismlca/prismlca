import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import ReportSections, { type ReportSection, type StoredReportFull } from './ReportSections'
import ChapterEditorSheet from './report/ChapterEditorSheet'
import { renderWithPrism } from '../test/render'
import { clearLikeChromium, typeLikeChromium } from '../test/typeNumber'

/**
 * A report number that saves on blur, while an earlier change of the same report is still reloading.
 *
 * The reload lands during the edit and puts the server's old amount back into the component's state; the
 * field keeps showing what was typed (NumberInput's draft). Saving the STATE on blur then sent the old
 * amount and the typed one was gone without a trace. The blur saves what the field
 * shows.
 */
const BASE = '/api/v1/report/one/Watering%20can/rep-1'

function fixture(): {
  routes: Record<string, unknown>
  posts: Record<string, unknown>[]
  release: () => void
} {
  const report: Record<string, unknown> = {
    id: 'rep-1',
    name: 'Watering can',
    subtitle: '',
    lang: 'en',
    template: 'prism-study',
    amount: 1,
    options: { significance_percent: 5 },
    subjects: [{ database: 'Watering can', code: 'root', scenario: null }],
    methods: [],
    sections: []
  }
  const posts: Record<string, unknown>[] = []
  let release = (): void => {}
  let held = false
  const routes = {
    [`GET ${BASE}`]: () => JSON.parse(JSON.stringify(report)),
    [`POST ${BASE}`]: async (body: Record<string, unknown>) => {
      posts.push(body)
      // The first save is held back, so its reload lands in the middle of the next edit.
      if (!held) {
        held = true
        await new Promise<void>((r) => (release = r))
      }
      Object.assign(report, body)
      return { ok: true }
    },
    [`GET ${BASE}/progress`]: { running: false },
    [`POST ${BASE}/staleness`]: { chapters: [] },
    'GET /api/v1/report/templates': { templates: [] },
    'GET /api/v1/report/prompts': { prompts: {} },
    'GET /api/v1/report/cover-placeholder': {}
  }
  return { routes, posts, release: () => release() }
}

describe('ReportSections → the amount saved on blur', () => {
  it('sends what the field shows, even when a reload put the old amount back during the edit', async () => {
    const user = userEvent.setup()
    const { routes, posts, release } = fixture()
    renderWithPrism(
      <ReportSections
        database="Watering can"
        reportId="rep-1"
        activities={[{ code: 'root', name: 'Watering can' }]}
        scenarios={[]}
        dimensions={[]}
        methods={[]}
      />,
      { routes }
    )
    // A report without indicators opens on this group by itself; open it only if it is not.
    const scope = await screen.findByRole('button', { name: /^Scope & indicators/ })
    if (scope.getAttribute('aria-expanded') !== 'true') await user.click(scope)

    // An earlier change of the same report, still waiting for its answer.
    await user.selectOptions(screen.getByLabelText('Contribution breakdown'), 'geo')

    const amount = screen.getByLabelText('Amount (functional unit)') as HTMLInputElement
    clearLikeChromium(amount)
    typeLikeChromium(amount, '2.5')

    // The held save answers now; its reload brings back amount 1 while the field still shows 2.5.
    await act(async () => release())
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(amount.value).toBe('2.5')

    fireEvent.blur(amount)
    await waitFor(() => expect(posts.length).toBeGreaterThan(1))
    expect(posts.at(-1)).toEqual({ amount: 2.5 })
    await waitFor(() => expect(amount).toHaveValue(2.5))
  })
})

describe('ChapterEditorSheet → the inventory rows saved on blur', () => {
  it('sends what the field shows, even when a reload replaced the section during the edit', () => {
    const mutate = vi.fn(async () => true)
    let reload = (): void => {}
    const SECTION = {
      id: 's1',
      kind: 'appendix',
      title: 'Inventory',
      text: '',
      inventory_rows: 25
    } as ReportSection
    function Host(): JSX.Element {
      const [open, setOpen] = useState<ReportSection>(SECTION)
      reload = () => setOpen({ ...SECTION }) // the server's copy, still at 25
      return (
        <ChapterEditorSheet
          open={open}
          report={{ id: 'rep-1', sections: [open] } as unknown as StoredReportFull}
          base="/api/v1/report/one/m/rep-1"
          error={null}
          drafts={{}}
          findings={{}}
          resolved={{}}
          prompts={{}}
          promptsRead
          writing={null}
          runActive={false}
          stage={null}
          writeSeconds={0}
          indicatorNames={new Map()}
          mutate={mutate}
          patchOpen={(patch) => setOpen((o) => ({ ...o, ...patch }))}
          clearResolved={() => {}}
          setDraftText={() => {}}
          storeDraft={async () => {}}
          discardDraft={() => {}}
          toggleResolved={async () => {}}
          askWrite={() => {}}
          loadPrompts={async () => {}}
          onReplaceNumber={async () => {}}
          movedNumbers={[]}
          onKeepPoint={async () => {}}
          onFix={() => {}}
          onEarlier={() => {}}
          onClose={() => {}}
        />
      )
    }
    render(<Host />)
    const rows = screen.getByRole('spinbutton') as HTMLInputElement
    clearLikeChromium(rows)
    typeLikeChromium(rows, '40')
    act(() => reload())
    expect(rows.value).toBe('40')
    fireEvent.blur(rows)
    expect(mutate).toHaveBeenLastCalledWith('POST', '/api/v1/report/one/m/rep-1/sections/s1', {
      kind: 'appendix',
      inventory_rows: 40
    })
    expect(rows).toHaveValue(40)
  })
})
