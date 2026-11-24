import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Scenarios from './Scenarios'
import { renderWithPrism } from '../test/render'
import type { RouteHandler } from '../test/prism'

/**
 * Editing a scenario writes through after a short debounce, and closing the dialog sends an edit that
 * is still waiting. Each edit must reach the backend exactly once: a second identical write is a second
 * audit line and a second undo step, and the first Undo then appears to do nothing.
 */
const PARAMS = [
  {
    name: 'mass',
    amount: 2,
    formula: null,
    group_id: null,
    group: null,
    description: null,
    unit: 'kg',
    rule: {}
  }
]
const ROUTES = {
  'GET /api/v1/scenarios': [
    { id: 's1', name: 'heavy', description: '', overrides: { mass: 4 }, database: 'M' }
  ],
  'GET /api/v1/params': PARAMS,
  'GET /api/v1/params/groups': [],
  'GET /api/v1/model/audit': [],
  'POST /api/v1/scenarios/update': {}
}

type Call = { method: string; path: string; body?: unknown }
const updates = (calls: Call[]): Call[] =>
  calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/scenarios/update')

/** Open the editor on the one scenario. */
async function openEditor(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const [edit] = await screen.findAllByRole('button', { name: 'Edit scenario' })
  await user.click(edit!)
  return screen.findByRole('dialog', { name: 'Edit scenario' })
}

/** Open the editor on the one scenario and type a new override value. */
async function editOverride(
  value: string,
  update: RouteHandler | object = {}
): Promise<{ user: ReturnType<typeof userEvent.setup>; calls: Call[] }> {
  const user = userEvent.setup()
  const { prism, container } = renderWithPrism(<Scenarios activeDb="M" rev={0} />, {
    routes: { ...ROUTES, 'POST /api/v1/scenarios/update': update }
  })
  const dialog = await openEditor(user)
  const field = await within(dialog).findByPlaceholderText('number or formula')
  await user.clear(field)
  await user.type(field, value)
  expect(container.querySelector('.modal-backdrop')).not.toBeNull()
  return { user, calls: prism.calls }
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('Scenario editor stores one edit once', () => {
  const closers: [string, (user: ReturnType<typeof userEvent.setup>) => Promise<void>][] = [
    ['Escape', (user) => user.keyboard('{Escape}')],
    [
      'the Close button',
      (user) =>
        user.click(
          within(document.querySelector<HTMLElement>('.sheet-foot')!).getByRole('button', { name: 'Close' })
        )
    ],
    ['the ✕', (user) => user.click(document.querySelector<HTMLButtonElement>('.sheet-x')!)],
    [
      'a click beside the sheet',
      (user) => user.click(document.querySelector<HTMLElement>('.modal-backdrop')!)
    ]
  ]

  for (const [how, close] of closers) {
    it(`closing with ${how} after the debounce has written adds no second write`, async () => {
      const { user, calls } = await editOverride('6')
      await waitFor(() => expect(updates(calls)).toHaveLength(1))

      await close(user)
      await waitFor(() => expect(document.querySelector('.modal-backdrop')).toBeNull())
      await settle(500)
      expect(updates(calls)).toHaveLength(1)
    })
  }

  it('closing within the debounce writes the edit, once', async () => {
    const { user, calls } = await editOverride('6')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.querySelector('.modal-backdrop')).toBeNull())

    expect(updates(calls)).toHaveLength(1)
    expect((updates(calls)[0]!.body as { overrides: unknown }).overrides).toEqual({ mass: 6 })
    await settle(500) // the debounce timer must not fire after the flush
    expect(updates(calls)).toHaveLength(1)
  })

  const refused = { status: 500, body: { detail: 'The backend is not ready.' } }

  it('a debounced write that failed is tried once more on closing', async () => {
    let n = 0
    const { user, calls } = await editOverride('6', () => (++n === 1 ? refused : {}))
    await waitFor(() => expect(updates(calls)).toHaveLength(1))
    await screen.findByText(/not ready/)

    await user.keyboard('{Escape}')
    await waitFor(() => expect(updates(calls)).toHaveLength(2))
    expect((updates(calls)[1]!.body as { overrides: unknown }).overrides).toEqual({ mass: 6 })
    await settle(500)
    expect(updates(calls)).toHaveLength(2)
  })

  it('a write that failed after closing is not sent again by the next editor', async () => {
    const { user, calls } = await editOverride('6', () => refused)
    await waitFor(() => expect(updates(calls)).toHaveLength(1))
    await screen.findByText(/not ready/)
    await user.keyboard('{Escape}') // the retry, which fails as well — after the dialog has closed
    await waitFor(() => expect(updates(calls)).toHaveLength(2))
    await settle(100)

    await openEditor(user)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(document.querySelector('.modal-backdrop')).toBeNull())
    await settle(500)
    expect(updates(calls)).toHaveLength(2)
  })
})
