import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Results from '../Results'
import { renderWithPrism } from '../../test/render'
import type { Routes } from '../../test/prism'
import { resetQueryCache } from '../../lib/server/useQuery'

beforeEach(() => resetQueryCache())

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
 * The radar and the heatmap on the Results overview normalise every indicator to its maximum across the
 * subjects. Over a single subject every heatmap cell is therefore 100 % and every radar axis full — charts
 * that compare nothing — so the page draws the row that holds them only from two subjects on, and the radar
 * only with three indicators. The bars per indicator stay for any number of subjects.
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
const PET = {
  database: 'ecoinvent-3.12',
  code: 'b1',
  name: 'PET granulate',
  geography: 'GLO',
  unit: 'kg',
  amount: 1
}

/** A model with one process; `bgSubjects` adds database activities as further subjects. `score` gives each
 * subject's value per indicator (default: the model process 1, 2, 3; anything else 2). */
const routes = (
  db: string,
  bgSubjects: (typeof PET)[],
  score: (code: string, i: number) => number = (code, i) => (code === 'root' ? i + 1 : 2)
): Routes => ({
  [`GET /api/v1/views/${db}`]: { view: { results: { subjSel: { root: true }, picked: PICKED, bgSubjects } } },
  'PUT /api/v1/views/:db': { ok: true },
  [`GET /api/v1/model/activities/${db}`]: [{ code: 'root', name: 'PET bottle production' }],
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
          scores: Object.fromEntries(PICKED.map((p, i) => [p.key, score(s.code, i)]))
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

describe('the radar and the heatmap on the Results overview', () => {
  it('are left out for one subject, with the row that holds them', async () => {
    const db = 'fg-summary-one'
    renderWithPrism(<Results activeDb={db} methods={METHODS} databases={DBS} />, { routes: routes(db, []) })
    await calculate(1)
    expect(document.querySelector('.res-radar')).toBeNull()
    expect(document.querySelector('.res-heat')).toBeNull()
    expect(document.querySelector('.results-charts-top')).toBeNull()
    expect(screen.queryByText(/normalized to each indicator/)).toBeNull()
    expect(screen.queryByText(/normalized per indicator/)).toBeNull()
    // The bars per indicator stay.
    expect(document.querySelectorAll('.ind-chart')).toHaveLength(3)
  })

  it('are drawn for two subjects and three indicators', async () => {
    const db = 'fg-summary-two'
    renderWithPrism(<Results activeDb={db} methods={METHODS} databases={DBS} />, {
      routes: routes(db, [PET])
    })
    await calculate(2)
    expect(document.querySelector('.res-radar .radar-canvas')).not.toBeNull()
    expect(screen.getByText(/normalized to each indicator/)).toBeInTheDocument()
    expect(document.querySelectorAll('.res-heat tbody tr')).toHaveLength(2)
  })

  it('close their enlarged view when a recalculation leaves one subject', async () => {
    const db = 'fg-summary-zoom'
    const user = userEvent.setup()
    renderWithPrism(<Results activeDb={db} methods={METHODS} databases={DBS} />, {
      routes: {
        ...routes(db, []),
        [`GET /api/v1/model/activities/${db}`]: [
          { code: 'root', name: 'PET bottle production' },
          { code: 'cap', name: 'Bottle cap' }
        ],
        [`GET /api/v1/views/${db}`]: {
          view: { results: { subjSel: { root: true, cap: true }, picked: PICKED } }
        }
      }
    })
    await calculate(2)

    for (const [section, title] of [
      ['.res-radar', 'Radar — normalized'],
      ['.res-heat', 'Heatmap — normalized per indicator']
    ]) {
      await user.click(within(document.querySelector(section) as HTMLElement).getByTitle('Enlarge'))
      expect(document.querySelector('.chart-zoom-box')).toHaveTextContent(title)
      await user.click(within(document.querySelector('.chart-zoom-box') as HTMLElement).getByText('Close'))
    }

    // Open the radar large, then let a run come back with one subject behind it.
    await user.click(within(document.querySelector('.res-radar') as HTMLElement).getByTitle('Enlarge'))
    expect(document.querySelector('.chart-zoom-box')).not.toBeNull()
    await user.click(screen.getAllByTitle('Include in the comparison')[1])
    // Unticking alone leaves the numbers (and the enlarged chart) as they were until the next run.
    expect(document.querySelector('.chart-zoom-box')).not.toBeNull()
    await calculate(1)
    await waitFor(() => expect(document.querySelector('.chart-zoom-box')).toBeNull())
    expect(document.querySelector('.res-radar')).toBeNull()

    // Two subjects again: the overlay does not come back by itself.
    await user.click(screen.getAllByTitle('Include in the comparison')[1])
    await calculate(2)
    expect(document.querySelector('.res-radar')).not.toBeNull()
    expect(document.querySelector('.chart-zoom-box')).toBeNull()
  })
})

describe('a heatmap cell', () => {
  it('keeps the sign of a negative score on screen', async () => {
    const db = 'fg-summary-sign'
    // The model process is a credit on the first indicator, larger in magnitude than the other subject.
    renderWithPrism(<Results activeDb={db} methods={METHODS} databases={DBS} />, {
      routes: routes(db, [PET], (code, i) => (code === 'root' ? (i === 0 ? -4 : 1) : 2))
    })
    await calculate(2)
    const rows = document.querySelectorAll('.res-heat tbody tr')
    const cells = (r: Element): string[] =>
      [...r.querySelectorAll('.heat-cell')].map((c) => c.textContent ?? '')
    expect(cells(rows[0])).toEqual(['−100%', '50%', '50%'])
    expect(cells(rows[1])).toEqual(['50%', '100%', '100%'])
  })
})
