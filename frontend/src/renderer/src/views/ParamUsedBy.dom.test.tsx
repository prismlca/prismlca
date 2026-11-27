import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Parameters from './Parameters'
import { renderWithPrism } from '../test/render'

/**
 * The "Used by" column: a process is a jump to the canvas, a parameter a jump to its own row on this page.
 * The second used to be a plain label — "used by mass" with no way to get to mass, which on a long page sat
 * in a folded group three screens down.
 */
const base = { amount: 1, formula: null, description: null, unit: null, rule: {}, used_by: [] }
const PARAMS = [
  {
    ...base,
    name: 'density',
    group_id: 'g1',
    group: 'Materials',
    description: 'From the datasheet.',
    used_by_parameters: [{ name: 'mass', formula: 'volume * density' }]
  },
  {
    ...base,
    name: 'mass',
    amount: 2,
    formula: 'volume * density',
    group_id: 'g2',
    group: 'Geometry',
    used_by: [{ activity_code: 'b1', activity_name: 'bottle', input: 'PET', formula: 'mass' }],
    used_by_parameters: []
  },
  {
    ...base,
    name: 'volume',
    amount: 2,
    group_id: 'g2',
    group: 'Geometry',
    used_by_parameters: [
      { name: 'mass', formula: 'volume * density' },
      { name: 'elsewhere', formula: 'volume * 3' }
    ]
  }
]
const ROUTES = {
  'GET /api/v1/params': PARAMS,
  'GET /api/v1/params/groups': [
    { id: 'g1', name: 'Materials', order: 0 },
    { id: 'g2', name: 'Geometry', order: 1 }
  ],
  'GET /api/v1/model/audit': []
}

const row = (container: HTMLElement, name: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`.pc-name[title="${name}"]`)?.closest('.prow-item') ?? null

describe('a parameter in "Used by"', () => {
  it('unfolds the group of the parameter it names, lights its row and moves the focus there', async () => {
    const user = userEvent.setup()
    const { container } = renderWithPrism(<Parameters activeDb="M" />, { routes: ROUTES })
    // A first visit opens the first group only: mass sits in the folded second one.
    const link = await screen.findByRole('button', { name: 'Show parameter mass' })
    expect(row(container, 'mass')).toBeNull()

    await user.click(link)

    const target = await waitFor(() => {
      const el = row(container, 'mass')
      if (!el) throw new Error('mass is not on screen')
      return el
    })
    expect(target.className).toContain('spot')
    expect(document.activeElement).toBe(target)
    expect(screen.getByRole('button', { name: 'Collapse Geometry' }).getAttribute('aria-expanded')).toBe(
      'true'
    )
  })

  it('stays lit while you click inside its row, and goes out at the next click elsewhere', async () => {
    const user = userEvent.setup()
    const { container } = renderWithPrism(<Parameters activeDb="M" />, { routes: ROUTES })
    await user.click(await screen.findByRole('button', { name: 'Show parameter mass' }))
    const target = await waitFor(() => row(container, 'mass')!)

    await user.click(target.querySelector('.pc-formula')!)
    expect(target.className).toContain('spot')

    await user.click(screen.getByPlaceholderText('Search parameters…'))
    expect(target.className).not.toContain('spot')
    // The group stays open: it was opened for you, and folding it again under you would lose the row.
    expect(row(container, 'mass')).not.toBeNull()
  })

  it('clears a search that hides the parameter it names', async () => {
    const user = userEvent.setup()
    const { container } = renderWithPrism(<Parameters activeDb="M" />, { routes: ROUTES })
    const search = await screen.findByPlaceholderText('Search parameters…')
    await user.type(search, 'datasheet')
    await waitFor(() => expect(row(container, 'volume')).toBeNull())

    await user.click(screen.getByRole('button', { name: 'Show parameter mass' }))

    expect(search).toHaveValue('')
    await waitFor(() => expect(row(container, 'mass')?.className).toContain('spot'))
  })

  it('lights the next parameter when one lit row links on', async () => {
    const user = userEvent.setup()
    const { container } = renderWithPrism(<Parameters activeDb="M" />, { routes: ROUTES })
    await user.click(await screen.findByRole('button', { name: 'Expand Geometry' }))
    const links = await screen.findAllByRole('button', { name: 'Show parameter mass' })
    await user.click(links[1]) // from volume's row
    await waitFor(() => expect(row(container, 'mass')?.className).toContain('spot'))

    await user.click(links[0]) // from density's row: the light moves, it does not double
    expect(container.querySelectorAll('.prow-item.spot')).toHaveLength(1)
    expect(row(container, 'mass')?.className).toContain('spot')
  })

  it('is no link when this page does not have the parameter it names', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Parameters activeDb="M" />, { routes: ROUTES })
    await user.click(await screen.findByRole('button', { name: 'Expand Geometry' }))
    expect(await screen.findByRole('button', { name: 'Show parameter elsewhere' })).toBeDisabled()
  })
})

describe('a process in "Used by"', () => {
  it('still jumps to the canvas', async () => {
    const user = userEvent.setup()
    const jump = vi.fn()
    renderWithPrism(<Parameters activeDb="M" onJumpToProcess={jump} />, { routes: ROUTES })
    await user.click(await screen.findByRole('button', { name: 'Expand Geometry' }))
    await user.click(await screen.findByRole('button', { name: /^bottle/ }))
    expect(jump).toHaveBeenCalledWith('b1')
  })
})
