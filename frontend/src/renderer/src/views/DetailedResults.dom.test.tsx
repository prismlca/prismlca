import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DetailedResults from './DetailedResults'
import { renderWithPrism } from '../test/render'
import type { Routes } from '../test/prism'
import { resetQueryCache } from '../lib/server/useQuery'
import { clearLikeChromium, typeLikeChromium } from '../test/typeNumber'

// The shared query cache outlives a component between mounts (deduplication is the feature);
// these tests assert what one mount loads, so each starts cold.
beforeEach(() => resetQueryCache())

/**
 * Characterisation tests for the contribution-tree page — written before the planned extraction of
 * the 400-line d3 effect into lib/contribTree.ts, so a cut that breaks the wiring (auto-seeded
 * subject, Calculate → tree → auto-loaded flows panel) turns red here first.
 *
 * The d3 tree is real (d3 manipulates jsdom's SVG happily); what is NOT covered is geometry —
 * positions, zoom, the expand/collapse animation — and the Excel/SVG exports.
 */

// jsdom's canvas has no 2D context, and echarts.init would die on it. The fake carries exactly the
// surface the page uses; everything else failing loudly is wanted.
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

// jsdom's SVG elements carry no `transform.baseVal`, and d3-transition reads it when it animates
// the tree cards into place — the read arrives via d3-timer AFTER the assertion, as an uncaught
// exception two stack frames from anything named in the test. A consolidate() answering null makes
// d3-interpolate fall back to the identity transform, which is all a non-visual test needs.
if (!Object.getOwnPropertyDescriptor(SVGElement.prototype, 'transform')) {
  Object.defineProperty(SVGElement.prototype, 'transform', {
    get: () => ({ baseVal: { consolidate: () => null } })
  })
}

const METHOD = {
  method: ['EF v3.1', 'climate change', 'GWP100'],
  name: 'climate change',
  unit: 'kg CO2-Eq'
}

const TREE = {
  db: 'fg-tree-a',
  c: 'root',
  n: 'Solar lamp production',
  g: 'GLO',
  a: 1,
  u: 'unit',
  imp: 10,
  dir: 2,
  shr: 1,
  ch: [
    {
      db: 'ecoinvent-3.12',
      c: 'alu',
      n: 'aluminium ingot',
      g: 'GLO',
      a: 0.4,
      u: 'kg',
      imp: 6,
      dir: 6,
      shr: 0.6
    }
  ]
}

const CONTRIB = {
  meta: {
    database: 'fg-tree-a',
    method: METHOD.method,
    total: 10,
    unit: 'kg CO2-Eq',
    direct: 2,
    upstream: 8,
    n_nodes: 2,
    cutoff: 0.005,
    max_depth: 8
  },
  lookups: {},
  tree: TREE
}

const FLOWS = {
  unit: 'kg CO2-Eq',
  total: 10,
  count: 2,
  flows: [
    { flow: 'Carbon dioxide, fossil', categories: ['air'], unit: 'kg', impact: 9, share: 0.9 },
    { flow: 'Methane, fossil', categories: ['air'], unit: 'kg', impact: 1, share: 0.1 }
  ]
}

const routes = (db: string): Routes => ({
  [`GET /api/v1/views/${db}`]: { view: {} },
  'PUT /api/v1/views/:db': { ok: true },
  [`GET /api/v1/model/activities/${db}`]: [{ code: 'root', name: 'Solar lamp production' }],
  [`GET /api/v1/model/reference/${db}`]: {
    candidates: [{ code: 'root', name: 'Solar lamp production' }]
  },
  'GET /api/v1/scenarios': [],
  'GET /api/v1/model/tag-groups': { groups: [] }
})

