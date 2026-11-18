import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Results from '../Results'
import { renderWithPrism } from '../../test/render'
import type { Routes } from '../../test/prism'
import { resetQueryCache } from '../../lib/server/useQuery'

beforeEach(() => {
  resetQueryCache()
  // Someone chose Normalized in an earlier comparison: the choice is stored app-wide.
  localStorage.setItem('prism.ov.view', JSON.stringify('normalized'))
})

// jsdom has no canvas; the page's charts only need these calls to exist.
vi.mock('echarts', () => ({
  init: () => ({
    setOption: () => {},
    getDataURL: () => 'data:image/png;base64,fake',
    resize: () => {},
    dispose: () => {},
    on: () => {},
    off: () => {}
  })
}))

/**
 * The Normalized view on the Results overview draws every indicator as a share of its highest subject. Over a
 * single subject every bar is 100 % and compares nothing, so the switch to it is offered only from two subjects
 * on; with one, the page shows the bars per indicator and leaves the stored choice for the next comparison.
 */
const METHODS = ['GWP100', 'ODP', 'AP'].map((d) => ({ method: ['EF v3.1', d, d], name: d, unit: 'u' }))
const PICKED = METHODS.map((m) => ({
  key: m.method.join(' · '),
  method: m.method,
  family: 'EF v3.1',
  label: m.method[1],
  detail: m.method[2],
  unit: m.unit
}))
const DBS = [{ name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' }]

/** A model with two processes; `subjSel` says which of them are ticked as subjects. */
const routes = (db: string, subjSel: Record<string, boolean>): Routes => ({
  [`GET /api/v1/views/${db}`]: { view: { results: { subjSel, picked: PICKED } } },
  'PUT /api/v1/views/:db': { ok: true },
  [`GET /api/v1/model/activities/${db}`]: [
    { code: 'root', name: 'PET bottle production' },
    { code: 'cap', name: 'Bottle cap' }
  ],
  [`GET /api/v1/model/reference/${db}`]: { candidates: [{ code: 'root' }] },
  'GET /api/v1/scenarios': [],
  'GET /api/v1/model/tag-groups': { groups: [] },
  'POST /api/v1/calc/compare': (body: unknown) => {
    const s = (body as { subjects: { code: string; label: string }[] }).subjects[0]
    return {
      methods: PICKED.map((p) => ({ key: p.key, unit: p.unit, method: p.method })),
      subjects: [
        {
          label: s.label,
          code: s.code,
          scores: Object.fromEntries(PICKED.map((p, i) => [p.key, s.code === 'root' ? i + 1 : 2]))
        }
      ]
    }
  }
})

/** Calculate, then wait until the score table holds every subject's row. */
async function calculate(subjects: number): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Calculate/ }))
  await waitFor(() => expect(document.querySelectorAll('.td-score')).toHaveLength(subjects * PICKED.length))
}

const toggle = (): HTMLElement | null => screen.queryByRole('button', { name: 'Normalized' })

/** Press Save charts and return the names of the PNGs handed to the main process. */
async function savedChartNames(prism: { saveFilesTo: unknown }): Promise<string[]> {
  const save = vi.fn(async (files: { name: string }[]) => ({ dir: '/out', written: files, errors: [] }))
  prism.saveFilesTo = save
  await userEvent.setup().click(screen.getByRole('button', { name: /Save charts/ }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  return save.mock.calls[0][0].map((f) => f.name)
}

describe('the Normalized view on the Results overview', () => {
  it('is not offered for one subject: the bars per indicator show and are what Save charts saves', async () => {
    const db = 'fg-norm-one'
    const { prism } = renderWithPrism(<Results activeDb={db} methods={METHODS} databases={DBS} />, {
      routes: routes(db, { root: true })
    })
    // Before the first calculation the selection decides: one subject, no switch.
    await screen.findByRole('button', { name: /Calculate/ })
    expect(toggle()).toBeNull()

    await calculate(1)
    expect(toggle()).toBeNull()
    expect(screen.queryByRole('button', { name: 'Per indicator' })).toBeNull()
    expect(document.querySelector('.res-norm')).toBeNull()
    expect(document.querySelectorAll('.ind-chart')).toHaveLength(3)

    const names = await savedChartNames(prism.prism)
    expect(names).toEqual(expect.arrayContaining(['EF_v3.1_GWP100.png', 'EF_v3.1_ODP.png', 'EF_v3.1_AP.png']))
    expect(names).not.toContain('normalized_comparison.png')
    // The stored choice is untouched.
    expect(localStorage.getItem('prism.ov.view')).toBe(JSON.stringify('normalized'))
  })

  it('is offered from two subjects on, and the stored choice comes back with the next comparison', async () => {
    const db = 'fg-norm-two'
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Results activeDb={db} methods={METHODS} databases={DBS} />, {
      routes: routes(db, { root: true, cap: true })
    })
    // Two subjects ticked: the switch is there before anything is calculated.
    await screen.findByRole('button', { name: /Calculate/ })
    await waitFor(() => expect(toggle()).not.toBeNull())

    await calculate(2)
    expect(toggle()).toHaveClass('on')
    expect(document.querySelector('.res-norm')).not.toBeNull()
    expect(document.querySelectorAll('.ind-chart')).toHaveLength(0)
    expect(await savedChartNames(prism.prism)).toContain('normalized_comparison.png')

    // Unticking alone leaves the shown results, and the switch with them, until the next run.
    await user.click(screen.getAllByTitle('Include in the comparison')[1])
    expect(toggle()).not.toBeNull()
    await calculate(1)
    expect(toggle()).toBeNull()
    expect(document.querySelector('.res-norm')).toBeNull()
    expect(document.querySelectorAll('.ind-chart')).toHaveLength(3)

    // A second subject again: Normalized is back without being chosen again.
    await user.click(screen.getAllByTitle('Include in the comparison')[1])
    await calculate(2)
    expect(toggle()).toHaveClass('on')
    expect(document.querySelector('.res-norm')).not.toBeNull()
  })

  it('closes its enlarged view when a recalculation leaves one subject', async () => {
    const db = 'fg-norm-zoom'
    const user = userEvent.setup()
    renderWithPrism(<Results activeDb={db} methods={METHODS} databases={DBS} />, {
      routes: routes(db, { root: true, cap: true })
    })
    await calculate(2)
    await user.click(within(document.querySelector('.res-norm') as HTMLElement).getByTitle('Enlarge'))
    expect(document.querySelector('.chart-zoom-box')).toHaveTextContent('Normalized comparison')

    await user.click(screen.getAllByTitle('Include in the comparison')[1])
    expect(document.querySelector('.chart-zoom-box')).not.toBeNull()
    await calculate(1)
    await waitFor(() => expect(document.querySelector('.chart-zoom-box')).toBeNull())

    // Two subjects again: the chart returns, the overlay does not.
    await user.click(screen.getAllByTitle('Include in the comparison')[1])
    await calculate(2)
    expect(document.querySelector('.res-norm')).not.toBeNull()
    expect(document.querySelector('.chart-zoom-box')).toBeNull()
  })
})
