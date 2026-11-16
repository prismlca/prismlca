import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
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
 * The radar on the Results overview normalises every axis to its maximum across the subjects. Over a single
 * subject every axis is therefore at 100 % and the chart is a full polygon that says nothing, so the page
 * draws it only when there is something to compare: three indicators and two subjects.
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

/** A model with one process; `bgSubjects` adds database activities as further subjects. */
const routes = (db: string, bgSubjects: (typeof PET)[]): Routes => ({
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
          scores: Object.fromEntries(PICKED.map((p, i) => [p.key, s.code === 'root' ? i + 1 : 2]))
        }
      ]
    }
  }
})

/** Calculate, then wait until the heatmap — drawn for any number of subjects — holds every subject's row. */
async function calculate(subjects: number): Promise<void> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Calculate/ }))
  await waitFor(() => expect(document.querySelectorAll('.res-heat tbody tr')).toHaveLength(subjects))
}

describe('the radar on the Results overview', () => {
  it('is left out for one subject, even with three indicators', async () => {
    const db = 'fg-radar-one'
    renderWithPrism(<Results activeDb={db} methods={METHODS} databases={DBS} />, { routes: routes(db, []) })
    await calculate(1)
    expect(document.querySelector('.res-radar')).toBeNull()
    expect(screen.queryByText(/normalized to each indicator/)).toBeNull()
    // Nothing else of the overview goes with it.
    expect(document.querySelector('.res-heat')).not.toBeNull()
    expect(document.querySelectorAll('.ind-chart')).toHaveLength(3)
  })

  it('is drawn for two subjects and three indicators', async () => {
    const db = 'fg-radar-two'
    renderWithPrism(<Results activeDb={db} methods={METHODS} databases={DBS} />, {
      routes: routes(db, [PET])
    })
    await calculate(2)
    expect(document.querySelector('.res-radar .radar-canvas')).not.toBeNull()
    expect(screen.getByText(/normalized to each indicator/)).toBeInTheDocument()
  })
})
