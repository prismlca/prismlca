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
 * Comparison models linked in the Info dialog or the chat are offered on the Results page: unticked
 * under "Other models", and one tick adds the linked model's reference process to the comparison.
 */
const METHOD = { method: ['EF v3.1', 'climate change', 'GWP100'], name: 'climate change', unit: 'kg CO2-Eq' }
const LINKED = 'fg-linked-glass'
const DBS = [
  { name: 'ecoinvent-3.12', node_count: 26000, read_only: true, kind: 'background' },
  { name: LINKED, node_count: 3, read_only: false, kind: 'foreground' },
  { name: 'fg-linked-unrelated', node_count: 3, read_only: false, kind: 'foreground' }
]

const routes = (db: string, view: Record<string, unknown> = {}): Routes => ({
  [`GET /api/v1/views/${db}`]: { view: { results: { subjSel: { root: true }, ...view } } },
  'PUT /api/v1/views/:db': { ok: true },
  [`GET /api/v1/model/activities/${db}`]: [{ code: 'root', name: 'PET bottle production' }],
  [`GET /api/v1/model/reference/${db}`]: { candidates: [{ code: 'root' }] },
  [`GET /api/v1/model/reference/${LINKED}`]: {
    candidates: [
      { code: 'g-root', name: 'Glass bottle production' },
      { code: 'g-cap', name: 'Cap' }
    ]
  },
  // The study names the linked model, and one that no longer exists (the link outlived it).
  'GET /api/v1/study': { compared_with: [LINKED, 'fg-deleted-model'] },
  'GET /api/v1/scenarios': [],
  'GET /api/v1/model/tag-groups': { groups: [] }
})

const rail = () => within(document.querySelector<HTMLElement>('.results-rail')!)
const storedFg = (calls: { method: string; path: string; body?: unknown }[], db: string) =>
  (
    calls.filter((c) => c.method === 'PUT' && c.path === `/api/v1/views/${db}`).at(-1)?.body as
      | { view: { results: { fgSubjects?: unknown } } }
      | undefined
  )?.view.results.fgSubjects

describe('linked comparison models on the Results page', () => {
  it('are offered unticked, and a tick adds the reference process', async () => {
    const user = userEvent.setup()
    const db = 'fg-linked-a'
    const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
      routes: routes(db)
    })
    const offer = await rail().findByRole('checkbox', { name: new RegExp(LINKED) })
    expect(offer).not.toBeChecked()
    // Neither the deleted model nor an unlinked one is offered.
    expect(rail().queryByText('fg-deleted-model')).toBeNull()
    expect(rail().queryByText('fg-linked-unrelated')).toBeNull()

    await user.click(offer)
    await waitFor(() =>
      expect(storedFg(prism.calls, db)).toEqual([
        { database: LINKED, code: 'g-root', name: 'Glass bottle production' }
      ])
    )
    // Now an ordinary other-model row, ticked; the offer is gone.
    expect(await rail().findByText('Glass bottle production')).toBeInTheDocument()
    expect(rail().queryByRole('checkbox', { name: new RegExp(`${LINKED}\\s*linked`) })).toBeNull()
  })

  it('are not offered again while the model is in the list, ticked or not', async () => {
    const db = 'fg-linked-b'
    renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
      routes: routes(db, {
        fgSubjects: [{ database: LINKED, code: 'g-cap', name: 'Cap', enabled: false }]
      })
    })
    expect(await rail().findByText('Cap')).toBeInTheDocument()
    expect(screen.queryByText('linked')).toBeNull()
  })

  it('waits for the stored view before offering, so a pick cannot replace the stored entries', async () => {
    const user = userEvent.setup()
    const db = 'fg-linked-c'
    const saved = { database: 'fg-linked-unrelated', code: 'u-root', name: 'Unrelated product' }
    let answer: () => void = () => {}
    const viewOut = new Promise<void>((r) => (answer = r))
    const { prism } = renderWithPrism(<Results activeDb={db} methods={[METHOD]} databases={DBS} />, {
      routes: {
        ...routes(db),
        [`GET /api/v1/views/${db}`]: () =>
          viewOut.then(() => ({ view: { results: { subjSel: { root: true }, fgSubjects: [saved] } } }))
      }
    })
    // The study has answered and the view has not: nothing to tick yet.
    await waitFor(() => expect(prism.calls.some((c) => c.path.startsWith('/api/v1/study'))).toBe(true))
    await new Promise((r) => setTimeout(r, 50))
    expect(rail().queryByRole('checkbox', { name: new RegExp(LINKED) })).toBeNull()

    answer()
    await user.click(await rail().findByRole('checkbox', { name: new RegExp(LINKED) }))
    await waitFor(() =>
      expect(storedFg(prism.calls, db)).toEqual([
        saved,
        { database: LINKED, code: 'g-root', name: 'Glass bottle production' }
      ])
    )
  })
})
