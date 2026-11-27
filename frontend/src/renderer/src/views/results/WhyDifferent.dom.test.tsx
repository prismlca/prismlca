import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Results from '../Results'
import { renderWithPrism } from '../../test/render'
import type { Routes } from '../../test/prism'
import { resetQueryCache } from '../../lib/server/useQuery'
import type { DifferenceBlock, DifferenceSplit } from './types'

beforeEach(() => {
  resetQueryCache()
  localStorage.clear()
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
 * What makes the difference on the Results page: every per-subject request of a run names the run, all its
 * subjects and its own place among them, and the splits that come back stand under each indicator's chart —
 * three drivers per scenario, the whole list on a click, a pair that could not be split saying why.
 */
const GWP = { method: ['EF v3.1', 'climate change', 'GWP100'], name: 'climate change', unit: 'kg CO2-Eq' }
const AP = { method: ['EF v3.1', 'acidification', 'AE'], name: 'acidification', unit: 'mol H+-Eq' }
const PICKED = [GWP, AP].map((m) => ({
  key: m.method.join(' · '),
  method: m.method,
  family: 'EF v3.1',
  label: m.name,
  detail: m.method[2],
  unit: m.unit
}))
const DBS = [{ name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' }]
const SCENARIOS = [
  { id: 's1', name: 'Replacement hose', overrides: {} },
  { id: 's2', name: 'Light variant', overrides: {} }
]
const SCORE: Record<string, number[]> = {
  root: [51.9, 0.166],
  'root#s1': [70.1, 0.228],
  'root#s2': [42.9, 0.136]
}

function block(m: number, ref: number, sub: number): DifferenceBlock {
  const delta = sub - ref
  return {
    method: PICKED[m].method,
    unit: PICKED[m].unit,
    reference_score: ref,
    score: sub,
    delta,
    delta_pct: (100 * delta) / ref,
    changes: [
      {
        process: 'hose reel',
        exchange: 'garden hose, PVC',
        kind: 'input',
        before: 1,
        after: 2,
        unit: 'kg',
        location: 'RER',
        formula: 'n_hoses',
        runs: 1,
        contribution: 0.68 * delta,
        share_pct: 68
      },
      {
        process: 'hose reel',
        exchange: 'packaging',
        kind: 'input',
        before: 1,
        after: 2,
        unit: 'kg',
        runs: 1,
        contribution: 0.13 * delta,
        share_pct: 13
      },
      {
        process: 'hose reel',
        exchange: 'transport, lorry',
        kind: 'input',
        before: 10,
        after: 11,
        unit: 'tkm',
        runs: 1,
        contribution: 0.1 * delta,
        share_pct: 10
      },
      {
        process: 'hose reel',
        exchange: 'PVC incineration',
        kind: 'input',
        before: 1,
        after: 2,
        unit: 'kg',
        runs: 1,
        contribution: 0.09 * delta,
        share_pct: 9
      }
    ],
    not_explained: 0,
    exact: true
  }
}

/** A backend that scores each subject and answers the run as engine/difference_run.py does: the plan every time,
 *  a split in the request that brings its second side. `broken` names subjects whose split fails. */
function routes(db: string, extra: Record<string, unknown> = {}, broken: number[] = []): Routes {
  return {
    [`GET /api/v1/views/${db}`]: {
      view: {
        results: { subjSel: { root: true }, picked: PICKED, scenSel: { s1: true, s2: true }, ...extra }
      }
    },
    'PUT /api/v1/views/:db': { ok: true },
    [`GET /api/v1/model/activities/${db}`]: [{ code: 'root', name: 'Garden hose reel' }],
    [`GET /api/v1/model/reference/${db}`]: { candidates: [{ code: 'root' }] },
    'GET /api/v1/scenarios': SCENARIOS,
    'GET /api/v1/model/tag-groups/in-use': { groups: [] },
    'POST /api/v1/calc/compare': (body: unknown) => {
      const b = body as {
        subjects: { code: string; label: string; scenario?: string; database: string }[]
        methods: string[][]
        difference?: { at: number; of: { code: string; scenario?: string; database: string }[] }
      }
      const s = b.subjects[0]
      const key = (x: { code: string; scenario?: string }): string =>
        x.code + (x.scenario ? `#${x.scenario}` : '')
      const scores = SCORE[key(s)] ?? [5, 5]
      const out: Record<string, unknown> = {
        methods: b.methods.map((m) => ({ key: m.join(' · '), unit: 'u', method: m })),
        subjects: [
          {
            label: s.label,
            code: s.code,
            scores: Object.fromEntries(PICKED.map((p, i) => [p.key, scores[i]]))
          }
        ]
      }
      if (b.difference) {
        const { at, of } = b.difference
        const base = of.findIndex((x) => !x.scenario && x.code === 'root')
        const plan = of.map((x, i) =>
          x.scenario
            ? base >= 0
              ? { reference: base }
              : { reason: 'no_baseline' }
            : i === base
              ? { reason: 'reference' }
              : { reason: 'independent' }
        )
        const splits: DifferenceSplit[] = []
        if (of[at].scenario && base >= 0) {
          const ref = SCORE.root
          splits.push(
            broken.includes(at)
              ? { subject: at, reference: 0, error: 'The model changed while the results were computed.' }
              : { subject: at, reference: 0, indicators: [0, 1].map((m) => block(m, ref[m], scores[m])) }
          )
        }
        out.difference = { plan, splits }
      }
      return out
    }
  }
}

async function calculate(rows: number): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: /Calculate/ }))
  await waitFor(() => expect(document.querySelectorAll('.td-score')).toHaveLength(rows * PICKED.length))
  return user
}

