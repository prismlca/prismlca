import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderWithPrism } from '../test/render'
import FlowPicker from './FlowPicker'

/**
 * Picking an elementary flow: a double-click on a row does what selecting it and pressing Add does. A
 * flow that is already on the process is the exception — there the footer asks merge or separate, and a
 * double-click must not answer that question for the user.
 */
const CO2 = {
  database: 'biosphere',
  code: 'co2',
  name: 'Carbon dioxide, fossil',
  unit: 'kilogram',
  categories: ['air'],
  direction: 'output'
}
const CH4 = { ...CO2, code: 'ch4', name: 'Methane, fossil' }
// The search is debounced and then fetched: under a full parallel run that takes longer than the default 1 s.
const SLOW = { timeout: 3000 }

const open = (existing: { uid: string; type: string; amount: number; input: object }[] = []) => {
  const onAdded = vi.fn()
  const onClose = vi.fn()
  const { prism } = renderWithPrism(
    <FlowPicker
      database="model"
      code="proc"
      direction="output"
      existing={existing as never}
      onClose={onClose}
      onAdded={onAdded}
    />,
    {
      routes: {
        'GET /api/v1/model/flows': { flows: [CO2, CH4] },
        'GET /api/v1/model/unit-vocabulary': { units: ['kilogram'] },
        'POST /api/v1/model/exchanges': {}
      }
    }
  )
  const posts = () => prism.calls.filter((c) => c.method === 'POST')
  return { onAdded, onClose, posts }
}

describe('the flow picker', () => {
  it('adds a flow on double-click, as Add would', async () => {
    const user = userEvent.setup()
    const { onAdded, onClose, posts } = open()
    await user.dblClick(await screen.findByRole('button', { name: /Methane, fossil/ }, SLOW))
    await waitFor(() => expect(onClose).toHaveBeenCalled(), SLOW)
    expect(onAdded).toHaveBeenCalled()
    expect(posts()).toHaveLength(1)
    expect(posts()[0]).toMatchObject({
      path: '/api/v1/model/exchanges',
      body: { input_database: 'biosphere', input_code: 'ch4', amount: 1, type: 'biosphere' }
    })
  })

  it('only selects a flow already on the process, so merge or separate stays the user’s choice', async () => {
    const user = userEvent.setup()
    const { onClose, posts } = open([
      { uid: 'u1', type: 'biosphere', amount: 2, input: { database: 'biosphere', code: 'co2' } }
    ])
    await user.dblClick(await screen.findByRole('button', { name: /Carbon dioxide, fossil/ }, SLOW))
    expect(await screen.findByRole('button', { name: /Merge → 3/ })).toBeInTheDocument()
    expect(posts()).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
  })
})