const DBS = [{ name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' }]

describe('DetailedResults', () => {
  it('opens on the reference process and the first method family, ready to calculate', async () => {
    renderWithPrism(<DetailedResults activeDb="fg-tree-a" methods={[METHOD]} databases={DBS} />, {
      routes: routes('fg-tree-a')
    })

    // The subject is seeded from /model/reference — a page opening on nothing is a decision with
    // no information in it.
    expect((await screen.findAllByText(/Solar lamp production/)).length).toBeGreaterThan(0)
    expect(await screen.findByText('Ready — click Calculate.')).toBeInTheDocument()
  })

  it('Calculate builds the tree and auto-loads the elementary-flows panel for it', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(
      <DetailedResults activeDb="fg-tree-a" methods={[METHOD]} databases={DBS} />,
      {
        routes: {
          ...routes('fg-tree-a'),
          'POST /api/v1/calc/contribution': CONTRIB,
          'POST /api/v1/calc/elementary-flows': FLOWS
        }
      }
    )

    await user.click(await screen.findByRole('button', { name: /Calculate/ }))

    await waitFor(() => {
      const run = prism.calls.find((c) => c.path === '/api/v1/calc/contribution')
      expect(run?.body).toMatchObject({ database: 'fg-tree-a', code: 'root', method: METHOD.method })
    })

    // The d3 tree draws its cards into the SVG — the child dataset's name is the proof the tree
    // actually rendered, not merely that data arrived.
    await waitFor(() => expect(document.body.textContent).toContain('aluminium ingot'))

    // The flows panel loads by itself for the whole system once a tree stands.
    await waitFor(() => {
      const flowsCall = prism.calls.find((c) => c.path === '/api/v1/calc/elementary-flows')
      expect(flowsCall?.body).toMatchObject({ code: 'root', raw_demand: true })
    })
    expect(await screen.findByText('Carbon dioxide, fossil')).toBeInTheDocument()
    expect(screen.getByText('Methane, fossil')).toBeInTheDocument()
  })

  it('a failed calculation shows the backend message instead of a silent empty page', async () => {
    const user = userEvent.setup()
    renderWithPrism(<DetailedResults activeDb="fg-tree-b" methods={[METHOD]} databases={DBS} />, {
      routes: {
        ...routes('fg-tree-b'),
        'POST /api/v1/calc/contribution': {
          status: 400,
          body: { error: { message: 'The demand vector is empty.' } }
        }
      }
    })

    await user.click(await screen.findByRole('button', { name: /Calculate/ }))
    expect(await screen.findByText(/demand vector is empty/)).toBeInTheDocument()
  })

  it('ticks several variants, computes each one and draws them as grouped bars', async () => {
    const user = userEvent.setup()
    const scenarios = [
      { id: 'sc-1', name: 'More recycling', database: 'fg-tree-a', overrides: {} },
      { id: 'sc-2', name: 'Shorter transport', database: 'fg-tree-a', overrides: {} }
    ]
    const { prism } = renderWithPrism(
      <DetailedResults activeDb="fg-tree-a" methods={[METHOD]} databases={DBS} />,
      {
        routes: {
          ...routes('fg-tree-a'),
          'GET /api/v1/scenarios': scenarios,
          'GET /api/v1/model/tag-groups': {
            groups: [{ name: 'Phase', values: ['Make'], databases: ['fg-tree-a'] }]
          },
          'POST /api/v1/calc/contribution': {
            ...CONTRIB,
            aggregation: { dimension: 'tag:Phase', groups: [{ key: 'Make', impact: 10, share: 1 }] }
          },
          'POST /api/v1/calc/elementary-flows': FLOWS
        }
      }
    )
    // Baseline is ticked from the start; a scenario joins it rather than replacing it.
    await user.click(await screen.findByLabelText('More recycling'))
    await user.click(await screen.findByRole('button', { name: /Calculate/ }))
    await waitFor(() => {
      const runs = prism.calls.filter((c) => c.path === '/api/v1/calc/contribution')
      expect(runs.map((r) => (r.body as { scenario?: string }).scenario)).toEqual([undefined, 'sc-1'])
    })
    // Two variants: the breakdown panel is the grouped chart, named for what it compares.
    expect(await screen.findByText(/Totals of 2 variants|Contribution by/)).toBeInTheDocument()
    // Unticking the baseline leaves the scenario as the tree's variant.
    await user.click(screen.getByLabelText('Baseline'))
    await waitFor(() => expect(screen.getByText(/Scenario: More recycling/)).toBeInTheDocument())
  })
})

describe('DetailedResults → number fields', () => {
  it('takes a decimal cutoff and a depth typed after emptying the field', async () => {
    const user = userEvent.setup()
    renderWithPrism(<DetailedResults activeDb="fg-tree-a" methods={[METHOD]} databases={DBS} />, {
      routes: routes('fg-tree-a')
    })
    await screen.findByText('Ready — click Calculate.')
    await user.click(screen.getByRole('button', { name: /^Calculation/ })) // the group starts folded
    const cutoff = screen.getByLabelText('Cutoff (%)') as HTMLInputElement
    clearLikeChromium(cutoff)
    typeLikeChromium(cutoff, '2.5')
    expect(cutoff).toHaveValue(2.5)
    const depth = screen.getByLabelText('Max depth')
    await user.clear(depth)
    await user.type(depth, '5')
    await user.tab()
    expect(depth).toHaveValue(5)
  })
})
