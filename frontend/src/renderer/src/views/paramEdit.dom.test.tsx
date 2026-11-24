import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Parameters from './Parameters'
import { renderWithPrism } from '../test/render'

/**
 * The two keys every editable cell in this table answers to.
 *
 * Escape was **writing the value it was supposed to abandon** (the
 * model rename had the same defect): the handler sets the state back and blurs, the browser
 * fires focusout synchronously, and the commit that runs on it still closes over the abandoned text.
 * So typing 9.99 into a parameter and pressing Escape posted 9.99 — and the field then showed the old
 * value again, which is the worst version of it: the number on screen was not the number in the model.
 */
const PARAMS = [
  {
    name: 'm_pvc',
    amount: 3.95,
    formula: null,
    group_id: 'g1',
    group: 'Masses',
    description: null,
    unit: 'kg',
    rule: {}
  }
]
const ROUTES = {
  'GET /api/v1/params': PARAMS,
  'GET /api/v1/params/groups': [{ id: 'g1', name: 'Masses', order: 0 }],
  'GET /api/v1/model/audit': [],
  'POST /api/v1/params': {}
}

const valueField = (container: HTMLElement): Promise<HTMLInputElement> =>
  waitFor(() => {
    const el = container.querySelector<HTMLInputElement>('.pc-val input')
    if (!el) throw new Error('no value field')
    return el
  })

/** A formula-driven parameter: the backend hands back whatever the arithmetic produced. */
const COMPUTED = [
  {
    name: 'share',
    amount: 0.30000000000000004,
    formula: '0.1 + 0.2',
    group_id: 'g1',
    group: 'Masses',
    description: null,
    unit: null,
    rule: {}
  }
]

describe('a computed value', () => {
  it('is displayed rounded and carries the full number as its title', async () => {
    const { container } = renderWithPrism(<Parameters activeDb="M" />, {
      routes: { ...ROUTES, 'GET /api/v1/params': COMPUTED }
    })
    const shown = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('.pc-computed span[title]')
      if (!el) throw new Error('no computed value')
      return el
    })
    // Six significant digits — the default of the Parameters setting this display follows.
    expect(shown.textContent).toBe('0.3')
    expect(shown.title).toBe('0.30000000000000004')
  })
})

describe('editing a parameter value', () => {
  it('writes nothing when the edit is abandoned with Escape', async () => {
    const user = userEvent.setup()
    const { prism, container } = renderWithPrism(<Parameters activeDb="M" />, { routes: ROUTES })
    const field = await valueField(container)

    await user.clear(field)
    await user.type(field, '9.99{Escape}')

    expect(field.value).toBe('3.95')
    expect(prism.calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('writes the value on Enter', async () => {
    const user = userEvent.setup()
    const { prism, container } = renderWithPrism(<Parameters activeDb="M" />, { routes: ROUTES })
    const field = await valueField(container)

    await user.clear(field)
    await user.type(field, '4.25{Enter}')

    await waitFor(() =>
      expect(prism.calls).toEqual(
        expect.arrayContaining([
          {
            method: 'POST',
            path: '/api/v1/params',
            body: { database: 'M', name: 'm_pvc', amount: 4.25, unit: 'kg', description: '' }
          }
        ])
      )
    )
  })
})

describe('a long description (V430)', () => {
  const LONG =
    'Density from the datasheets: ' + 'https://example.com/datasheet/silicone-sealant.pdf '.repeat(4)
  it('is clamped with a keyboard-reachable "more" toggle that opens the full text', async () => {
    const { container } = renderWithPrism(<Parameters activeDb="M" />, {
      routes: { ...ROUTES, 'GET /api/v1/params': [{ ...PARAMS[0], description: LONG }] }
    })
    const text = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('.pc-desc-text')
      if (!el) throw new Error('no description')
      return el
    })
    expect(text.className).not.toContain('open')
    expect(text.getAttribute('title')).toBe(LONG)
    const more = container.querySelector<HTMLButtonElement>('.pc-desc-more')!
    expect(more.getAttribute('aria-expanded')).toBe('false')
    more.focus()
    await userEvent.keyboard('{Enter}')
    expect(text.className).toContain('open')
    expect(more.getAttribute('aria-expanded')).toBe('true')
    expect(more.textContent).toBe('less')
  })

  it('shows no toggle for a short description', async () => {
    const { container } = renderWithPrism(<Parameters activeDb="M" />, {
      routes: { ...ROUTES, 'GET /api/v1/params': [{ ...PARAMS[0], description: 'Wet mass per cartridge.' }] }
    })
    await waitFor(() => {
      if (!container.querySelector('.pc-desc-text')) throw new Error('no description')
    })
    expect(container.querySelector('.pc-desc-more')).toBeNull()
  })
})

describe('a refused value', () => {
  it('says what was not stored under the restored value, without marking or renaming the field', async () => {
    const user = userEvent.setup()
    const routes = { ...ROUTES, 'GET /api/v1/params': [{ ...PARAMS[0], rule: { kind: 'positive' } }] }
    const { prism, container } = renderWithPrism(<Parameters activeDb="M" />, { routes })
    const field = await valueField(container)

    await user.clear(field)
    await user.type(field, '-1{Enter}')

    const note = await screen.findByRole('alert')
    expect(note.textContent).toBe('Not stored: “-1” must be greater than 0.')
    expect(field.value).toBe('3.95')
    // The field holds an allowed value again: not invalid, and its name is not the refusal — the note
    // describes it instead.
    expect(field.getAttribute('aria-invalid')).toBeNull()
    expect(field.getAttribute('title')).toBeNull()
    expect(field.getAttribute('aria-describedby')).toBe(note.id)
    expect(prism.calls.filter((c) => c.method === 'POST')).toEqual([])

    await user.type(field, '5')
    expect(screen.queryByText(/Not stored/)).toBeNull()
    expect(field.getAttribute('aria-describedby')).toBeNull()
  })
})

describe('deleting a parameter something still uses', () => {
  it('names the page that changes the formula, not the assistant’s tool', async () => {
    const user = userEvent.setup()
    const refusal = {
      status: 400,
      body: {
        error: {
          code: 'param_in_use',
          message:
            "Not deleted: 'm_pvc' is still used by the amount of 'PVC' in 'bottle' — they would be left naming a " +
            'parameter that does not exist.',
          hint: 'Change the exchange formula first (edit_exchange).',
          details: {
            parameters: ['m_pvc'],
            uses: [
              { kind: 'exchange', label: "the amount of 'PVC' in 'bottle'", owner: null, names: ['m_pvc'] }
            ]
          }
        }
      }
    }
    renderWithPrism(<Parameters activeDb="M" />, {
      routes: { ...ROUTES, 'POST /api/v1/params/delete': refusal }
    })

    await user.click(await screen.findByRole('button', { name: 'Delete parameter' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }))

    expect(
      await screen.findByText(
        "Not deleted: 'm_pvc' is still used by the amount of 'PVC' in 'bottle'. Change the formula of that " +
          'amount on the Model page first, then delete it.'
      )
    ).toBeTruthy()
    expect(screen.queryByText(/edit_exchange/)).toBeNull()
  })
})
