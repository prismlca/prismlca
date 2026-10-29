import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Parameters from './Parameters'
import Scenarios from './Scenarios'
import { renderWithPrism } from '../test/render'

/**
 * The two pages that show the audit log sit under the toolbar that holds Undo and Redo, and the two
 * halves have to stay in step in both directions. Measured on the running app (24.08.2026), both were
 * broken:
 *
 * - a parameter set here left Undo greyed out as “Nothing to undo” while the line was already in the
 *   audit list beside it — the toolbar only re-read `GET /model/history` on a navigation, so Undo was
 *   unreachable on the page the change was made on. Worse in the other direction: Redo stayed enabled
 *   on a stack the write had just cleared, and clicking it produced the “Nothing to redo.” banner —
 *   the 409 in normal operation that the disabled state exists to prevent;
 * - an Undo from the toolbar did not reach the page: the row kept showing 4.25 while the model held
 *   3.95, and the audit list next to it was missing the line the undo had just written.
 *
 * So: an undoable write reports upward through `onChanged`, and `rev` carries the other direction.
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
const GROUPS = [{ id: 'g1', name: 'Masses', order: 0 }]
const AUDIT = [
  {
    index: 1,
    timestamp: '2026-08-24T01:23:39Z',
    source: 'user',
    action: 'set_parameter',
    summary: "Set parameter 'm_pvc' = 3.95",
    undoable: true,
    database: 'M'
  }
]

const PARAM_ROUTES = {
  'GET /api/v1/params': PARAMS,
  'GET /api/v1/params/groups': GROUPS,
  'GET /api/v1/model/audit': AUDIT,
  'POST /api/v1/params': {}
}

const SCEN_ROUTES = {
  'GET /api/v1/scenarios': [
    { id: 's1', name: 'High recycling', description: '', overrides: { m_pvc: 4 }, database: 'M' }
  ],
  'GET /api/v1/params': PARAMS,
  'GET /api/v1/params/groups': GROUPS,
  'GET /api/v1/model/audit': AUDIT,
  'POST /api/v1/scenarios/duplicate': {}
}

const gets = (calls: { method: string; path: string }[], path: string): number =>
  calls.filter((c) => c.method === 'GET' && c.path.split('?')[0] === path).length

describe('Parameters keeps the toolbar in step', () => {
  it('reports an undoable write upward, so Undo and Redo can be re-read', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    const { prism, container } = renderWithPrism(<Parameters activeDb="M" rev={0} onChanged={onChanged} />, {
      routes: PARAM_ROUTES
    })
    const field = await waitFor(() => {
      const el = container.querySelector<HTMLInputElement>('.pc-val input')
      if (!el) throw new Error('no value field')
      return el
    })

    // The field exists before React has run its mount effects, and CellInput's `setV(initial)` effect
    // is one of them: when it was still pending, the clear's input event flushed it and 3.95 came back,
    // the typing produced "3.954.25", the commit read no number and reverted — no POST (flaked under
    // load, 2 in 20 runs alone). So the edit is repeated until the field holds exactly what was typed.
    await waitFor(
      async () => {
        await user.clear(field)
        await user.type(field, '4.25')
        expect(field.value).toBe('4.25')
      },
      { timeout: 5000 }
    )
    await user.tab() // commit on blur, as the page does

    await waitFor(() => expect(prism.calls.some((c) => c.method === 'POST')).toBe(true))
    // The point of the test: the toolbar is told. Without this the write is invisible to it.
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('reloads when the Workbench wrote — an Undo from the toolbar above it', async () => {
    const { prism, rerender } = renderWithPrism(<Parameters activeDb="M" rev={0} />, {
      routes: PARAM_ROUTES
    })
    await waitFor(() => expect(gets(prism.calls, '/api/v1/params')).toBe(1))

    rerender(<Parameters activeDb="M" rev={1} />)
    await waitFor(() => expect(gets(prism.calls, '/api/v1/params')).toBe(2))
    // …and the audit list with it, or the undo's own line would be missing from the model's history.
    expect(gets(prism.calls, '/api/v1/model/audit')).toBe(2)
  })

  it('does not fetch twice on mount', async () => {
    const { prism } = renderWithPrism(<Parameters activeDb="M" rev={7} />, { routes: PARAM_ROUTES })
    await waitFor(() => expect(gets(prism.calls, '/api/v1/params')).toBe(1))
    expect(gets(prism.calls, '/api/v1/params')).toBe(1)
  })
})

describe('Scenarios keeps the toolbar in step', () => {
  it('reports an undoable write upward', async () => {
    const user = userEvent.setup()
    const onChanged = vi.fn()
    renderWithPrism(<Scenarios activeDb="M" rev={0} onChanged={onChanged} />, { routes: SCEN_ROUTES })

    await user.click(await screen.findByRole('button', { name: 'Duplicate scenario' }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('reloads when the Workbench wrote', async () => {
    const { prism, rerender } = renderWithPrism(<Scenarios activeDb="M" rev={0} />, {
      routes: SCEN_ROUTES
    })
    await waitFor(() => expect(gets(prism.calls, '/api/v1/scenarios')).toBe(1))

    rerender(<Scenarios activeDb="M" rev={1} />)
    await waitFor(() => expect(gets(prism.calls, '/api/v1/scenarios')).toBe(2))
  })
})
