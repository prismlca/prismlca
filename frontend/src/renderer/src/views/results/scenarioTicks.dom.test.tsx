import { beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import Results from '../Results'
import { renderWithPrism } from '../../test/render'
import type { Routes } from '../../test/prism'
import { fetchQuery, resetQueryCache } from '../../lib/server/useQuery'
import { invalidateModelCaches } from '../../lib/server/modelCaches'
import { scenariosRoute } from '../../lib/server/routes'
import { viewLoaded, viewSet, viewSync } from '../../lib/modelView'

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
 * Scenario ticks on the Results page are pruned against the model's scenario list — and only against a
 * list the cache vouches for. The shared cache keeps a list it has marked stale on show until the
 * refetch lands, so the rail does not blink; a page mounting in that moment used to prune against the
 * old list. That is how an assistant's `setup_results` lost its ticks: another page had read the list
 * of a new model while it was still empty, the assistant then created the scenarios (each edit marks
 * the list stale, nobody refetched it), wrote ten ticks and opened the page — which pruned all ten
 * against the empty list and computed the baseline alone.
 */
const METHOD = { method: ['EF v3.1', 'climate change', 'GWP100'], name: 'climate change', unit: 'kg CO2-Eq' }
const PICKED = [
  {
    key: METHOD.method.join(' · '),
    method: METHOD.method,
    family: 'EF v3.1',
    label: 'climate change',
    detail: 'GWP100',
    unit: 'kg CO2-Eq'
  }
]
const DBS = [{ name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' }]
const S1 = { id: 's1', name: 'Recycled PET', overrides: {} }
const S2 = { id: 's2', name: 'Light bottle', overrides: {} }

/** A backend that keeps the view it is sent and lists whatever scenarios the model has right now. */
function backend(db: string, scenarios: { id: string; name: string }[]) {
  let view: Record<string, unknown> = {}
  const state = { scenarios }
  const routes: Routes = {
    [`GET /api/v1/views/${db}`]: () => ({ view }),
    [`PUT /api/v1/views/${db}`]: (body: unknown) => {
      view = { ...view, ...(body as { view: Record<string, unknown> }).view }
      return { ok: true }
    },
    [`GET /api/v1/model/activities/${db}`]: [{ code: 'root', name: 'Bathroom cleaner, use' }],
    [`GET /api/v1/model/reference/${db}`]: { candidates: [{ code: 'root' }] },
    'GET /api/v1/scenarios': () => state.scenarios,
    'GET /api/v1/model/tag-groups': { groups: [] },
    'POST /api/v1/calc/compare': (body: unknown) => {
      const b = body as { subjects: { code: string; label: string }[]; methods: string[][] }
      return {
        methods: b.methods.map((m) => ({ key: m.join(' · '), unit: 'u', method: m })),
        subjects: [{ label: b.subjects[0].label, code: b.subjects[0].code, scores: { [PICKED[0].key]: 1 } }]
      }
    }
  }
  return { routes, state, stored: () => view.results as Record<string, unknown> | undefined }
}

/** What `setup_results` writes (workbench/useAiCanvasTools.ts): one merge into the stored section per
 *  part of the call, after waiting for the backend's view. */
async function setupResults(db: string, scenSel: Record<string, boolean>) {
  expect(await viewLoaded(db)).toBe(true)
  const results = () => (viewSync(db).results as Record<string, unknown> | undefined) ?? {}
  viewSet(db, 'results', { ...results(), picked: PICKED })
  viewSet(db, 'results', { ...results(), subjSel: { root: true }, scenSel, baseline: true })
  viewSet(db, 'results', { ...results(), runRequested: Date.now() })
}

const compared = (calls: { path: string; body?: unknown }[]) =>
  calls
    .filter((c) => c.path === '/api/v1/calc/compare')
    .map((c) => (c.body as { subjects: { scenario?: string }[] }).subjects[0].scenario ?? 'baseline')

describe('scenario ticks against a scenario list marked stale', () => {
  it("survive when the page opens on a list read before the scenarios existed (setup_results' ticks)", async () => {
    const db = 'fg-ticks-new-model'
    const be = backend(db, [])
    // The app is open on another page; the Results page is not mounted yet.
    const { prism, rerender } = renderWithPrism(<div />, { routes: be.routes })
    // Another page (the report's scope card) read the new model's scenario list: none yet.
    expect(await fetchQuery(scenariosRoute(db))).toEqual([])
    // The assistant creates the scenarios; each of its edits marks the model's caches stale.
    be.state.scenarios = [S1, S2]
    invalidateModelCaches()
    await setupResults(db, { s1: true, s2: true })
    // `run: true` opens the page for the first time.
    rerender(<Results activeDb={db} methods={[METHOD]} databases={DBS} />)
    await waitFor(() => expect(compared(prism.calls)).toHaveLength(3), { timeout: 3000 })
    expect(compared(prism.calls)).toEqual(['baseline', 's1', 's2'])
    // The assistant's next call is an audited edit: the caches go stale once more.
    invalidateModelCaches()
    await new Promise((r) => setTimeout(r, 600)) // past the 400 ms write pause
    expect((viewSync(db).results as Record<string, unknown>).scenSel).toEqual({ s1: true, s2: true })
    expect(be.stored()?.scenSel).toEqual({ s1: true, s2: true })
    expect(be.stored()?.baseline).toBe(true)
  })

  it('a scenario deleted meanwhile still loses its tick, also when the stale list still names it', async () => {
    const db = 'fg-ticks-deleted'
    const be = backend(db, [S1, S2])
    const { prism, rerender } = renderWithPrism(<div />, { routes: be.routes })
    expect(await fetchQuery(scenariosRoute(db))).toEqual([S1, S2])
    await setupResults(db, { s1: true, s2: true })
    // s2 is deleted after the list was read, and nobody has read it since.
    be.state.scenarios = [S1]
    invalidateModelCaches()
    rerender(<Results activeDb={db} methods={[METHOD]} databases={DBS} />)
    await waitFor(() => expect(be.stored()?.scenSel).toEqual({ s1: true }), { timeout: 3000 })
    await waitFor(() => expect(compared(prism.calls)).toEqual(['baseline', 's1']), { timeout: 3000 })
  })
})
