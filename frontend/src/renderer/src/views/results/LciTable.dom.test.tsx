import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Results from '../Results'
import { LCI_ROWS_SHOWN, LciTable } from './LciTable'
import type { Matrix } from './types'
import { renderWithPrism } from '../../test/render'
import type { Routes } from '../../test/prism'
import { resetQueryCache } from '../../lib/server/useQuery'

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
 * The life cycle inventory at the foot of the Results page: the flows of every subject — here the baseline and
 * a scenario — as one table, folded away until opened, sortable, copyable and exportable, and the same inventory
 * on a second sheet of the page's own Excel export.
 */
const METHOD = { method: ['EF v3.1', 'climate change', 'GWP100'], name: 'GWP100', unit: 'kg CO2-Eq' }
const KEY = METHOD.method.join(' · ')
const PICKED = [
  {
    key: KEY,
    method: METHOD.method,
    family: 'EF v3.1',
    label: 'climate change',
    detail: 'GWP100',
    unit: 'kg'
  }
]
const DBS = [{ name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' }]
const FLOWS = {
  '11': { name: 'Carbon dioxide, fossil', categories: ['air'], unit: 'kilogram' },
  '12': { name: 'Water', categories: ['natural resource', 'in water'], unit: 'cubic meter' },
  '13': { name: 'Lead', categories: ['soil'], unit: 'kilogram' }
}
// The baseline uses water and no lead; the scenario lead and no water.
const INVENTORY: Record<string, Record<string, number>> = {
  baseline: { '11': 1.123456789, '12': 4 },
  efficient: { '11': 0.6, '13': 0.002 }
}

const routes = (db: string): Routes => ({
  [`GET /api/v1/views/${db}`]: {
    view: { results: { subjSel: { root: true }, picked: PICKED, scenSel: { s1: true }, baselineOn: true } }
  },
  'PUT /api/v1/views/:db': { ok: true },
  [`GET /api/v1/model/activities/${db}`]: [{ code: 'root', name: 'PET bottle' }],
  [`GET /api/v1/model/reference/${db}`]: { candidates: [{ code: 'root' }] },
  'GET /api/v1/scenarios': [{ id: 's1', name: 'efficient', overrides: {} }],
  'GET /api/v1/model/tag-groups': { groups: [] },
  'POST /api/v1/calc/compare': (body: unknown) => {
    const s = (body as { subjects: { code: string; label: string; scenario?: string }[] }).subjects[0]
    const inv = INVENTORY[s.scenario ? 'efficient' : 'baseline']
    return {
      methods: [{ key: KEY, unit: 'kg', method: METHOD.method }],
      subjects: [{ label: s.label, code: s.code, scores: { [KEY]: inv['11'] }, inventory: inv }],
      inventory_flows: Object.fromEntries(Object.keys(inv).map((id) => [id, FLOWS[id as keyof typeof FLOWS]]))
    }
  },
  'POST /api/v1/export/lci': { filename: 'prism-lci.xlsx', base64: '' },
  'POST /api/v1/export/compare-matrix': { filename: 'prism-results.xlsx', base64: '' }
})

const writeText = vi.fn(async () => {})
beforeEach(() => {
  resetQueryCache()
  writeText.mockClear()
  // jsdom has no object URLs; the download hand-over only needs the call to exist.
  Object.assign(URL, { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} })
})
afterEach(() => document.querySelectorAll('.copy-note').forEach((n) => n.remove()))

async function calculated(db: string) {
  const user = userEvent.setup()
  const view = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
    routes: routes(db)
  })
  await user.click(await screen.findByRole('button', { name: /Calculate/ }))
  const head = await screen.findByRole('button', { name: /^Life cycle inventory \(LCI\)/ })
  return { user, head, prism: view.prism }
}

const bodyRows = (): string[][] =>
  [...document.querySelectorAll('.lci-table tbody tr')].map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '')
  )

