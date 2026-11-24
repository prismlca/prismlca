import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import LciaMethods from './LciaMethods'
import { makePrism, type PrismFixture } from '../test/prism'
import { resetQueryCache } from '../lib/server/useQuery'

const taken = (message: string) => ({
  status: 409,
  body: { error: { code: 'method_exists', message } }
})

/** "New method" under a name that exists closed the dialog and put the reason in the page banner;
 *  what was typed was gone. */
describe('LCIA method dialogs keep their input when a name is refused', () => {
  let fixture: PrismFixture
  beforeEach(() => {
    resetQueryCache()
    fixture = makePrism({
      'GET /api/v1/lcia/families': {
        families: [
          {
            family: 'IPCC 2021',
            description: '',
            custom: false,
            methods: [
              { method: ['IPCC 2021', 'GWP100'], name: 'GWP100', unit: 'kg CO2-eq', editable: false },
              { method: ['IPCC 2021', 'GWP20'], name: 'GWP20', unit: 'kg CO2-eq', editable: false }
            ]
          },
          { family: 'My methods', description: '', custom: true, methods: [] }
        ]
      },
      'POST /api/v1/lcia/method': taken("A method 'My methods · BBB' already exists.")
    })
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
  })

  it('New method: an empty name cannot be submitted, a taken one stays in the dialog', async () => {
    render(<LciaMethods />)
    await screen.findByText('My methods')
    fireEvent.click(screen.getByRole('button', { name: 'New method' }))
    const create = screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: 'Indicator name' }), { target: { value: 'BBB' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Unit (e.g. kg CO2-eq)' }), {
      target: { value: 'kg' }
    })
    fireEvent.click(create)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("A method 'My methods · BBB' already exists.")
    expect(screen.getByRole('dialog', { name: 'New method' })).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'Indicator name' }) as HTMLInputElement).value).toBe('BBB')
    expect((screen.getByRole('textbox', { name: 'Unit (e.g. kg CO2-eq)' }) as HTMLInputElement).value).toBe(
      'kg'
    )
  })

  it('New method: an accepted name closes the dialog and opens the method', async () => {
    fixture.setRoute('POST /api/v1/lcia/method', {
      method: ['My methods', 'CCC'],
      name: 'CCC',
      unit: 'kg',
      editable: true,
      flows: []
    })
    render(<LciaMethods />)
    await screen.findByText('My methods')
    fireEvent.click(screen.getByRole('button', { name: 'New method' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Indicator name' }), { target: { value: 'CCC' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New method' })).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
    await screen.findByText('CCC') // the new method is open in the editor
  })

  it('Duplicate: a refused copy keeps the dialog, without the copies already made', async () => {
    let n = 0
    fixture.setRoute('POST /api/v1/lcia/duplicate', (body: unknown) => {
      n += 1
      if (n === 1)
        return { method: ['My methods', 'GWP100'], name: 'GWP100', unit: 'kg', editable: true, flows: [] }
      return taken(`A method 'My methods · ${(body as { name: string }).name}' already exists.`)
    })
    render(<LciaMethods />)
    await screen.findByText('My methods')
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate method' }))
    const dialog = screen.getByRole('dialog', { name: 'Duplicate indicators' })
    fireEvent.click(screen.getByRole('checkbox', { name: /GWP100/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /GWP20/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate 2' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain("A method 'My methods · GWP20' already exists.")
    expect(dialog.isConnected).toBe(true)
    // GWP100 was copied: it leaves the selection, so a second try does not copy it again.
    expect((screen.getByRole('checkbox', { name: /GWP100/ }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: /GWP20/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('button', { name: 'Duplicate 1' })).toBeTruthy()
    // The copy that was made shows in the list behind the dialog.
    await waitFor(() =>
      expect(fixture.calls.filter((c) => c.path === '/api/v1/lcia/families').length).toBeGreaterThan(1)
    )
  })

  it('New method: a refusal reloads nothing', async () => {
    render(<LciaMethods />)
    await screen.findByText('My methods')
    fireEvent.click(screen.getByRole('button', { name: 'New method' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Indicator name' }), { target: { value: 'BBB' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await screen.findByRole('alert')
    expect(fixture.calls.filter((c) => c.path === '/api/v1/lcia/families')).toHaveLength(1)
  })
})