describe('what makes the difference on the Results page', () => {
  it('rides on every request of the run, and stands under each chart with three drivers per scenario', async () => {
    const db = 'fg-why-run'
    const { prism } = renderWithPrism(<Results activeDb={db} methods={[GWP, AP]} databases={DBS} />, {
      routes: routes(db)
    })
    const user = await calculate(3)
    const asked = prism.calls
      .filter((c) => c.path === '/api/v1/calc/compare')
      .map((c) => (c.body as { difference: { run: string; of: unknown[]; at: number } }).difference)
    expect(asked.map((d) => d.at)).toEqual([0, 1, 2])
    expect(new Set(asked.map((d) => d.run)).size).toBe(1)
    expect(asked[0].of).toEqual([
      { database: db, code: 'root' },
      { database: db, code: 'root', scenario: 's1' },
      { database: db, code: 'root', scenario: 's2' }
    ])

    // Folded under every chart until its head is clicked.
    const section = await screen.findByRole('button', { name: 'What makes the difference — climate change' })
    expect(section.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.why-list')).toBeNull()
    await user.click(section)
    expect(section.getAttribute('aria-expanded')).toBe('true')
    const why = section.closest('.why') as HTMLElement
    const items = within(why).getAllByRole('listitem')
    expect(items.map((li) => li.querySelector('.why-who')?.textContent)).toEqual([
      'Replacement hosevs baseline+35.1%',
      'Light variantvs baseline-17.3%'
    ])
    // Three drivers, the largest first; the fourth only in the whole list.
    expect([...items[0].querySelectorAll('.why-chip')].map((c) => c.textContent)).toEqual([
      'garden hose, PVC 68 %',
      'packaging 13 %',
      'transport, lorry 10 %'
    ])
    expect(document.querySelector('.why-note')).toBeNull()
  })

  it('lists every change of a pair on a click, and opens and folds per chart', async () => {
    const db = 'fg-why-all'
    renderWithPrism(<Results activeDb={db} methods={[GWP, AP]} databases={DBS} />, { routes: routes(db) })
    const user = await calculate(3)
    const head = await screen.findByRole('button', { name: 'What makes the difference — climate change' })
    await user.click(head)
    await user.click(
      await screen.findByRole('button', { name: 'All changes — Replacement hose — climate change' })
    )
    const dialog = await screen.findByRole('dialog', {
      name: 'Replacement hose vs baseline — climate change'
    })
    const table = within(dialog).getByRole('table', { name: 'All changes' })
    expect(within(table).getAllByRole('row')).toHaveLength(5)
    expect(within(table).getByText('n_hoses')).toBeTruthy()
    expect(within(table).getByText('PVC incineration')).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    // The other chart's stays folded, and the opened one folds again on a second click.
    const other = screen.getByRole('button', { name: 'What makes the difference — acidification' })
    expect(other.getAttribute('aria-expanded')).toBe('false')
    expect(other.closest('.why')?.querySelector('.why-list')).toBeNull()
    await user.click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(head.closest('.why')?.querySelector('.why-list')).toBeNull()
  })

  it('says why a pair could not be split, and the scores stand', async () => {
    const db = 'fg-why-broken'
    renderWithPrism(<Results activeDb={db} methods={[GWP, AP]} databases={DBS} />, {
      routes: routes(db, {}, [2])
    })
    const user = await calculate(3)
    const head = await screen.findByRole('button', { name: 'What makes the difference — climate change' })
    await user.click(head)
    const why = head.closest('.why') as HTMLElement
    expect(within(why).getByText('The model changed while the results were computed.')).toBeTruthy()
    expect(within(why).getAllByRole('listitem')).toHaveLength(2)
  })

  it('names the subjects nothing is split against in one sentence, and hides it all with the switch', async () => {
    const db = 'fg-why-note'
    const bg = {
      database: 'ecoinvent-3.12',
      code: 'b1',
      name: 'PET granulate',
      geography: 'GLO',
      unit: 'kg',
      amount: 1
    }
    renderWithPrism(<Results activeDb={db} methods={[GWP, AP]} databases={DBS} />, {
      routes: routes(db, { bgSubjects: [bg] })
    })
    const user = await calculate(4)
    expect((await screen.findByText(/^Not split:/)).textContent).toBe(
      'Not split: PET granulate [GLO] — neither a scenario nor a copy of another subject here.'
    )
    await user.click(screen.getByRole('button', { name: /^Chart display/ }))
    await user.click(screen.getByRole('checkbox', { name: 'What makes the difference' }))
    expect(document.querySelector('.why')).toBeNull()
    expect(document.querySelector('.why-note')).toBeNull()
  })

  it('asks for the baseline under each chart when it is not ticked, and splits nothing', async () => {
    const db = 'fg-why-nobase'
    renderWithPrism(<Results activeDb={db} methods={[GWP, AP]} databases={DBS} />, {
      routes: routes(db, { baseline: false })
    })
    await calculate(2)
    const asks = await screen.findAllByText(
      'Tick the baseline to see what makes each scenario differ from it.'
    )
    expect(asks).toHaveLength(PICKED.length)
    expect(document.querySelector('.why-list')).toBeNull()
    expect(document.querySelector('.why-note')).toBeNull()
  })

  it('asks for the baseline under a single scenario too', async () => {
    const db = 'fg-why-one-scenario'
    const { prism } = renderWithPrism(<Results activeDb={db} methods={[GWP, AP]} databases={DBS} />, {
      routes: routes(db, { baseline: false, scenSel: { s1: true } })
    })
    await calculate(1)
    const body = prism.calls.find((c) => c.path === '/api/v1/calc/compare')?.body as Record<string, unknown>
    expect(body.difference).toMatchObject({ at: 0, of: [{ code: 'root', scenario: 's1' }] })
    expect(
      await screen.findAllByText('Tick the baseline to see what makes each scenario differ from it.')
    ).toHaveLength(PICKED.length)
  })

  it('asks for nothing with one subject', async () => {
    const db = 'fg-why-one'
    const { prism } = renderWithPrism(<Results activeDb={db} methods={[GWP, AP]} databases={DBS} />, {
      routes: routes(db, { scenSel: {} })
    })
    await calculate(1)
    const body = prism.calls.find((c) => c.path === '/api/v1/calc/compare')?.body as Record<string, unknown>
    expect(body.difference).toBeUndefined()
    expect(document.querySelector('.why')).toBeNull()
  })
})