describe('the LCI table on the Results page', () => {
  it('comes with the scores, folded, and opens on a flow × subject table', async () => {
    const { user, head, prism } = await calculated('fg-lci-open')
    // Asked for in the same request as the scores, for every subject.
    const compares = prism.calls.filter((c) => c.path === '/api/v1/calc/compare')
    expect(compares).toHaveLength(2)
    expect(compares.every((c) => (c.body as { inventory?: boolean }).inventory === true)).toBe(true)

    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(head).toHaveTextContent('3 elementary flows')
    expect(document.querySelector('.lci-table')).toBeNull()

    await user.click(head)
    const table = screen.getByRole('table', { name: 'Life cycle inventory' })
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((th) => th.textContent)
    expect(headers).toEqual(['Flow', 'Compartment', 'Unit', 'PET bottle', 'efficient'])
    // Name order, at the app's result rounding; a flow a subject does not exchange is a 0 for it.
    expect(bodyRows()).toEqual([
      ['Carbon dioxide, fossil', 'air', 'kilogram', '1.123', '0.6'],
      ['Lead', 'soil', 'kilogram', '0', '0.002'],
      ['Water', 'natural resource / in water', 'cubic meter', '4', '0']
    ])
  })

  it('sorts by a subject, filters, and copies an amount unrounded', async () => {
    const { user, head } = await calculated('fg-lci-sort')
    await user.click(head)
    await user.click(screen.getByRole('button', { name: 'efficient' }))
    expect(bodyRows().map((r) => r[4])).toEqual(['0', '0.002', '0.6'])
    await user.click(screen.getByRole('button', { name: /^efficient/ }))
    expect(bodyRows().map((r) => r[4])).toEqual(['0.6', '0.002', '0'])

    await user.click(screen.getByRole('button', { name: 'Filter by flow' }))
    await user.type(screen.getByPlaceholderText('Filter flows…'), 'carbon')
    expect(bodyRows()).toHaveLength(1)
    expect(screen.getByText('1 of 3')).toBeInTheDocument()

    // After userEvent's setup, which puts a clipboard of its own on the navigator.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await act(async () => {
      fireEvent.doubleClick(document.querySelector('.lci-table td.lci-amt') as HTMLElement)
    })
    expect(String((writeText.mock.calls[0] as unknown as [string])[0]).replace(',', '.')).toBe('1.123456789')
  })

  it('keeps its filters behind a funnel beside the Flow and Compartment titles', async () => {
    const { user, head } = await calculated('fg-lci-filter')
    await user.click(head)
    // No field until asked for.
    expect(screen.queryByPlaceholderText('Filter flows…')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Compartment filter' })).toBeNull()

    const byFlow = screen.getByRole('button', { name: 'Filter by flow' })
    expect(byFlow).toHaveAttribute('aria-pressed', 'false')
    await user.click(byFlow)
    expect(byFlow).toHaveAttribute('aria-pressed', 'true')
    const field = screen.getByRole('textbox', { name: 'Flow filter' })
    expect(field).toHaveFocus()
    // The name only: "air" is a compartment, and no flow is called so.
    await user.type(field, 'air')
    expect(bodyRows()).toEqual([['No flow matches the filters.']])
    // Escape clears and closes the field and gives the focus back to its funnel.
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'Flow filter' })).toBeNull()
    expect(byFlow).toHaveFocus()
    expect(bodyRows()).toHaveLength(3)

    await user.click(screen.getByRole('button', { name: 'Filter by compartment' }))
    const list = screen.getByRole('combobox', { name: 'Compartment filter' })
    expect(list).toHaveFocus()
    expect([...(list as HTMLSelectElement).options].map((o) => o.text)).toEqual([
      'All compartments',
      'air',
      'natural resource',
      'natural resource / in water',
      'soil'
    ])
    await user.selectOptions(list, 'natural resource')
    expect(bodyRows().map((r) => r[0])).toEqual(['Water'])
    expect(screen.getByRole('button', { name: 'Filter by compartment' })).toHaveClass('active')

    // Both filters at once narrow together; closing a funnel lifts its filter.
    await user.click(byFlow)
    await user.type(screen.getByRole('textbox', { name: 'Flow filter' }), 'carbon')
    expect(bodyRows()).toEqual([['No flow matches the filters.']])
    await user.click(screen.getByRole('button', { name: 'Filter by compartment' }))
    expect(screen.queryByRole('combobox', { name: 'Compartment filter' })).toBeNull()
    expect(bodyRows().map((r) => r[0])).toEqual(['Carbon dioxide, fossil'])
  })

  it('exports the rows as shown, and the page export carries the whole inventory', async () => {
    const { user, head, prism } = await calculated('fg-lci-export')
    await user.click(head)
    await user.click(screen.getByRole('button', { name: 'Filter by flow' }))
    await user.type(screen.getByPlaceholderText('Filter flows…'), 'r') // all but "Lead"
    await user.click(screen.getByRole('button', { name: 'Export LCI' }))
    await waitFor(() => expect(prism.calls.some((c) => c.path === '/api/v1/export/lci')).toBe(true))
    const lci = prism.calls.find((c) => c.path === '/api/v1/export/lci')!.body as {
      subjects: string[]
      flows: { flow: string; amounts: number[] }[]
    }
    expect(lci.subjects).toEqual(['PET bottle', 'efficient'])
    expect(lci.flows.map((f) => [f.flow, f.amounts])).toEqual([
      ['Carbon dioxide, fossil', [1.123456789, 0.6]],
      ['Water', [4, 0]]
    ])

    await user.click(screen.getByRole('button', { name: 'Export Excel' }))
    await waitFor(() =>
      expect(prism.calls.some((c) => c.path === '/api/v1/export/compare-matrix')).toBe(true)
    )
    const book = prism.calls.find((c) => c.path === '/api/v1/export/compare-matrix')!.body as {
      subjects: { label: string }[]
      inventory: { subjects: string[]; flows: { flow: string }[] }
    }
    expect(book.subjects.map((s) => s.label)).toEqual(['PET bottle', 'efficient'])
    expect(book.inventory.subjects).toEqual(['PET bottle', 'efficient'])
    // Not the table's filter: the sheet is the whole inventory.
    expect(book.inventory.flows.map((f) => f.flow)).toEqual(['Carbon dioxide, fossil', 'Lead', 'Water'])
  })

  it('draws the first rows of a long inventory until asked for all, and exports every row', async () => {
    const user = userEvent.setup()
    const n = LCI_ROWS_SHOWN + 30
    const flows: NonNullable<Matrix['flows']> = {}
    for (let i = 0; i < n; i++)
      flows[String(i)] = { name: `Flow ${1000 + i}`, categories: ['air'], unit: 'kg' }
    const inventory = Object.fromEntries(Object.keys(flows).map((id) => [id, Number(id) + 1]))
    const matrix: Matrix = {
      methods: [],
      subjects: [{ label: 'PET bottle', database: 'fg', code: 'root', scores: {}, inventory }],
      flows
    }
    const { prism } = renderWithPrism(<LciTable matrix={matrix} onError={() => {}} />, {
      routes: { 'POST /api/v1/export/lci': { filename: 'prism-lci.xlsx', base64: '' } }
    })
    await user.click(screen.getByRole('button', { name: /^Life cycle inventory/ }))
    expect(bodyRows()).toHaveLength(LCI_ROWS_SHOWN)
    // The sort works on every row: the largest amount comes first although it was not drawn before.
    await user.click(screen.getByRole('button', { name: 'PET bottle' }))
    await user.click(screen.getByRole('button', { name: /^PET bottle/ }))
    expect(bodyRows()[0][0]).toBe(`Flow ${1000 + n - 1}`)

    await user.click(screen.getByRole('button', { name: 'Export LCI' }))
    await waitFor(() => expect(prism.calls.some((c) => c.path === '/api/v1/export/lci')).toBe(true))
    const sent = prism.calls.find((c) => c.path === '/api/v1/export/lci')!.body as { flows: unknown[] }
    expect(sent.flows).toHaveLength(n)

    await user.click(screen.getByRole('button', { name: `Show all ${n}` }))
    expect(bodyRows()).toHaveLength(n)
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull()
  })
})

