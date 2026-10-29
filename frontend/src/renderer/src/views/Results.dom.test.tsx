import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Results from './Results'
import { renderWithPrism } from '../test/render'
import type { Routes } from '../test/prism'
import { invalidate, resetQueryCache } from '../lib/server/useQuery'
import { forgetView, viewSet, viewSync } from '../lib/modelView'

// The shared query cache outlives a component between mounts (deduplication is the feature);
// these tests assert what one mount loads, so each starts cold.
beforeEach(() => resetQueryCache())

/**
 * Characterisation tests for the Results page — written before the planned split (useCompareMatrix,
 * chart components, rail), so a cut that breaks the run wiring (one request per subject, the
 * generation guard, the stale banner) turns red here first.
 *
 * Deliberately NOT covered: chart pixels (echarts is faked below — jsdom has no canvas), the PNG
 * export, stacked breakdowns, and the enlarge overlay. The subject/indicator selection is seeded
 * through the per-model view store rather than clicked together, because the picker UI has its own
 * job; these tests are about what Calculate does with a selection.
 */

// jsdom's canvas has no 2D context, and echarts.init would die on it. The fake carries exactly the
// surface the page uses; everything else failing loudly is wanted.
// Every option handed to a chart, so a test can read what the radar and the bars were given.
const chartOptions = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('echarts', () => ({
  init: () => ({
    setOption: (o: Record<string, unknown>) => chartOptions.push(o),
    getDataURL: () => 'data:image/png;base64,fake',
    resize: () => {},
    dispose: () => {},
    on: () => {},
    off: () => {}
  })
}))

const METHOD = {
  method: ['EF v3.1', 'climate change', 'GWP100'],
  name: 'climate change',
  unit: 'kg CO2-Eq'
}
const KEY = METHOD.method.join(' · ')
const PICKED = [
  {
    key: KEY,
    method: METHOD.method,
    family: 'EF v3.1',
    label: 'climate change',
    detail: 'GWP100',
    unit: 'kg CO2-Eq'
  }
]

/** A fresh model name per test: the view store caches per db at module level across tests. */
const routes = (db: string): Routes => ({
  [`GET /api/v1/views/${db}`]: {
    view: { results: { subjSel: { root: true }, picked: PICKED } }
  },
  'PUT /api/v1/views/:db': { ok: true },
  [`GET /api/v1/model/activities/${db}`]: [{ code: 'root', name: 'PET bottle production' }],
  [`GET /api/v1/model/reference/${db}`]: { candidates: [{ code: 'root' }] },
  'GET /api/v1/scenarios': [],
  'GET /api/v1/model/tag-groups': { groups: [] }
})

