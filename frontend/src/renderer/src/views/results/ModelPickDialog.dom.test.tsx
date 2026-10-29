import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ModelPickDialog from './ModelPickDialog'
import type { DatabaseInfo } from '../../lib/api'
import { renderWithPrism } from '../../test/render'

/**
 * Another model joins the comparison by its reference process, never by a process picked from its list:
 * the dialog shows the one process `/model/reference` ranks first and asks only to confirm it.
 */
const DBS = [
  { name: 'Open', kind: 'foreground' },
  { name: 'Glass', kind: 'foreground' },
  { name: 'Can', kind: 'foreground' },
  { name: 'ecoinvent', kind: 'background' }
] as DatabaseInfo[]
const ROUTES = {
  'GET /api/v1/model/reference/Glass': {
    candidates: [
      { code: 'g-root', name: 'Glass bottle, filled', product: 'glass bottle', location: 'DE', unit: 'unit' },
      { code: 'g-sub', name: 'Glass melting' }
    ]
  },
  'GET /api/v1/model/reference/Can': { candidates: [{ code: 'c-root', name: 'Aluminium can' }] }
}

describe('ModelPickDialog', () => {
  it('shows only the reference process and adds it on confirm', async () => {
    const user = userEvent.setup()
    const onPick = vi.fn()
    const onClose = vi.fn()
    renderWithPrism(
      <ModelPickDialog databases={DBS} activeDb="Open" existing={[]} onPick={onPick} onClose={onClose} />,
      { routes: ROUTES }
    )
    expect(await screen.findByText('Glass bottle, filled')).toBeInTheDocument()
    expect(screen.getByText('glass bottle · DE · unit')).toBeInTheDocument()
    // No list to pick from: the second candidate is not offered.
    expect(screen.queryByText('Glass melting')).toBeNull()
    // The open model and the background are not offered as "another model".
    const options = Array.from((screen.getByLabelText('Model') as HTMLSelectElement).options).map(
      (o) => o.value
    )
    expect(options).toEqual(['Glass', 'Can'])

    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(onPick).toHaveBeenCalledWith({ database: 'Glass', code: 'g-root', name: 'Glass bottle, filled' })
    expect(onClose).toHaveBeenCalled()
  })

  it('opens on a model not yet compared and refuses one already added', async () => {
    const user = userEvent.setup()
    renderWithPrism(
      <ModelPickDialog
        databases={DBS}
        activeDb="Open"
        existing={[{ database: 'Glass', code: 'g-root', name: 'Glass bottle, filled' }]}
        onPick={() => {}}
        onClose={() => {}}
      />,
      { routes: ROUTES }
    )
    expect(await screen.findByText('Aluminium can')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Model'), 'Glass')
    expect(await screen.findByText('Glass bottle, filled')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Already added' })).toBeDisabled()
  })
})