describe('the page export', () => {
  it('never pairs the inventory of one run with the split of another', async () => {
    const user = userEvent.setup()
    const db = 'fg-lci-split'
    window.localStorage.setItem('prism.ov.stacked', 'true')
    let splits = 0
    const split = (body: unknown) => {
      const s = (body as { subjects: { code: string; label: string }[] }).subjects[0]
      return {
        dimensions: ['isic'],
        keys: { isic: ['C'] },
        labels: { isic: { C: 'Manufacturing' } },
        subjects: [
          {
            label: s.label,
            code: s.code,
            methods: { [KEY]: { total: 1, unit: 'kg', dims: { isic: [{ key: 'C', impact: 1, share: 1 }] } } }
          }
        ]
      }
    }
    try {
      const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
        routes: {
          ...routes(db),
          // The first run's two splits arrive; the second run's fail.
          'POST /api/v1/calc/compare-stacked': (body: unknown) =>
            ++splits <= 2 ? split(body) : { status: 500, body: { detail: 'split failed' } }
        }
      })
      const exported = async () => {
        prism.calls.length = 0
        await user.click(screen.getByRole('button', { name: 'Export Excel' }))
        await waitFor(() =>
          expect(prism.calls.some((c) => c.path === '/api/v1/export/compare-matrix')).toBe(true)
        )
        return prism.calls.find((c) => c.path === '/api/v1/export/compare-matrix')!.body as {
          group_header: string | null
          inventory: unknown
        }
      }
      await user.click(await screen.findByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(splits).toBe(2))
      await screen.findByRole('button', { name: /^Life cycle inventory/ })
      expect((await exported()).group_header).toBe('ISIC classification')

      await user.click(screen.getByRole('button', { name: /Calculate/ }))
      await waitFor(() => expect(splits).toBeGreaterThan(2))
      await screen.findByText(/split failed/)
      // The new scores and inventory go out plain: the first run's split is not theirs.
      const book = await exported()
      expect(book.group_header).toBeNull()
      expect(book.inventory).not.toBeNull()
    } finally {
      window.localStorage.removeItem('prism.ov.stacked')
    }
  })
})
