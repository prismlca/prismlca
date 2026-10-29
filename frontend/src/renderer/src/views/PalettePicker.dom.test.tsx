// @vitest-environment jsdom
/**
 * Colour sets of your own, from the + beside "Colours": a name and three colours, each from a colour well or
 * as hex. The new set is picked for the report as soon as it is added, sits after the shipped ones, and is the
 * only kind with a Delete.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type P = { id: string; label: string; hint: string; swatches: string[]; builtin: boolean }
const shipped: P[] = [
  {
    id: 'prism',
    label: 'PrismLCA',
    hint: 'house',
    swatches: ['#93c120', '#2f4e66', '#f8f9fa'],
    builtin: true
  },
  {
    id: 'steel',
    label: 'Steel & ink',
    hint: 'steel',
    swatches: ['#2c6e93', '#23211e', '#f7f8fa'],
    builtin: true
  }
]
let own: P[] = []
const calls: { method: string; path: string; body?: Record<string, string> }[] = []

vi.mock('../lib/api', async (actual) => ({
  ...(await actual<typeof import('../lib/api')>()),
  api: vi.fn(async (method: string, path: string, body?: Record<string, string>) => {
    calls.push({ method, path, body })
    if (method === 'GET' && path === '/api/v1/report/palettes')
      return { palettes: [...shipped, ...own], default: 'prism', custom_colors: false }
    if (method === 'POST' && path === '/api/v1/report/palettes') {
      const p: P = {
        id: 'own-1',
        label: body!.label,
        hint: 'own',
        swatches: [body!.accent, body!.deep, body!.paper],
        builtin: false
      }
      own = [...own, p]
      return { palette: p }
    }
    if (method === 'POST' && path.endsWith('/delete')) {
      own = own.filter((p) => !path.includes(p.id))
      return { ok: true }
    }
    throw new Error(`unexpected ${method} ${path}`)
  })
}))

import PalettePicker, { reloadPalettes } from './PalettePicker'

beforeEach(async () => {
  own = []
  calls.length = 0
  await reloadPalettes() // the catalogue is cached per module; every test starts from the shipped two
})

describe('a colour set of your own', () => {
  it('starts from the set in use, takes hex and colour well alike, and is picked once added', async () => {
    const onSelect = vi.fn()
    render(<PalettePicker selected="steel" onSelect={onSelect} />)
    fireEvent.click(await screen.findByRole('button', { name: 'New colour set' }))

    const accent = screen.getByLabelText(/^Accent/, { selector: 'input:not([type="color"])' })
    expect((accent as HTMLInputElement).value).toBe('#2c6e93') // the set in use, not the default
    const add = screen.getByRole('button', { name: 'Add set' })
    expect(add).toHaveProperty('disabled', true) // no name yet

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'House colours' } })
    // A bare short hex is what a style guide hands over; the well follows it.
    fireEvent.change(accent, { target: { value: 'E52' } })
    expect((screen.getByLabelText('Accent colour') as HTMLInputElement).value).toBe('#ee5522')
    // …and the well writes the field.
    fireEvent.change(screen.getByLabelText('Paper colour'), { target: { value: '#fbf8f2' } })

    await act(async () => fireEvent.click(add))
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/v1/report/palettes')
    expect(post?.body).toEqual({
      label: 'House colours',
      accent: '#ee5522',
      deep: '#23211e',
      paper: '#fbf8f2'
    })
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('own-1'))
    expect(screen.queryByRole('button', { name: 'Add set' })).toBeNull() // the form closed
    expect(screen.getByRole('button', { name: 'House colours' })).toBeTruthy()
  })

  it('will not add a colour it cannot read', async () => {
    render(<PalettePicker selected="prism" onSelect={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'New colour set' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Broken' } })
    const deep = screen.getByLabelText(/^Deep/, { selector: 'input:not([type="color"])' })
    fireEvent.change(deep, { target: { value: 'navy' } })
    expect(deep.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('button', { name: 'Add set' })).toHaveProperty('disabled', true)
  })

  it('says so when the deep tone cannot be read on the paper, and still lets you add it', async () => {
    render(<PalettePicker selected="prism" onSelect={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'New colour set' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Pale' } })
    fireEvent.change(screen.getByLabelText(/^Deep/, { selector: 'input:not([type="color"])' }), {
      target: { value: '#d0d8e0' }
    })
    expect(screen.getByText(/hard to read on this paper/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add set' })).toHaveProperty('disabled', false)
  })

  it('is the only kind of set with a Delete', async () => {
    own = [
      { id: 'own-9', label: 'Ours', hint: 'own', swatches: ['#111111', '#222222', '#ffffff'], builtin: false }
    ]
    await reloadPalettes()
    render(<PalettePicker selected="prism" onSelect={() => {}} />)
    await screen.findByRole('button', { name: 'Ours' })
    expect(screen.queryByRole('button', { name: 'Delete PrismLCA' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Delete Ours' }))
    const dialog = document.querySelector('.confirm-modal') as HTMLElement
    expect(dialog.textContent).toContain('falls back to the PrismLCA set')
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' })))
    expect(calls.some((c) => c.path === '/api/v1/report/palettes/own-9/delete')).toBe(true)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Ours' })).toBeNull())
  })
})

describe('a white page', () => {
  it('replaces only the paper, and gives the set its own back when switched off', async () => {
    const onColors = vi.fn()
    const { rerender } = render(
      <PalettePicker
        selected="steel"
        onSelect={() => {}}
        colors={{ accent: '#e4572e' }}
        onColors={onColors}
      />
    )
    const box = (await screen.findByLabelText('White page background')) as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    expect(onColors).toHaveBeenLastCalledWith({ accent: '#e4572e', paper: '#ffffff' })

    // A white typed by hand in its short form counts as the same white.
    rerender(
      <PalettePicker
        selected="steel"
        onSelect={() => {}}
        colors={{ accent: '#e4572e', paper: '#FFF' }}
        onColors={onColors}
      />
    )
    expect((screen.getByLabelText('White page background') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByLabelText('White page background'))
    expect(onColors).toHaveBeenLastCalledWith({ accent: '#e4572e', paper: undefined })
  })

  it('is not offered where nothing could store it', async () => {
    render(<PalettePicker selected="prism" onSelect={() => {}} />)
    await screen.findByRole('button', { name: 'PrismLCA' })
    expect(screen.queryByLabelText('White page background')).toBeNull()
  })
})
