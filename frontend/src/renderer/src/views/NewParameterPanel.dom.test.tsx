import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Parameters from './Parameters'
import { renderWithPrism } from '../test/render'

/**
 * The add form creates and never edits. Its route is an upsert, so "Add parameter" with `mass` typed into
 * it, while `mass` existed, replaced the value and the allowed values without a word.
 */
const M_PVC = {
  name: 'm_pvc',
  amount: 3.95,
  formula: null,
  group_id: null,
  group: null,
  description: null,
  unit: 'kg',
  rule: { kind: 'positive' }
}
const ROUTES = {
  'GET /api/v1/params': [M_PVC],
  'GET /api/v1/params/groups': [],
  'GET /api/v1/model/audit': [],
  'POST /api/v1/params': {}
}

const posts = (prism: { calls: { method: string; path: string }[] }): unknown[] =>
  prism.calls.filter((c) => c.method === 'POST' && c.path === '/api/v1/params')

async function openForm(user: ReturnType<typeof userEvent.setup>): Promise<HTMLInputElement> {
  await user.click(await screen.findByRole('button', { name: 'Parameter' }))
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' })
}

describe('the add form', () => {
  it('refuses a name the model already has, before anything is sent', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Parameters activeDb="M" />, { routes: ROUTES })
    await screen.findByTitle('m_pvc')
    const name = await openForm(user)

    await user.type(name, ' m_pvc ')
    await user.type(screen.getByRole('textbox', { name: 'Value' }), '7')

    expect(
      screen.getByText('“m_pvc” already exists — edit it in its row, or choose another name.')
    ).toBeTruthy()
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add parameter' }).disabled).toBe(true)
    await user.type(name, '{Enter}')
    expect(posts(prism)).toEqual([])
  })

  it('creates a free name, and says so to the backend', async () => {
    const user = userEvent.setup()
    const { prism } = renderWithPrism(<Parameters activeDb="M" />, { routes: ROUTES })
    const name = await openForm(user)

    await user.type(name, 'mass')
    await user.type(screen.getByRole('textbox', { name: 'Value' }), '2')
    await user.click(screen.getByRole('button', { name: 'Add parameter' }))

    await waitFor(() =>
      expect(posts(prism)).toEqual([
        {
          method: 'POST',
          path: '/api/v1/params',
          body: { database: 'M', name: 'mass', amount: 2, rule: {}, create: true }
        }
      ])
    )
  })

  it('reloads the list when the backend knows the name and the list did not yet', async () => {
    // Another writer — the assistant, an MCP client — created `mass` after the page read its list.
    let list: unknown[] = [M_PVC]
    const user = userEvent.setup()
    renderWithPrism(<Parameters activeDb="M" />, {
      routes: {
        ...ROUTES,
        'GET /api/v1/params': () => list,
        'POST /api/v1/params': () => {
          list = [M_PVC, { ...M_PVC, name: 'mass', amount: 2 }]
          return {
            status: 409,
            body: {
              error: {
                code: 'param_exists',
                message: "Parameter 'mass' already exists.",
                hint: 'Edit the existing parameter instead, or choose another name.'
              }
            }
          }
        }
      }
    })
    const name = await openForm(user)

    await user.type(name, 'mass')
    await user.click(screen.getByRole('button', { name: 'Add parameter' }))

    expect(
      await screen.findByText('“mass” already exists — edit it in its row, or choose another name.')
    ).toBeTruthy()
    expect(screen.getByText(/Parameter 'mass' already exists\./)).toBeTruthy()
    expect(screen.getByTitle('mass')).toBeTruthy()
  })
})
