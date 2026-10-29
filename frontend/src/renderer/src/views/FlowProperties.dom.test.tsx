import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'

import { renderWithPrism } from '../test/render'
import FlowProperties from './FlowProperties'

/**
 * Adding a flow property. The field used to be a <datalist>, whose popup Electron draws itself and does
 * not scroll: the ecoinvent vocabulary filled the window without a scrollbar. Now the whole vocabulary
 * is a list of the app's own, and choosing an entry adds the property.
 */
const VOCAB = Array.from({ length: 40 }, (_, i) => ({
  name: `property ${String(i).padStart(2, '0')}`,
  unit: 'kg'
}))

const open = () => {
  const onClose = vi.fn()
  const onChanged = vi.fn()
  const { prism } = renderWithPrism(
    <FlowProperties database="model" code="proc" onClose={onClose} onChanged={onChanged} />,
    {
      routes: {
        'GET /api/v1/model/activities/:db/:code/properties': {
          product: 'widget',
          unit: 'kilogram',
          read_only: false,
          properties: {}
        },
        'GET /api/v1/model/property-vocabulary': { properties: VOCAB },
        'POST /api/v1/model/properties': {}
      }
    }
  )
  const written = () =>
    prism.calls
      .filter((c) => c.method === 'POST')
      .map((c) => Object.keys((c.body as { properties: object }).properties))
  return { onClose, onChanged, written }
}

describe('the flow-properties sheet', () => {
  it('lists the whole vocabulary and adds the property chosen from it', async () => {
    const { written, onChanged } = open()
    const field = await screen.findByRole('textbox', { name: 'Add property' })
    act(() => field.focus())
    // All of it, not the first eight: the list scrolls rather than stopping short.
    expect(screen.getAllByRole('button', { name: /^property \d+ · kg$/ })).toHaveLength(40)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'property 33 · kg' }))
    await waitFor(() => expect(written()).toEqual([['property 33']]))
    expect(onChanged).toHaveBeenCalled()
    expect(field).toHaveValue('')
  })

  it('adds the one match left on Enter', async () => {
    const { written } = open()
    const field = await screen.findByRole('textbox', { name: 'Add property' })
    act(() => field.focus())
    fireEvent.change(field, { target: { value: 'erty 07' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(written()).toEqual([['property 07']]))
  })

  it('adds the property marked with the arrow keys on Enter', async () => {
    const { written } = open()
    const field = await screen.findByRole('textbox', { name: 'Add property' })
    act(() => field.focus())
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'ArrowDown' })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(written()).toEqual([['property 01']]))
  })

  it('closes an open list on Escape and keeps the sheet', async () => {
    const { onClose } = open()
    const field = await screen.findByRole('textbox', { name: 'Add property' })
    act(() => field.focus())
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'property 00 · kg' })).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    // The next Escape is the sheet's.
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