const DBS = [{ name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' }]

describe('Results', () => {
  it('shows the model subject from the stored selection and offers Calculate', async () => {
    renderWithPrism(<Results activeDb="fg-res-a" methods={[METHOD]} databases={DBS} />, {
      routes: routes('fg-res-a')
    })

    expect(await screen.findByText('PET bottle production')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /Calculate/ })).toBeEnabled()
    expect(screen.getByText('Ready — click Calculate.')).toBeInTheDocument()
  })

  it('Calculate sends one compare request per subject and renders the score table', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Results activeDb="fg-res-b" methods={[METHOD]} databases={DBS} />, {
      routes: {
        ...routes('fg-res-b'),
        'POST /api/v1/calc/compare': {
          methods: [{ key: KEY, unit: METHOD.unit, method: METHOD.method }],
          subjects: [{ label: 'PET bottle production', code: 'root', scores: { [KEY]: 1.5 } }]
        }
      }
    })

    await user.click(await screen.findByRole('button', { name: /Calculate/ }))

    // The run is one request per subject, so progress and cancel work between subjects.
    await waitFor(() => {
      const runs = prism.calls.filter((c) => c.path === '/api/v1/calc/compare')
      expect(runs).toHaveLength(1)
      expect(runs[0].body).toMatchObject({ methods: [METHOD.method] })
    })

    // The table carries the family header, the indicator column with its unit, and the score row.
    // ('EF v3.1' also names the family in the rail's indicator picker, hence findAll.)
    expect((await screen.findAllByText('EF v3.1')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('kg CO2-Eq').length).toBeGreaterThan(0)
    // The score is printed through the auto-decimals formatter, so match the digits, not one format.
    const cells = await screen.findAllByText(/^1[.,]50*$/)
    expect(cells.length).toBeGreaterThan(0)
  })

  it('changing the selection after a run marks the shown numbers as stale instead of recomputing', async () => {
    const user = userEvent.setup()
    // Without this marker the "open on the reference process" seeding fires and REPLACES the stored
    // two-subject selection with just the root — that is real behaviour ("the user has chosen"
    // is read off this key), so the test plays a user who has chosen.
    window.localStorage.setItem('prism.ov.subjSel.fg-res-c', '1')
    const { prism } = renderWithPrism(<Results activeDb="fg-res-c" methods={[METHOD]} databases={DBS} />, {
      routes: {
        ...routes('fg-res-c'),
        [`GET /api/v1/model/activities/fg-res-c`]: [
          { code: 'root', name: 'PET bottle production' },
          { code: 'cap', name: 'Bottle cap' }
        ],
        [`GET /api/v1/views/fg-res-c`]: {
          view: { results: { subjSel: { root: true, cap: true }, picked: PICKED } }
        },
        'POST /api/v1/calc/compare': (body: unknown) => {
          const subject = (body as { subjects: { code: string; label: string }[] }).subjects[0]
          return {
            methods: [{ key: KEY, unit: METHOD.unit, method: METHOD.method }],
            subjects: [{ label: subject.label, code: subject.code, scores: { [KEY]: 2 } }]
          }
        }
      }
    })

    await user.click(await screen.findByRole('button', { name: /Calculate/ }))
    await waitFor(() => expect(prism.calls.filter((c) => c.path === '/api/v1/calc/compare')).toHaveLength(2))
    expect(screen.queryByText(/changed after this calculation/)).toBeNull()

    // Untick one subject: the numbers stay on screen, the banner says they no longer match.
    const boxes = screen.getAllByTitle('Include in the comparison')
    await user.click(boxes[1])
    expect(await screen.findByText(/changed after this calculation/)).toBeInTheDocument()
    expect(prism.calls.filter((c) => c.path === '/api/v1/calc/compare')).toHaveLength(2)
  })

  it('lists the model scenarios with a baseline row of their own', async () => {
    renderWithPrism(<Results activeDb="fg-res-d" methods={[METHOD]} databases={DBS} />, {
      routes: {
        ...routes('fg-res-d'),
        'GET /api/v1/scenarios': [{ id: 's1', name: 'Recycled PET' }]
      }
    })

    expect(await screen.findByText('Recycled PET')).toBeInTheDocument()
    expect(screen.getByText('Baseline — no overrides')).toBeInTheDocument()
  })

  describe('opening seeds only what the stored view does not hold', () => {
    const ODP = ['EF v3.1', 'ozone depletion', 'ODP']
    // Slower than the 400 ms write pause: a write made while it is out would leave before the answer.
    const slowView =
      (results: Record<string, unknown>, ms = 600) =>
      () =>
        new Promise((r) => setTimeout(() => r({ view: { results } }), ms))
    const compareRoute = (body: unknown) => {
      const s = (body as { subjects: { code: string; label: string }[] }).subjects[0]
      return {
        methods: [{ key: KEY, unit: METHOD.unit, method: METHOD.method }],
        subjects: [{ label: s.label, code: s.code, scores: { [KEY]: 1 } }]
      }
    }
    const twoProcesses = (db: string) => ({
      [`GET /api/v1/model/activities/${db}`]: [
        { code: 'root', name: 'PET bottle production' },
        { code: 'cap', name: 'Bottle cap' }
      ]
    })

    afterEach(() => window.localStorage.removeItem('prism.ov.picked.last'))

    it.each([150, 600])(
      'a view GET of %i ms keeps the stored subject and indicators over the defaults',
      async (ms) => {
        // The reference process answers first and the last-used indicators sit in the browser; the
        // model's own choice is still in flight. The defaults used to be written into the empty cache,
        // and a field written during the GET wins over the server's answer.
        const user = userEvent.setup()
        const db = `fg-res-seed-a${ms}`
        window.localStorage.setItem(
          'prism.ov.picked.last',
          JSON.stringify([{ ...PICKED[0], key: ODP.join(' · '), method: ODP, label: 'ozone depletion' }])
        )
        const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
          routes: {
            ...routes(db),
            ...twoProcesses(db),
            [`GET /api/v1/views/${db}`]: slowView({ subjSel: { cap: true }, picked: PICKED }, ms),
            'POST /api/v1/calc/compare': compareRoute
          }
        })

        await new Promise((r) => setTimeout(r, 1200)) // past the slow GET and the 400 ms write pause
        await user.click(await screen.findByRole('button', { name: /Calculate/ }))
        await waitFor(() =>
          expect(prism.calls.filter((c) => c.path === '/api/v1/calc/compare')).toHaveLength(1)
        )
        const run = prism.calls.find((c) => c.path === '/api/v1/calc/compare')!.body as {
          subjects: { code: string }[]
          methods: string[][]
        }
        expect(run.subjects.map((s) => s.code)).toEqual(['cap'])
        expect(run.methods).toEqual([METHOD.method])
        // This model's writes only: the store is module-wide, an earlier test's model may still write.
        for (const c of prism.calls.filter((x) => x.method === 'PUT' && x.path === `/api/v1/views/${db}`)) {
          // The backend replaces the section it is sent: a `results` without the stored fields erases them.
          const results = (c.body as { view: { results?: Record<string, unknown> } }).view.results
          if (!results) continue
          expect(results.subjSel).toEqual({ cap: true })
          expect(results.picked).toEqual(PICKED)
        }
      }
    )

    it('a view GET that fails writes no defaults over the stored view', async () => {
      const db = 'fg-res-seed-c'
      window.localStorage.setItem('prism.ov.picked.last', JSON.stringify(PICKED))
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          ...twoProcesses(db),
          [`GET /api/v1/views/${db}`]: { status: 500, body: { detail: 'down' } }
        }
      })
      await screen.findByRole('button', { name: /Calculate/ })
      await new Promise((r) => setTimeout(r, 700)) // past the 400 ms write pause
      const puts = prism.calls.filter((c) => c.method === 'PUT' && c.path === `/api/v1/views/${db}`)
      expect(puts).toHaveLength(0)
    })

    it('a changed indicator selection is remembered as the last used one (for the next model)', async () => {
      const db = 'fg-res-seed-last'
      const ODP = ['EF v3.1', 'ozone depletion', 'ODP']
      const next = [{ ...PICKED[0], key: ODP.join(' · '), method: ODP, label: 'ozone depletion' }]
      renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: { ...routes(db) }
      })
      await screen.findByRole('button', { name: /Calculate/ })
      await waitFor(() =>
        expect(JSON.parse(window.localStorage.getItem('prism.ov.picked.last') ?? '[]')).toEqual(PICKED)
      )
      viewSet(db, 'results', { ...(viewSync(db).results as object), picked: next })
      await waitFor(() =>
        expect(JSON.parse(window.localStorage.getItem('prism.ov.picked.last') ?? '[]')).toEqual(next)
      )
      // An empty selection is not remembered: the next model would inherit nothing.
      viewSet(db, 'results', { ...(viewSync(db).results as object), picked: [] })
      await new Promise((r) => setTimeout(r, 50))
      expect(JSON.parse(window.localStorage.getItem('prism.ov.picked.last') ?? '[]')).toEqual(next)
    })

    it('a model never looked at still opens on its reference process and the last-used indicators', async () => {
      const user = userEvent.setup()
      const db = 'fg-res-seed-b'
      window.localStorage.setItem('prism.ov.picked.last', JSON.stringify(PICKED))
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          ...twoProcesses(db),
          [`GET /api/v1/views/${db}`]: slowView({}),
          'POST /api/v1/calc/compare': compareRoute
        }
      })

      const calc = await screen.findByRole('button', { name: /Calculate/ })
      await waitFor(() => expect(calc).toBeEnabled(), { timeout: 3000 })
      await user.click(calc)
      await waitFor(() =>
        expect(prism.calls.filter((c) => c.path === '/api/v1/calc/compare')).toHaveLength(1)
      )
      const run = prism.calls.find((c) => c.path === '/api/v1/calc/compare')!.body as {
        subjects: { code: string }[]
        methods: string[][]
      }
      expect(run.subjects.map((s) => s.code)).toEqual(['root'])
      expect(run.methods).toEqual([METHOD.method])
    })
  })

  describe('the run machinery', () => {
    const ODP = ['EF v3.1', 'ozone depletion', 'ODP']
    const PICKED_ODP = [{ ...PICKED[0], key: ODP.join(' · '), method: ODP, label: 'ozone depletion' }]
    const score = (body: unknown, v: number) => {
      const b = body as { subjects: { code: string; label: string }[]; methods: string[][] }
      return {
        methods: b.methods.map((m) => ({ key: m.join(' · '), unit: 'u', method: m })),
        subjects: [
          { label: b.subjects[0].label, code: b.subjects[0].code, scores: { [b.methods[0].join(' · ')]: v } }
        ]
      }
    }
    /** A view the backend keeps, like the real one: a PUT is read back by the next GET. */
    const storedView = (db: string, results: Record<string, unknown>) => {
      let view: Record<string, unknown> = { results }
      return {
        [`GET /api/v1/views/${db}`]: () => ({ view }),
        [`PUT /api/v1/views/${db}`]: (body: unknown) => {
          view = { ...view, ...(body as { view: Record<string, unknown> }).view }
          return { ok: true }
        }
      }
    }
    const runs = (prism: { calls: { path: string; body?: unknown }[] }) =>
      prism.calls.filter((c) => c.path === '/api/v1/calc/compare')

    it('Cancel during a pending request tells both channels, and the late answer draws nothing', async () => {
      const user = userEvent.setup()
      const db = 'fg-run-a'
      let release: (v: unknown) => void = () => {}
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          'POST /api/v1/calc/compare': (body: unknown) =>
            new Promise((r) => (release = () => r(score(body, 7)))),
          'POST /api/v1/calc/cancel': { ok: true }
        }
      })
      await user.click(await screen.findByRole('button', { name: /Calculate/ }))
      await user.click(await screen.findByRole('button', { name: 'Cancel' }))
      const cancels = prism.calls.filter((c) => c.path === '/api/v1/calc/cancel').map((c) => c.body)
      expect(cancels).toEqual([{ channel: 'compare' }, { channel: 'stacked' }])
      release(null)
      await new Promise((r) => setTimeout(r, 50))
      expect(screen.queryAllByText(/^7([.,]0+)?$/)).toHaveLength(0)
      expect(await screen.findByText('Ready — click Calculate.')).toBeInTheDocument()
    })

    it('a cancelled run answering late does not overwrite the next run', async () => {
      const user = userEvent.setup()
      const db = 'fg-run-b'
      let release: () => void = () => {}
      let n = 0
      renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          'POST /api/v1/calc/compare': (body: unknown) =>
            ++n === 1 ? new Promise((r) => (release = () => r(score(body, 9)))) : score(body, 2),
          'POST /api/v1/calc/cancel': { ok: true }
        }
      })
      await user.click(await screen.findByRole('button', { name: /Calculate/ }))
      await user.click(await screen.findByRole('button', { name: 'Cancel' }))
      await user.click(await screen.findByRole('button', { name: /Calculate/ }))
      expect((await screen.findAllByText(/^2([.,]0+)?$/)).length).toBeGreaterThan(0)
      release()
      await new Promise((r) => setTimeout(r, 50))
      expect(screen.queryAllByText(/^9([.,]0+)?$/)).toHaveLength(0)
      expect(screen.getAllByText(/^2([.,]0+)?$/).length).toBeGreaterThan(0)
    })

    it("the assistant's run token computes exactly once, also after a remount", async () => {
      const db = 'fg-run-c'
      const r = {
        ...routes(db),
        ...storedView(db, { subjSel: { root: true }, picked: PICKED, runRequested: 5 }),
        'POST /api/v1/calc/compare': (body: unknown) => score(body, 3)
      }
      const first = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: r
      })
      await waitFor(() => expect(runs(first.prism)).toHaveLength(1), { timeout: 3000 })
      await new Promise((res) => setTimeout(res, 900)) // the handled token is written (400 ms pause)
      first.unmount()
      const second = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: r
      })
      await screen.findByRole('button', { name: /Calculate/ })
      await new Promise((res) => setTimeout(res, 1200))
      expect(runs(second.prism)).toHaveLength(0)
    })

    it('the token waits for the scenario rows, then computes baseline and scenario together', async () => {
      const db = 'fg-run-d'
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          ...storedView(db, {
            subjSel: { root: true },
            picked: PICKED,
            scenSel: { s1: true },
            runRequested: 7
          }),
          'GET /api/v1/scenarios': () =>
            new Promise((res) => setTimeout(() => res([{ id: 's1', name: 'Recycled PET' }]), 1000)),
          'POST /api/v1/calc/compare': (body: unknown) => score(body, 4)
        }
      })
      await new Promise((res) => setTimeout(res, 900))
      expect(runs(prism)).toHaveLength(0)
      await waitFor(() => expect(runs(prism)).toHaveLength(2), { timeout: 3000 })
      const scen = runs(prism).map(
        (c) => (c.body as { subjects: { scenario?: string }[] }).subjects[0].scenario
      )
      expect(scen).toEqual([undefined, 's1'])
    })

    it.each([
      ['rides along with its scores', true, ['baseline']],
      ['that failed is asked for on its own, after the scores', false, ['baseline', 's1']]
    ])('with the split on, a scenario split %s', async (_case, delivered, askedApart) => {
      // Every request for a scenario variant applies and restores its parameters; the scores and the
      // split asked apart paid that twice. The process keeps its two requests (scores show first). A
      // split the backend could not compute comes back empty and is asked for the old way, where its
      // error shows after the scores.
      const db = `fg-run-split-${delivered}`
      window.localStorage.setItem('prism.ov.stacked', 'true')
      const answers: (() => void)[] = []
      const split = (body: unknown) => {
        const b = body as {
          subjects: { code: string; label: string; scenario?: string }[]
          methods: string[][]
        }
        const impact = b.subjects[0].scenario ? 6 : 4 // distinct, so a swapped or doubled split shows
        const isic = [{ key: 'C', impact, share: 1 }]
        return {
          dimensions: ['isic', 'cpc'],
          keys: { isic: ['C'], cpc: [] },
          labels: { isic: { C: 'Manufacturing' } },
          subjects: [
            {
              label: b.subjects[0].label,
              code: b.subjects[0].code,
              methods: { [b.methods[0].join(' · ')]: { total: impact, unit: 'u', dims: { isic, cpc: [] } } }
            }
          ]
        }
      }
      try {
        const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
          routes: {
            ...routes(db),
            ...storedView(db, {
              subjSel: { root: true },
              picked: PICKED,
              scenSel: { s1: true },
              runRequested: 11
            }),
            'GET /api/v1/scenarios': [{ id: 's1', name: 'Recycled PET' }],
            'POST /api/v1/calc/compare': (body: unknown) => ({
              ...score(body, 4),
              ...((body as { stacked_dimensions?: string[] }).stacked_dimensions
                ? { stacked: delivered ? split(body) : { ...split(body), subjects: [] } }
                : {})
            }),
            'POST /api/v1/calc/compare-stacked': (body: unknown) =>
              new Promise((r) => answers.push(() => r(split(body))))
          }
        })
        const splits = () => prism.calls.filter((c) => c.path === '/api/v1/calc/compare-stacked')
        // Hold every split asked apart; with the last one out, the bar counts what is done: a split that
        // rode along counts twice, one asked for again only once — 3 of 4 here, never 4 of 4.
        for (let n = 1; n <= askedApart.length; n++) {
          await waitFor(() => expect(splits()).toHaveLength(n), { timeout: 3000 })
          if (n < askedApart.length) answers.shift()!()
        }
        expect(screen.getByText(/· 3\/4$/)).toBeInTheDocument()
        answers.forEach((answer) => answer())
        const asked = runs(prism).map((c) => {
          const b = c.body as { subjects: { scenario?: string }[]; stacked_dimensions?: string[] }
          return [b.subjects[0].scenario ?? 'baseline', b.stacked_dimensions ?? 'scores only']
        })
        expect(asked).toEqual([
          ['baseline', 'scores only'],
          ['s1', ['isic', 'cpc']]
        ])
        const apart = splits().map(
          (c) => (c.body as { subjects: { scenario?: string }[] }).subjects[0].scenario ?? 'baseline'
        )
        expect(apart).toEqual(askedApart)
        // Both splits reach the chart, in subject order: one stacked value per subject for the key.
        await waitFor(() => {
          const stacked = chartOptions
            .flatMap((o) => (o.series as { stack?: string; data?: number[] }[] | undefined) ?? [])
            .filter((s) => s.stack === 'total')
          expect(stacked.at(-1)?.data).toEqual([4, 6])
        })
      } finally {
        window.localStorage.removeItem('prism.ov.stacked')
      }
    })

    it("an indicator swapped during the token's quiet period is the one computed", async () => {
      const db = 'fg-run-e'
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          ...storedView(db, { subjSel: { root: true }, picked: PICKED, runRequested: 9 }),
          'POST /api/v1/calc/compare': (body: unknown) => score(body, 5)
        }
      })
      await screen.findByRole('button', { name: /Calculate/ })
      await waitFor(() => expect(viewSync(db).results).toBeTruthy())
      viewSet(db, 'results', { ...(viewSync(db).results as object), picked: PICKED_ODP })
      await waitFor(() => expect(runs(prism)).toHaveLength(1), { timeout: 3000 })
      expect((runs(prism)[0].body as { methods: string[][] }).methods).toEqual([ODP])
    })
  })

  it('the indicator picker filters, selects all shown, and keeps its state across collapsing the group', async () => {
    const user = userEvent.setup()
    const db = 'fg-res-pick'
    const EF = (cat: string, ind: string) => ({ method: ['EF v3.1', cat, ind], name: cat, unit: 'u' })
    const methods = [
      EF('climate change', 'GWP100'),
      EF('climate change: fossil', 'GWP100'),
      EF('ozone depletion', 'ODP'),
      { method: ['CML v4.8', 'acidification', 'AP'], name: 'acidification', unit: 'u' }
    ]
    const { prism } = renderWithPrism(<Results activeDb={db} methods={methods} databases={DBS} />, {
      routes: {
        ...routes(db),
        [`GET /api/v1/views/${db}`]: { view: { results: { subjSel: { root: true } } } }
      }
    })
    await user.click(await screen.findByRole('button', { name: /Indicators/ }))
    await user.click(screen.getByRole('button', { name: '+ Add indicator' }))
    await user.selectOptions(screen.getByRole('listbox'), 'EF v3.1')
    await user.type(screen.getByPlaceholderText('Filter indicators…'), 'climate')
    expect(screen.getByText('2 indicators')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByRole('button', { name: 'Select all' })).toBeDisabled()
    // Collapse the group (open another) and come back: filter, family and the open picker are still there.
    await user.click(screen.getByRole('button', { name: /Subjects/ }))
    expect(screen.queryByPlaceholderText('Filter indicators…')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Indicators/ }))
    expect(screen.getByPlaceholderText('Filter indicators…')).toHaveValue('climate')
    expect(screen.getByRole('listbox')).toHaveValue('EF v3.1')
    // Both picked indicators are written to the view, and one chip removes one.
    await waitFor(
      () => {
        const put = prism.calls.filter((c) => c.method === 'PUT' && c.path === `/api/v1/views/${db}`).at(-1)
        const picked = (put?.body as { view: { results: { picked?: { key: string }[] } } } | undefined)?.view
          .results.picked
        expect(picked?.map((p) => p.key)).toEqual([
          'EF v3.1 · climate change · GWP100',
          'EF v3.1 · climate change: fossil · GWP100'
        ])
      },
      { timeout: 3000 }
    )
    expect(document.querySelectorAll('.ind-chip')).toHaveLength(2)
    await user.click(screen.getAllByRole('button', { name: '×' })[0])
    expect(document.querySelectorAll('.ind-chip')).toHaveLength(1)
  })

  it('the indicator picker opens on the family of the picked indicators', async () => {
    const user = userEvent.setup()
    const db = 'fg-res-pick-family'
    // No remembered family, so the page starts on the first one alphabetically — CML, where nothing is picked.
    window.localStorage.removeItem('prism.ov.family')
    const methods = [
      METHOD,
      { method: ['CML v4.8', 'acidification', 'AP'], name: 'acidification', unit: 'u' }
    ]
    renderWithPrism(<Results activeDb={db} methods={methods} databases={DBS} />, { routes: routes(db) })
    await user.click(await screen.findByRole('button', { name: /Indicators/ }))
    await user.click(screen.getByRole('button', { name: '+ Add indicator' }))
    expect(screen.getByRole('listbox')).toHaveValue('EF v3.1')
  })

  describe('the Subjects rail, clicked', () => {
    const OTHER = 'fg-rail-other'
    const RAIL_DBS = [...DBS, { name: OTHER, node_count: 2, read_only: false, kind: 'foreground' }]
    const echo = (body: unknown) => {
      const s = (body as { subjects: { code: string; label: string }[] }).subjects[0]
      return {
        methods: [{ key: KEY, unit: METHOD.unit, method: METHOD.method }],
        subjects: [{ label: s.label, code: s.code, scores: { [KEY]: 1 } }]
      }
    }
    /** Who each compare request was for, as `database/code@scenario`. */
    const asked = (prism: { calls: { path: string; body?: unknown }[] }, from = 0) =>
      prism.calls
        .filter((c) => c.path === '/api/v1/calc/compare')
        .slice(from)
        .map((c) => {
          const s = (c.body as { subjects: { database?: string; code: string; scenario?: string }[] })
            .subjects[0]
          return `${s.database ?? ''}/${s.code}@${s.scenario ?? ''}`
        })
        .sort()
    const rail = () => within(document.querySelector<HTMLElement>('.results-rail')!)
    const railRow = (text: string) => rail().getByText(text).closest('.subjrow, label') as HTMLElement

    it('a process added from the model and a ticked scenario wait for Calculate, then are computed', async () => {
      const user = userEvent.setup()
      const db = 'fg-rail-a'
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/model/activities/${db}`]: [
            { code: 'root', name: 'PET bottle production' },
            { code: 'cap', name: 'Bottle cap' }
          ],
          'GET /api/v1/scenarios': [{ id: 's1', name: 'Recycled PET' }],
          'POST /api/v1/calc/compare': echo
        }
      })
      await waitFor(() => expect(rail().getByText('Recycled PET')).toBeInTheDocument())
      await user.click(screen.getByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(asked(prism)).toEqual([`${db}/root@`]))
      await user.click(rail().getByRole('button', { name: '+ Add from this model' }))
      await user.click(
        within(screen.getByText('Bottle cap').closest('.subjrow') as HTMLElement).getByRole('button', {
          name: '+ Add'
        })
      )
      await user.click(screen.getByRole('button', { name: 'Close' }))
      await user.click(within(railRow('Recycled PET')).getByRole('checkbox'))
      expect(
        (await screen.findAllByText(/changed after this calculation|shown results are outdated/)).length
      ).toBeGreaterThan(0)
      expect(asked(prism)).toHaveLength(1)
      await user.click(screen.getByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(asked(prism, 1)).toHaveLength(4))
      expect(asked(prism, 1)).toEqual([`${db}/cap@`, `${db}/cap@s1`, `${db}/root@`, `${db}/root@s1`])
    })

    it('switching the baseline off computes the scenario alone', async () => {
      const user = userEvent.setup()
      const db = 'fg-rail-b'
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/views/${db}`]: {
            view: { results: { subjSel: { root: true }, picked: PICKED, scenSel: { s1: true } } }
          },
          'GET /api/v1/scenarios': [{ id: 's1', name: 'Recycled PET' }],
          'POST /api/v1/calc/compare': echo
        }
      })
      await waitFor(() => expect(rail().getByText('Baseline — no overrides')).toBeInTheDocument())
      await user.click(within(railRow('Baseline — no overrides')).getByRole('checkbox'))
      await user.click(screen.getByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(asked(prism)).toHaveLength(1))
      expect(asked(prism)).toEqual([`${db}/root@s1`])
    })

    it('a colour picked in the rail is stored and drawn', async () => {
      const user = userEvent.setup()
      const db = 'fg-rail-c'
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: { ...routes(db), 'POST /api/v1/calc/compare': echo }
      })
      await user.click(await screen.findByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(asked(prism)).toHaveLength(1))
      const swatch = railRow('PET bottle production').querySelector('input[type="color"]') as HTMLInputElement
      fireEvent.change(swatch, { target: { value: '#123456' } })
      await waitFor(
        () => {
          const put = prism.calls.filter((c) => c.method === 'PUT' && c.path === `/api/v1/views/${db}`).at(-1)
          expect(
            (put?.body as { view: { results: { colors?: unknown } } } | undefined)?.view.results.colors
          ).toEqual({
            root: '#123456'
          })
        },
        { timeout: 3000 }
      )
      const bar = [...chartOptions]
        .reverse()
        .find((o) => (o.series as { type: string }[] | undefined)?.[0]?.type === 'bar') as {
        series: { data: { itemStyle: { color: string } }[] }[]
      }
      expect(bar.series[0].data[0].itemStyle.color).toBe('#123456')
      expect(swatch.value).toBe('#123456')
    })

    it('another model is added by its reference process and removed with ×', async () => {
      const user = userEvent.setup()
      const db = 'fg-rail-d'
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={RAIL_DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/model/reference/${OTHER}`]: {
            candidates: [
              { code: 'g1', name: 'Glass bottle' },
              { code: 'g2', name: 'Glass melting' }
            ]
          },
          'POST /api/v1/calc/compare': echo
        }
      })
      await user.click(await rail().findByRole('button', { name: '+ Add from other model' }))
      // The dialog names the reference process and asks to confirm it — no list to pick from.
      expect(await screen.findByText('Glass bottle')).toBeInTheDocument()
      expect(screen.queryByText('Glass melting')).toBeNull()
      await user.click(screen.getByRole('button', { name: 'Add' }))
      await waitFor(() => expect(rail().getByText('Glass bottle')).toBeInTheDocument())
      await user.click(screen.getByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(asked(prism)).toHaveLength(2))
      expect(asked(prism)).toEqual([`${db}/root@`, `${OTHER}/g1@`])
      await user.click(within(railRow('Glass bottle')).getByTitle('Remove'))
      expect(rail().queryByText('Glass bottle')).toBeNull()
      await user.click(screen.getByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(asked(prism, 2)).toHaveLength(1))
      expect(asked(prism, 2)).toEqual([`${db}/root@`])
    })
  })

  describe('every handler of the Subjects rail, DOM and stored state', () => {
    // Same code `root` in three places on purpose: the own model, another model, a database activity. A handler
    // that matches on `code` alone instead of database AND code touches the wrong one.
    const OTHER = 'fg-h-other'
    const H_DBS = [...DBS, { name: OTHER, node_count: 2, read_only: false, kind: 'foreground' }]
    const fgRoot = { database: OTHER, code: 'root', name: 'Other bottle' }
    const fgGone = { database: 'deleted-model', code: 'root', name: 'Gone model process' }
    const bgRoot = {
      database: 'ecoinvent-3.12',
      code: 'root',
      name: 'Root granulate',
      geography: 'GLO',
      unit: 'kg',
      amount: 1
    }
    const bgB2 = {
      database: 'ecoinvent-3.12',
      code: 'b2',
      name: 'HDPE granulate',
      geography: 'GLO',
      unit: 'kg',
      amount: 1
    }
    // A second database activity with the code `root`, from another database: a handler matching on the code
    // alone would change both.
    const bgLib = {
      database: 'ecoinvent-3.12-lib',
      code: 'root',
      name: 'Library root',
      geography: 'GLO',
      unit: 'kg',
      amount: 1
    }
    const echo = (body: unknown) => {
      const s = (body as { subjects: { code: string; label: string }[] }).subjects[0]
      return {
        methods: [{ key: KEY, unit: METHOD.unit, method: METHOD.method }],
        subjects: [{ label: s.label, code: s.code, scores: { [KEY]: 1 } }]
      }
    }
    const asked = (prism: { calls: { path: string; body?: unknown }[] }, from = 0) =>
      prism.calls
        .filter((c) => c.path === '/api/v1/calc/compare')
        .slice(from)
        .map((c) => {
          const s = (c.body as { subjects: { database?: string; code: string; scenario?: string }[] })
            .subjects[0]
          return `${s.database ?? ''}/${s.code}@${s.scenario ?? ''}`
        })
        .sort()
    /** The `results` section as the backend has it after the latest write. */
    const stored = (prism: { calls: { method: string; path: string; body?: unknown }[] }, db: string) =>
      (
        prism.calls.filter((c) => c.method === 'PUT' && c.path === `/api/v1/views/${db}`).at(-1)?.body as
          | { view: { results: Record<string, unknown> } }
          | undefined
      )?.view.results
    const rail = () => within(document.querySelector<HTMLElement>('.results-rail')!)
    const rowOf = (title: string) =>
      [...document.querySelectorAll<HTMLElement>('.results-rail .subjrow')].find(
        (r) => r.title === title || r.textContent?.includes(title)
      )!
    const setup = (db: string) =>
      renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={H_DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/model/activities/${db}`]: [
            { code: 'root', name: 'PET bottle production' },
            { code: 'cap', name: 'Bottle cap' }
          ],
          [`GET /api/v1/model/activities/${OTHER}`]: [{ code: 'root', name: 'Other bottle' }],
          [`GET /api/v1/model/reference/${OTHER}`]: { candidates: [{ code: 'root', name: 'Other bottle' }] },
          'GET /api/v1/scenarios': [{ id: 's1', name: 'Recycled PET' }],
          [`GET /api/v1/views/${db}`]: {
            view: {
              results: {
                subjSel: { root: true, cap: true },
                picked: PICKED,
                fgSubjects: [fgRoot, fgGone],
                bgSubjects: [bgRoot, bgB2, bgLib]
              }
            }
          },
          'POST /api/v1/calc/compare': echo
        }
      })
    const waitPut = (
      prism: Parameters<typeof stored>[0],
      db: string,
      check: (r: Record<string, unknown>) => void
    ) => waitFor(() => check(stored(prism, db) ?? {}), { timeout: 3000 })

    it('the full fixture computes every enabled, visible subject — the hidden other-model entry is not one', async () => {
      const user = userEvent.setup()
      const db = 'fg-h-a'
      const { prism } = setup(db)
      await waitFor(() => expect(rail().getByText('Recycled PET')).toBeInTheDocument())
      expect(rail().queryByText('Gone model process')).toBeNull()
      await user.click(screen.getByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(asked(prism)).toHaveLength(6))
      expect(asked(prism)).toEqual(
        [
          `${OTHER}/root@`,
          `${db}/cap@`,
          `${db}/root@`,
          'ecoinvent-3.12/b2@',
          'ecoinvent-3.12/root@',
          'ecoinvent-3.12-lib/root@'
        ].sort()
      )
    })

    it('own process: unticking keeps the entry, × removes it, and only it comes back in "Add from this model"', async () => {
      const user = userEvent.setup()
      const db = 'fg-h-b'
      const { prism } = setup(db)
      await waitFor(() => expect(rowOf('Bottle cap')).toBeTruthy())
      await user.click(within(rowOf('Bottle cap')).getByRole('checkbox'))
      await waitPut(prism, db, (r) => expect(r.subjSel).toEqual({ root: true, cap: false }))
      await user.click(within(rowOf('Bottle cap')).getByTitle('Remove from the comparison'))
      await waitPut(prism, db, (r) => expect(r.subjSel).toEqual({ root: true }))
      expect(rail().queryByText('Bottle cap')).toBeNull()
      await user.click(rail().getByRole('button', { name: '+ Add from this model' }))
      const dlg = document.querySelector<HTMLElement>('.modal')!
      expect(within(dlg).queryByText('PET bottle production')).toBeNull()
      expect(within(dlg).getByText('Bottle cap')).toBeInTheDocument()
    })

    it('other model: unticking stores enabled:false, × removes only that entry — same code elsewhere untouched', async () => {
      const user = userEvent.setup()
      const db = 'fg-h-c'
      const { prism } = setup(db)
      await waitFor(() => expect(rowOf('Other bottle')).toBeTruthy())
      await user.click(within(rowOf('Other bottle')).getByRole('checkbox'))
      await waitPut(prism, db, (r) => expect(r.fgSubjects).toEqual([{ ...fgRoot, enabled: false }, fgGone]))
      expect(within(rowOf('PET bottle production')).getByRole('checkbox')).toBeChecked()
      await user.click(screen.getByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(asked(prism)).toHaveLength(5))
      expect(asked(prism)).not.toContain(`${OTHER}/root@`)
      await user.click(within(rowOf('Other bottle')).getByTitle('Remove'))
      await waitPut(prism, db, (r) => {
        expect(r.fgSubjects).toEqual([fgGone])
        expect(r.bgSubjects).toEqual([bgRoot, bgB2, bgLib])
        expect(r.subjSel).toEqual({ root: true, cap: true })
      })
    })

    it('database activity: unticking stores enabled:false, × removes only that entry', async () => {
      const user = userEvent.setup()
      const db = 'fg-h-d'
      const { prism } = setup(db)
      await waitFor(() => expect(rowOf('Root granulate')).toBeTruthy())
      await user.click(within(rowOf('Root granulate')).getByRole('checkbox'))
      await waitPut(prism, db, (r) =>
        expect(r.bgSubjects).toEqual([{ ...bgRoot, enabled: false }, bgB2, bgLib])
      )
      await user.click(within(rowOf('HDPE granulate')).getByTitle('Remove'))
      await waitPut(prism, db, (r) => {
        expect(r.bgSubjects).toEqual([{ ...bgRoot, enabled: false }, bgLib])
        expect(r.fgSubjects).toEqual([fgRoot, fgGone])
      })
      // The library's `root` goes, the ecoinvent `root` with the same code stays.
      await user.click(within(rowOf('Library root')).getByTitle('Remove'))
      await waitPut(prism, db, (r) => expect(r.bgSubjects).toEqual([{ ...bgRoot, enabled: false }]))
    })

    it('each colour lands under its own key and toggles nothing', async () => {
      const db = 'fg-h-e'
      const { prism } = setup(db)
      await waitFor(() => expect(rail().getByText('Recycled PET')).toBeInTheDocument())
      const colour = (title: string, value: string) =>
        fireEvent.change(rowOf(title).querySelector('input[type="color"]')!, { target: { value } })
      colour('PET bottle production', '#000001')
      colour('Recycled PET', '#000002')
      colour('Other bottle', '#000003')
      colour('Root granulate', '#000004')
      await waitPut(prism, db, (r) => {
        expect(r.colors).toEqual({
          root: '#000001',
          s1: '#000002',
          [`${OTHER}/root`]: '#000003',
          'ecoinvent-3.12/root': '#000004'
        })
        expect(r.subjSel).toEqual({ root: true, cap: true })
        expect(r.fgSubjects).toEqual([fgRoot, fgGone])
        expect(r.bgSubjects).toEqual([bgRoot, bgB2, bgLib])
      })
    })

    it("clicking a row's name toggles it, the colour swatch does not, and collapsing the group keeps everything", async () => {
      const user = userEvent.setup()
      const db = 'fg-h-g'
      const { prism } = setup(db)
      await waitFor(() => expect(rowOf('Bottle cap')).toBeTruthy())
      await user.click(within(rowOf('Bottle cap')).getByText('Bottle cap'))
      await waitPut(prism, db, (r) => expect(r.subjSel).toEqual({ root: true, cap: false }))
      await user.click(rowOf('PET bottle production').querySelector('input[type="color"]')!)
      await new Promise((r) => setTimeout(r, 600))
      expect(stored(prism, db)?.subjSel).toEqual({ root: true, cap: false })
      // Collapse the group by opening another, then come back: same rows, same ticks.
      await user.click(screen.getByRole('button', { name: /Indicators/ }))
      expect(document.querySelector('.results-rail .subjrow')).toBeNull()
      await user.click(screen.getByRole('button', { name: /Subjects/ }))
      expect(within(rowOf('Bottle cap')).getByRole('checkbox')).not.toBeChecked()
      expect(within(rowOf('PET bottle production')).getByRole('checkbox')).toBeChecked()
      expect(rowOf('Other bottle')).toBeTruthy()
      expect(rowOf('Root granulate')).toBeTruthy()
    })

    it('"Add from other model" refuses a model already added and does not add it twice', async () => {
      const user = userEvent.setup()
      const db = 'fg-h-f'
      const { prism } = setup(db)
      await user.click(await rail().findByRole('button', { name: '+ Add from other model' }))
      expect(await screen.findByRole('button', { name: 'Already added' })).toBeDisabled()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await new Promise((r) => setTimeout(r, 500))
      const r = stored(prism, db)
      if (r) expect(r.fgSubjects).toEqual([fgRoot, fgGone])
    })
  })

  describe('opening under races: four answers in any order', () => {
    /** A response held back until the test opens it. */
    const gate = () => {
      let open: (v: unknown) => void = () => {}
      const p = new Promise((r) => (open = r))
      return { p, open: (v: unknown) => open(v) }
    }
    type Gates = Record<'view' | 'acts' | 'ref' | 'scen', ReturnType<typeof gate>>
    const ORDERS: (keyof Gates)[][] = [
      ['view', 'acts', 'ref', 'scen'],
      ['scen', 'ref', 'acts', 'view'],
      ['acts', 'scen', 'view', 'ref'],
      ['ref', 'view', 'scen', 'acts']
    ]
    const puts = (prism: { calls: { method: string; path: string; body?: unknown }[] }, db: string) =>
      prism.calls
        .filter((c) => c.method === 'PUT' && c.path === `/api/v1/views/${db}`)
        .map((c) => (c.body as { view: { results?: Record<string, unknown> } }).view.results)
        .filter((r): r is Record<string, unknown> => !!r)
    async function open(
      db: string,
      order: (keyof Gates)[],
      answers: { view: unknown; scen: unknown },
      opts: { methods?: (typeof METHOD)[]; databases?: typeof DBS } = {}
    ) {
      const g: Gates = { view: gate(), acts: gate(), ref: gate(), scen: gate() }
      const fixture = renderWithPrism(
        <Results activeDb={db} methods={opts.methods ?? [METHOD]} databases={opts.databases ?? DBS} />,
        {
          routes: {
            ...routes(db),
            [`GET /api/v1/views/${db}`]: () => g.view.p,
            [`GET /api/v1/model/activities/${db}`]: () => g.acts.p,
            [`GET /api/v1/model/reference/${db}`]: () => g.ref.p,
            'GET /api/v1/scenarios': () => g.scen.p
          }
        }
      )
      // The backend answers `{ view }`; an envelope with a status passes through as the failure it is.
      const failed = !!answers.view && typeof (answers.view as { status?: unknown }).status === 'number'
      const value = {
        view: failed ? answers.view : { view: answers.view },
        acts: [
          { code: 'root', name: 'PET bottle production' },
          { code: 'cap', name: 'Bottle cap' }
        ],
        ref: { candidates: [{ code: 'root' }] },
        scen: answers.scen
      }
      for (const k of order) {
        g[k].open(value[k])
        await new Promise((r) => setTimeout(r, 30))
      }
      await new Promise((r) => setTimeout(r, 700)) // past the 400 ms write pause
      return fixture
    }

    it.each(ORDERS)(
      'a migrated view keeps everything but the deleted scenario tick (%s, %s, %s, %s)',
      async (...order) => {
        const db = `fg-race-a-${order.join('')}`
        const results = {
          subjSel: { root: true },
          picked: PICKED,
          colors: { root: '#111111' },
          scenSel: { s1: true, gone: true },
          baseline: true,
          keys: 2
        }
        const { prism } = await open(db, order, {
          view: { results },
          scen: [{ id: 's1', name: 'Recycled PET' }]
        })
        const all = puts(prism, db)
        expect(all.length).toBeGreaterThan(0)
        for (const r of all) {
          expect(r.picked).toEqual(PICKED)
          expect(r.colors).toEqual({ root: '#111111' })
          expect(r.subjSel).toEqual({ root: true })
        }
        expect(all.at(-1)).toEqual({ ...results, scenSel: { s1: true } })
      }
    )

    it.each(ORDERS)(
      'a model never looked at opens on its reference process and the last indicators (%s, %s, %s, %s)',
      async (...order) => {
        const db = `fg-race-b-${order.join('')}`
        window.localStorage.setItem('prism.ov.picked.last', JSON.stringify(PICKED))
        try {
          const { prism } = await open(db, order, { view: {}, scen: [] })
          const last = puts(prism, db).at(-1)
          expect(last?.subjSel).toEqual({ root: true })
          expect(last?.picked).toEqual(PICKED)
        } finally {
          window.localStorage.removeItem('prism.ov.picked.last')
        }
      }
    )

    it.each(ORDERS)('a failed view GET writes nothing (%s, %s, %s, %s)', async (...order) => {
      const db = `fg-race-c-${order.join('')}`
      window.localStorage.setItem('prism.ov.picked.last', JSON.stringify(PICKED))
      try {
        const { prism } = await open(db, order, {
          view: { status: 500, body: { detail: 'down' } },
          scen: [{ id: 's1', name: 'Recycled PET' }]
        })
        expect(puts(prism, db)).toEqual([])
      } finally {
        window.localStorage.removeItem('prism.ov.picked.last')
      }
    })

    // CHARACTERISATION of HEAD (e41d3600 line): an old-format reference `root` that both the own process and
    // another model's copy answer to, with the baseline stored OFF and no scenarios left. The baseline repair runs
    // before the key migration in every order driven here, so the own process wins. Resolving it "as stored" (the
    // other model's copy) was tried and reverted; deliberately not done.
    it.each(ORDERS)(
      'an old reference with a code collision, baseline stored off (%s, %s, %s, %s)',
      async (...order) => {
        const OTHER = 'fg-race-other'
        const db = `fg-race-e-${order.join('')}`
        const { prism } = await open(
          db,
          order,
          {
            view: {
              results: {
                subjSel: { root: true },
                baseline: false,
                scenSel: {},
                picked: PICKED,
                fgSubjects: [{ database: OTHER, code: 'root', name: 'Other bottle' }],
                refCode: 'root'
              }
            },
            scen: []
          },
          { databases: [...DBS, { name: OTHER, node_count: 1, read_only: false, kind: 'foreground' }] }
        )
        const last = puts(prism, db).at(-1)
        expect(last?.keys).toBe(2)
        expect(last?.baseline).toBe(true)
        expect(last?.refCode).toBe('root')
        for (const r of puts(prism, db)) expect(r.picked).toEqual(PICKED)
      }
    )

    it("the assistant's run token waits for the view even when the processes are already cached", async () => {
      const db = 'fg-race-f'
      const results = { subjSel: { root: true }, picked: PICKED, runRequested: 5, keys: 2 }
      const compare = (body: unknown) => {
        const s0 = (body as { subjects: { code: string; label: string }[] }).subjects[0]
        return {
          methods: [{ key: KEY, unit: METHOD.unit, method: METHOD.method }],
          subjects: [{ label: s0.label, code: s0.code, scores: { [KEY]: 1 } }]
        }
      }
      // First mount fills the shared query cache with this model's processes; the view store is then forgotten,
      // so the second mount has warm processes but a view still on its way.
      const warm = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/views/${db}`]: { view: {} },
          'POST /api/v1/calc/compare': compare
        }
      })
      await screen.findByRole('button', { name: /Calculate/ })
      await new Promise((r) => setTimeout(r, 100))
      warm.unmount()
      forgetView(db)
      const g = gate()
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/views/${db}`]: () => g.p,
          'POST /api/v1/calc/compare': compare
        }
      })
      await new Promise((r) => setTimeout(r, 1200))
      expect(prism.calls.filter((c) => c.path === '/api/v1/calc/compare')).toHaveLength(0)
      g.open({ view: { results } })
      await waitFor(
        () => expect(prism.calls.filter((c) => c.path === '/api/v1/calc/compare')).toHaveLength(1),
        {
          timeout: 3000
        }
      )
      await new Promise((r) => setTimeout(r, 1000))
      const runs = prism.calls.filter((c) => c.path === '/api/v1/calc/compare')
      expect(runs).toHaveLength(1)
      expect((runs[0].body as { subjects: { code: string }[] }).subjects.map((x) => x.code)).toEqual(['root'])
    })

    it('under StrictMode with late scenarios the token computes once, baseline and scenario together', async () => {
      const db = 'fg-race-g'
      const g = gate()
      const { prism } = renderWithPrism(
        <StrictMode>
          <Results activeDb={db} methods={[METHOD]} databases={DBS} />
        </StrictMode>,
        {
          routes: {
            ...routes(db),
            [`GET /api/v1/views/${db}`]: {
              view: {
                results: {
                  subjSel: { root: true },
                  picked: PICKED,
                  scenSel: { s1: true },
                  runRequested: 7,
                  keys: 2
                }
              }
            },
            'GET /api/v1/scenarios': () => g.p,
            'POST /api/v1/calc/compare': (body: unknown) => {
              const s0 = (body as { subjects: { code: string; label: string }[] }).subjects[0]
              return {
                methods: [{ key: KEY, unit: METHOD.unit, method: METHOD.method }],
                subjects: [{ label: s0.label, code: s0.code, scores: { [KEY]: 1 } }]
              }
            }
          }
        }
      )
      await new Promise((r) => setTimeout(r, 1000))
      expect(prism.calls.filter((c) => c.path === '/api/v1/calc/compare')).toHaveLength(0)
      g.open([{ id: 's1', name: 'Recycled PET' }])
      await waitFor(
        () => expect(prism.calls.filter((c) => c.path === '/api/v1/calc/compare')).toHaveLength(2),
        {
          timeout: 3000
        }
      )
      await new Promise((r) => setTimeout(r, 1000))
      const runs = prism.calls.filter((c) => c.path === '/api/v1/calc/compare')
      expect(runs).toHaveLength(2)
      expect(
        runs.map((c) => (c.body as { subjects: { scenario?: string }[] }).subjects[0].scenario ?? '').sort()
      ).toEqual(['', 's1'])
    })

    it('an explicitly empty selection stays empty; only a missing one is seeded', async () => {
      const empty = await open('fg-race-d1', ORDERS[1], {
        view: { results: { subjSel: {}, picked: PICKED, keys: 2 } },
        scen: []
      })
      for (const r of puts(empty.prism, 'fg-race-d1')) expect(r.subjSel).toEqual({})
      empty.unmount()
      const missing = await open('fg-race-d2', ORDERS[1], {
        view: { results: { picked: PICKED, keys: 2 } },
        scen: []
      })
      expect(puts(missing.prism, 'fg-race-d2').at(-1)?.subjSel).toEqual({ root: true })
    })
  })

  describe('switching the model while its processes load', () => {
    const gate = () => {
      let open: (v: unknown) => void = () => {}
      const p = new Promise((r) => (open = r))
      return { p, open: (v: unknown) => open(v) }
    }
    const A = 'fg-pf-a'
    const B = 'fg-pf-b'
    const AB_DBS = [
      ...DBS,
      { name: A, node_count: 1, read_only: false, kind: 'foreground' },
      { name: B, node_count: 1, read_only: false, kind: 'foreground' }
    ]
    const view = (db: string) => ({
      [`GET /api/v1/views/${db}`]: {
        view: { results: { subjSel: { root: true }, picked: PICKED, keys: 2 } }
      },
      [`GET /api/v1/model/reference/${db}`]: { candidates: [{ code: 'root' }] }
    })
    const rail = () => within(document.querySelector<HTMLElement>('.results-rail')!)

    it('the model just left gets no automatic write when its opening answers arrive after the switch', async () => {
      const viewA = gate()
      const scenA = gate()
      const { prism, rerender } = renderWithPrism(
        <Results activeDb={A} methods={[METHOD]} databases={AB_DBS} />,
        {
          routes: {
            ...routes(A),
            ...view(B),
            [`GET /api/v1/views/${A}`]: () => viewA.p,
            [`GET /api/v1/model/reference/${A}`]: { candidates: [{ code: 'root' }] },
            'GET /api/v1/scenarios': (_: unknown, path: string) =>
              path.includes(encodeURIComponent(A)) ? scenA.p : [],
            [`GET /api/v1/model/activities/${A}`]: [{ code: 'root', name: 'A bottle' }],
            [`GET /api/v1/model/activities/${B}`]: [{ code: 'root', name: 'B bottle' }]
          }
        }
      )
      await new Promise((r) => setTimeout(r, 100))
      rerender(<Results activeDb={B} methods={[METHOD]} databases={AB_DBS} />)
      await waitFor(() => expect(rail().getByText('B bottle')).toBeInTheDocument())
      // A's view (nothing selected, an unknown scenario ticked) and A's scenario list arrive only now.
      viewA.open({ view: { results: { scenSel: { gone: true }, baseline: false } } })
      scenA.open([])
      await new Promise((r) => setTimeout(r, 700)) // past the 400 ms write pause
      expect(prism.calls.filter((c) => c.method === 'PUT' && c.path === `/api/v1/views/${A}`)).toEqual([])
    })

    it('a late answer for the model just left does not land in the model now open', async () => {
      const lateA = gate()
      const { rerender } = renderWithPrism(<Results activeDb={A} methods={[METHOD]} databases={AB_DBS} />, {
        routes: {
          ...routes(A),
          ...view(A),
          ...view(B),
          [`GET /api/v1/model/activities/${A}`]: () => lateA.p,
          [`GET /api/v1/model/activities/${B}`]: [{ code: 'root', name: 'B bottle' }]
        }
      })
      await new Promise((r) => setTimeout(r, 100))
      rerender(<Results activeDb={B} methods={[METHOD]} databases={AB_DBS} />)
      await waitFor(() => expect(rail().getByText('B bottle')).toBeInTheDocument())
      lateA.open([{ code: 'root', name: 'A bottle' }])
      await new Promise((r) => setTimeout(r, 200))
      expect(rail().queryByText('A bottle')).toBeNull()
      expect(rail().getByText('B bottle')).toBeInTheDocument()
    })

    it('a late failure for the model just left shows no error in the model now open', async () => {
      const lateA = gate()
      const { rerender } = renderWithPrism(<Results activeDb={A} methods={[METHOD]} databases={AB_DBS} />, {
        routes: {
          ...routes(A),
          ...view(A),
          ...view(B),
          [`GET /api/v1/model/activities/${A}`]: () => lateA.p,
          [`GET /api/v1/model/activities/${B}`]: [{ code: 'root', name: 'B bottle' }]
        }
      })
      await new Promise((r) => setTimeout(r, 100))
      rerender(<Results activeDb={B} methods={[METHOD]} databases={AB_DBS} />)
      await waitFor(() => expect(rail().getByText('B bottle')).toBeInTheDocument())
      lateA.open({ status: 500, body: { detail: 'A broke' } })
      await new Promise((r) => setTimeout(r, 200))
      expect(screen.queryByText(/A broke/)).toBeNull()
    })

    // Was a known defect, now fixed: the old model's
    // process list stayed in state until the new one arrived, so a process of A sharing a code with B's
    // selection was shown in B and computed AS B's. The list is now bound to the model it was loaded for.
    it("A fully loaded, then B slow: A's process is neither shown nor computed as B's meanwhile", async () => {
      const slowB = gate()
      const { prism, rerender } = renderWithPrism(
        <Results activeDb={A} methods={[METHOD]} databases={AB_DBS} />,
        {
          routes: {
            ...routes(A),
            ...view(A),
            ...view(B),
            [`GET /api/v1/model/activities/${A}`]: [{ code: 'root', name: 'A bottle' }],
            [`GET /api/v1/model/activities/${B}`]: () => slowB.p,
            'POST /api/v1/calc/compare': (body: unknown) => {
              const s0 = (body as { subjects: { code: string; label: string }[] }).subjects[0]
              return {
                methods: [{ key: KEY, unit: METHOD.unit, method: METHOD.method }],
                subjects: [{ label: s0.label, code: s0.code, scores: { [KEY]: 1 } }]
              }
            }
          }
        }
      )
      await waitFor(() => expect(rail().getByText('A bottle')).toBeInTheDocument())
      rerender(<Results activeDb={B} methods={[METHOD]} databases={AB_DBS} />)
      await new Promise((r) => setTimeout(r, 300))
      const shown = rail().queryByText('A bottle') ? 'A bottle shown in B' : 'not shown'
      const calc = screen.queryByRole('button', { name: /Calculate/ }) as HTMLButtonElement | null
      let computed = 'no calculate'
      if (calc && !calc.disabled) {
        calc.click()
        await new Promise((r) => setTimeout(r, 200))
        computed = JSON.stringify(
          prism.calls
            .filter((c) => c.path === '/api/v1/calc/compare')
            .map((c) => (c.body as { subjects: unknown[] }).subjects[0])
        )
      }
      slowB.open([{ code: 'root', name: 'B bottle' }])
      expect(shown).toBe('not shown')
      expect(computed).toBe('no calculate')
      await waitFor(() => expect(rail().getByText('B bottle')).toBeInTheDocument())
    })
  })

  describe('two models with the same codes', () => {
    // A bundle imported under another name keeps its codes: the copy's reference process is `root`
    // as well. Identity used to be code (+ scenario) only, so the radar drew the copy with the
    // original's numbers and, in difference mode, both counted as the reference.
    const METHODS = ['GWP100', 'ODP', 'AP'].map((d) => ({
      method: ['EF v3.1', d, d],
      name: d,
      unit: 'u'
    }))
    const PICKED3 = METHODS.map((m) => ({
      key: m.method.join(' · '),
      method: m.method,
      family: 'EF v3.1',
      label: m.method[1],
      detail: m.method[2],
      unit: m.unit
    }))
    const COPY = 'fg-res-e-copy'
    const ALL_DBS = [...DBS, { name: COPY, node_count: 3, read_only: false, kind: 'foreground' }]

    afterEach(() => {
      window.localStorage.removeItem('prism.ov.diffMode')
      chartOptions.length = 0
    })

    /** The colours the latest bar chart and the latest radar were given, per subject label. */
    const drawnColours = () => {
      const last = (type: string) =>
        [...chartOptions]
          .reverse()
          .find((o) => (o.series as { type: string }[] | undefined)?.[0]?.type === type)
      const bar = last('bar') as {
        xAxis: { data: string[] }
        series: { data: { itemStyle: { color: string } }[] }[]
      }
      const radar = last('radar') as { series: { data: { name: string; itemStyle: { color: string } }[] }[] }
      return {
        bar: bar.series[0].data.map((d) => d.itemStyle.color),
        radar: Object.fromEntries(radar.series[0].data.map((d) => [d.name, d.itemStyle.color]))
      }
    }
    const scoreFor = (f: (code: string) => number) => (body: unknown) => {
      const s = (body as { subjects: { code: string; label: string }[] }).subjects[0]
      return {
        methods: PICKED3.map((p) => ({ key: p.key, unit: p.unit, method: p.method })),
        subjects: [
          { label: s.label, code: s.code, scores: Object.fromEntries(PICKED3.map((p) => [p.key, f(s.code)])) }
        ]
      }
    }
    const bgAct = (code: string, name: string) => ({
      database: 'ecoinvent-3.12',
      code,
      name,
      geography: 'GLO',
      unit: 'kg',
      amount: 1
    })

    it.each([
      ['no colour stored', undefined],
      ['one colour set by the user', { root: '#111111' }]
    ])(
      'bars and radar keep one colour per subject when a subject is removed without recalculating (%s)',
      async (_, colors) => {
        const user = userEvent.setup()
        const db = `fg-col-a${colors ? 1 : 0}`
        renderWithPrism(<Results activeDb={db} methods={METHODS} databases={ALL_DBS} />, {
          routes: {
            ...routes(db),
            [`GET /api/v1/views/${db}`]: {
              view: {
                results: {
                  subjSel: { root: true },
                  picked: PICKED3,
                  colors,
                  bgSubjects: [bgAct('b1', 'PET granulate'), bgAct('b2', 'HDPE granulate')]
                }
              }
            },
            'POST /api/v1/calc/compare': scoreFor((c) => (c === 'root' ? 1 : c === 'b1' ? 2 : 3))
          }
        })
        await user.click(await screen.findByRole('button', { name: /Calculate/ }))
        await screen.findAllByText('HDPE granulate')
        await waitFor(() => expect(drawnColours().bar).toHaveLength(3))
        const before = drawnColours()
        expect(before.bar[2]).toBe(before.radar['HDPE granulate [GLO]'])
        // Remove the first database activity from the rail — the shown numbers stay (marked stale).
        const row = screen
          .getAllByText('PET granulate')
          .map((e) => e.closest('.subjrow'))
          .find(Boolean)!
        await user.click(within(row as HTMLElement).getByTitle('Remove'))
        await new Promise((r) => setTimeout(r, 50))
        const after = drawnColours()
        expect(after.bar[2]).toBe(after.radar['HDPE granulate [GLO]'])
        expect(after.bar[1]).toBe(after.radar['PET granulate [GLO]'])
        // The removed subject's row stays on screen until the next Calculate: it must not borrow the
        // first subject's colour — three rows, three colours.
        expect(new Set(after.bar).size).toBe(3)
      }
    )

    it('the zoom overlay draws one chart of its own and leaves the grid charts alone', async () => {
      const user = userEvent.setup()
      const db = 'fg-zoom-a'
      renderWithPrism(<Results activeDb={db} methods={METHODS} databases={ALL_DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/views/${db}`]: { view: { results: { subjSel: { root: true }, picked: PICKED3 } } },
          'POST /api/v1/calc/compare': scoreFor(() => 1)
        }
      })
      await user.click(await screen.findByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(drawnColours().bar).toHaveLength(1))
      await new Promise((r) => setTimeout(r, 50))
      const drawn = chartOptions.length
      await user.click(screen.getAllByTitle('Enlarge')[0]) // the radar
      await waitFor(() => expect(document.querySelector('.chart-zoom-live .radar-canvas')).not.toBeNull())
      await new Promise((r) => setTimeout(r, 50))
      expect(chartOptions.length - drawn).toBe(1)
      await user.click(screen.getByRole('button', { name: 'Close' }))
      await new Promise((r) => setTimeout(r, 50))
      expect(chartOptions.length - drawn).toBe(1)
      expect(document.querySelector('.chart-zoom-live')).toBeNull()
    })

    it('an enlarged indicator shows plain bars while the stacked split is being recomputed', async () => {
      const user = userEvent.setup()
      const db = 'fg-zoom-b'
      window.localStorage.setItem('prism.ov.stacked', 'true')
      let releaseStacked: () => void = () => {}
      let stackedCalls = 0
      const stackedReply = {
        dimensions: ['isic'],
        keys: { isic: ['C'] },
        labels: { isic: { C: 'Manufacturing' } },
        subjects: [
          {
            label: 'PET bottle production',
            code: 'root',
            methods: Object.fromEntries(
              PICKED3.map((p) => [
                p.key,
                { total: 1, unit: 'u', dims: { isic: [{ key: 'C', impact: 1, share: 1 }] } }
              ])
            )
          }
        ]
      }
      try {
        renderWithPrism(<Results activeDb={db} methods={METHODS} databases={ALL_DBS} />, {
          routes: {
            ...routes(db),
            [`GET /api/v1/views/${db}`]: { view: { results: { subjSel: { root: true }, picked: PICKED3 } } },
            'POST /api/v1/calc/compare': scoreFor(() => 1),
            'POST /api/v1/calc/compare-stacked': () =>
              ++stackedCalls === 1
                ? stackedReply
                : new Promise((r) => (releaseStacked = () => r(stackedReply)))
          }
        })
        await user.click(await screen.findByRole('button', { name: /Calculate/ }))
        await waitFor(() => expect(document.querySelectorAll('.ind-chart').length).toBe(3))
        // Enlarge the first indicator: the stacked chart.
        const enlarge = within(document.querySelector<HTMLElement>('.ind-chart')!).getByTitle('Enlarge')
        await user.click(enlarge)
        await waitFor(() =>
          expect(document.querySelector('.chart-zoom-live .ind-chart-canvas')).not.toBeNull()
        )
        // The latest BAR chart drawn — radar updates carry no stack and must not count as plain bars.
        const lastType = () => {
          const bar = [...chartOptions]
            .reverse()
            .find((o) => (o.series as { type: string }[] | undefined)?.[0]?.type === 'bar')
          return ((bar?.series as { stack?: string }[] | undefined) ?? []).some((x) => x.stack === 'total')
            ? 'stacked'
            : 'plain'
        }
        expect(lastType()).toBe('stacked')
        // A recalculation while it stays open (the assistant's run token can start one): during the stacked
        // half the overlay falls back to plain bars, then shows the new split.
        await user.click(screen.getByRole('button', { name: /Calculate/ }))
        await waitFor(() => expect(stackedCalls).toBe(2))
        await waitFor(() => expect(lastType()).toBe('plain'))
        expect(document.querySelector('.chart-zoom-live .ind-chart-canvas')).not.toBeNull()
        releaseStacked()
        await waitFor(() => expect(lastType()).toBe('stacked'))
      } finally {
        window.localStorage.removeItem('prism.ov.stacked')
      }
    })

    it('a deleted scenario and a removed activity, both still shown, get two colours', async () => {
      const user = userEvent.setup()
      const db = 'fg-col-d'
      const { prism } = renderWithPrism(<Results activeDb={db} methods={METHODS} databases={ALL_DBS} />, {
        routes: {
          ...routes(db),
          'GET /api/v1/scenarios': [{ id: 's1', name: 'Recycled PET' }],
          [`GET /api/v1/views/${db}`]: {
            view: {
              results: {
                subjSel: { root: true },
                picked: PICKED3,
                baseline: false,
                scenSel: { s1: true },
                bgSubjects: [bgAct('b1', 'PET granulate')]
              }
            }
          },
          'POST /api/v1/calc/compare': scoreFor((c) => (c === 'root' ? 1 : 2))
        }
      })
      const calc = await screen.findByRole('button', { name: /Calculate/ })
      const rail = () => within(document.querySelector<HTMLElement>('.results-rail')!)
      await waitFor(() => expect(rail().getByText('Recycled PET')).toBeInTheDocument())
      await user.click(calc)
      await waitFor(() => expect(drawnColours().bar).toHaveLength(2))
      // The scenario is deleted elsewhere, and the activity is removed here — both rows stay until Calculate.
      prism.setRoute('GET /api/v1/scenarios', [])
      invalidate(`/api/v1/scenarios?database=${db}`)
      await waitFor(() => expect(rail().queryByText('Recycled PET')).toBeNull())
      const row = screen
        .getAllByText('PET granulate')
        .map((e) => e.closest('.subjrow'))
        .find(Boolean)!
      await user.click(within(row as HTMLElement).getByTitle('Remove'))
      await new Promise((r) => setTimeout(r, 50))
      const { bar } = drawnColours()
      expect(bar).toHaveLength(2)
      expect(new Set(bar).size).toBe(2)
    })

    it('typing in the indicator filter does not redraw the computed charts', async () => {
      const user = userEvent.setup()
      const db = 'fg-col-c'
      renderWithPrism(<Results activeDb={db} methods={METHODS} databases={ALL_DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/views/${db}`]: { view: { results: { subjSel: { root: true }, picked: PICKED3 } } },
          'POST /api/v1/calc/compare': scoreFor(() => 1)
        }
      })
      await user.click(await screen.findByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(drawnColours().bar).toHaveLength(1))
      await user.click(screen.getByRole('button', { name: /Indicators/ }))
      await user.click(screen.getByRole('button', { name: '+ Add indicator' }))
      await new Promise((r) => setTimeout(r, 50))
      const drawn = chartOptions.length
      await user.type(screen.getByPlaceholderText('Filter indicators…'), 'ozone')
      await new Promise((r) => setTimeout(r, 50))
      expect(chartOptions.length - drawn).toBe(0)
    })

    it('a subject from another model gets its own colour, not the first process colour', async () => {
      const user = userEvent.setup()
      const db = 'fg-col-b'
      renderWithPrism(<Results activeDb={db} methods={METHODS} databases={ALL_DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/views/${db}`]: {
            view: {
              results: {
                subjSel: { root: true },
                picked: PICKED3,
                fgSubjects: [{ database: COPY, code: 'other', name: 'Glass bottle' }]
              }
            }
          },
          'POST /api/v1/calc/compare': scoreFor((c) => (c === 'root' ? 1 : 2))
        }
      })
      await user.click(await screen.findByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(drawnColours().bar).toHaveLength(2))
      const { bar } = drawnColours()
      expect(bar[0]).not.toBe(bar[1])
    })

    it('computes them as two subjects: own rows, own radar polygons, one reference', async () => {
      const user = userEvent.setup()
      window.localStorage.setItem('prism.ov.diffMode', 'true')
      const db = 'fg-res-e'
      const { prism } = renderWithPrism(<Results activeDb={db} methods={METHODS} databases={ALL_DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/views/${db}`]: {
            view: {
              results: {
                subjSel: { root: true },
                picked: PICKED3,
                fgSubjects: [{ database: COPY, code: 'root', name: 'PET bottle production' }],
                refCode: 'root'
              }
            }
          },
          'POST /api/v1/calc/compare': (body: unknown) => {
            const s = (body as { subjects: { database: string; code: string; label: string }[] }).subjects[0]
            // The copy was changed after the import: three times the original on every indicator.
            const f = s.database === COPY ? 3 : 1
            return {
              methods: PICKED3.map((p) => ({ key: p.key, unit: p.unit, method: p.method })),
              subjects: [
                { label: s.label, code: s.code, scores: Object.fromEntries(PICKED3.map((p) => [p.key, f])) }
              ]
            }
          }
        }
      })

      await user.click(await screen.findByRole('button', { name: /Calculate/ }))
      await waitFor(() =>
        expect(prism.calls.filter((c) => c.path === '/api/v1/calc/compare')).toHaveLength(2)
      )

      // Two rows in the score table (the heatmap is a table too), each with its own numbers.
      await screen.findAllByText(`PET bottle production — ${COPY}`)
      const table = within(document.querySelector<HTMLElement>('table.results-table:not(.heatmap)')!)
      const own = table.getByRole('row', { name: /^PET bottle production 1/ })
      const copy = table.getByRole('row', { name: new RegExp(`PET bottle production — ${COPY}`) })
      expect(within(own).getAllByText(/^1([.,]0+)?$/)).toHaveLength(3)
      expect(within(copy).getAllByText(/^3([.,]0+)?$/)).toHaveLength(3)

      // The radar: the copy's polygon is the copy's, not the original's drawn twice.
      const radar = [...chartOptions]
        .reverse()
        .find((o) => (o.series as { type: string }[] | undefined)?.[0]?.type === 'radar')
      const polys = (radar!.series as { data: { name: string; value: number[] }[] }[])[0].data
      expect(polys.map((d) => d.value)).toEqual([
        [33.3, 33.3, 33.3],
        [100, 100, 100]
      ])

      // Difference mode: exactly one reference — the own model, which the stored `refCode` names.
      const bars = [...chartOptions]
        .reverse()
        .find((o) => (o.series as { type: string }[] | undefined)?.[0]?.type === 'bar')
      const fmt = (bars!.series as { label: { formatter: (p: { dataIndex: number }) => string } }[])[0].label
        .formatter
      expect([fmt({ dataIndex: 0 }), fmt({ dataIndex: 1 })]).toEqual(['ref', '+200%'])
      // The reference picker: one option per subject, and the stored one selected.
      await user.click(screen.getByRole('button', { name: /Chart display/ }))
      const refSelect = (await screen.findByText('Reference')).parentElement!.querySelector('select')!
      expect([...refSelect.options].map((o) => o.value)).toEqual(['root', `${COPY}/root`])
      expect(refSelect.value).toBe('root')
    })

    it('moves colours and a reference stored under a bare foreign code, once and silently', async () => {
      const db = 'fg-res-f'
      const bg = {
        database: 'ecoinvent-3.12',
        code: 'hex',
        name: 'PET granulate',
        geography: 'GLO',
        unit: 'kg',
        amount: 1
      }
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={ALL_DBS} />, {
        routes: {
          ...routes(db),
          [`GET /api/v1/views/${db}`]: {
            view: {
              results: {
                subjSel: { root: true },
                picked: PICKED,
                fgSubjects: [{ database: COPY, code: 'root', name: 'PET bottle production' }],
                bgSubjects: [bg],
                // As an older build stored them: all bare codes.
                colors: { root: '#111111', hex: '#333333' },
                refCode: 'hex'
              }
            }
          }
        }
      })

      await waitFor(
        () => {
          const puts = prism.calls.filter((c) => c.method === 'PUT' && c.path === `/api/v1/views/${db}`)
          expect(puts.length).toBeGreaterThan(0)
          const results = (puts.at(-1)!.body as { view: { results: Record<string, unknown> } }).view.results
          // The own process keeps its bare key (the copy shared it until now, so it gets a copy);
          // the ecoinvent colour and the reference move to database/code.
          expect(results.colors).toEqual({
            root: '#111111',
            [`${COPY}/root`]: '#111111',
            'ecoinvent-3.12/hex': '#333333'
          })
          expect(results.refCode).toBe('ecoinvent-3.12/hex')
          expect(results.subjSel).toEqual({ root: true })
        },
        { timeout: 3000 }
      )
      // The migrated colour is the one the page shows for the database activity.
      const row = screen.getByText('PET granulate').closest('.subjrow')!
      expect((row.querySelector('input[type="color"]') as HTMLInputElement).value).toBe('#333333')
    })

    it('does not migrate the cache when the backend never answered for the view (review P1)', async () => {
      const db = 'fg-res-g'
      window.localStorage.setItem(
        `prism.view.${db}`,
        JSON.stringify({ results: { subjSel: { root: true }, picked: PICKED, refCode: 'hex' } })
      )
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={ALL_DBS} />, {
        routes: { ...routes(db), [`GET /api/v1/views/${db}`]: { status: 500, body: { detail: 'down' } } }
      })
      expect(await screen.findByText('PET bottle production')).toBeInTheDocument()
      await new Promise((r) => setTimeout(r, 700)) // past the 400 ms write debounce
      // Other effects may write (the scenario pruning does); the migration must not have.
      for (const c of prism.calls.filter((x) => x.method === 'PUT')) {
        const results = (c.body as { view: { results?: Record<string, unknown> } }).view.results ?? {}
        expect(results.keys).toBeUndefined()
        expect(results.refCode).toBe('hex')
      }
      window.localStorage.removeItem(`prism.view.${db}`)
    })

    it('a slow view GET is not outrun by the scenario pruning: the migration uses the server colour', async () => {
      // Second review: the cache has an old colour, the server a newer one; the scenario list arrives
      // first and its pruning wrote `scenSel`, which kept the whole cached section over the answer.
      const db = 'fg-res-h'
      const bg = {
        database: 'ecoinvent-3.12',
        code: 'hex',
        name: 'PET granulate',
        geography: 'GLO',
        unit: 'kg',
        amount: 1
      }
      const results = { subjSel: { root: true }, picked: PICKED, bgSubjects: [bg], scenSel: { gone: true } }
      window.localStorage.setItem(
        `prism.view.${db}`,
        JSON.stringify({ results: { ...results, colors: { hex: '#111111' } } })
      )
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={ALL_DBS} />, {
        routes: {
          ...routes(db),
          'GET /api/v1/scenarios': [{ id: 's1', name: 'Recycled PET' }],
          [`GET /api/v1/views/${db}`]: () =>
            new Promise((r) =>
              setTimeout(() => r({ view: { results: { ...results, colors: { hex: '#999999' } } } }), 150)
            )
        }
      })
      await waitFor(
        () => {
          const puts = prism.calls.filter((c) => c.method === 'PUT' && c.path === `/api/v1/views/${db}`)
          const last = (puts.at(-1)?.body as { view: { results: Record<string, unknown> } } | undefined)?.view
            .results
          expect(last?.keys).toBe(2)
          expect(last?.colors).toEqual({ 'ecoinvent-3.12/hex': '#999999' })
          expect(last?.scenSel).toEqual({})
        },
        { timeout: 3000 }
      )
      window.localStorage.removeItem(`prism.view.${db}`)
    })
  })
})
