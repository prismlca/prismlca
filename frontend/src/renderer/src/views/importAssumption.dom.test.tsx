import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AssumptionInput, MatchCell, appliedAssumption } from './ImportWizard'

/**
 * The reviewer's bridge between mass and volume: 1 000 kg of liquid water to a
 * flow in m³ needs 0.001 m³ per kg, and before this there was nowhere to say so.
 */
const water = {
  unit: 'kg',
  scale: 'kg cannot be converted to cubic meter',
  factor: 1,
  target: { database: 'biosphere3', code: 'water', label: 'Water', name: 'Water', unit: 'cubic meter' }
}

describe('the assumption input', () => {
  it('applies the figure in target units per source unit once a reason is given', async () => {
    const onAssume = vi.fn()
    render(<AssumptionInput row={water as never} onAssume={onAssume} />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/How many cubic meter one kg is/), '0,001')
    await user.tab()
    expect(onAssume).not.toHaveBeenCalled() // a figure without a reason is an invented one
    await user.type(screen.getByLabelText('What the figure rests on'), 'liquid water, 1 kg/L{Enter}')
    expect(onAssume).toHaveBeenCalledWith(0.001, 'liquid water, 1 kg/L')
  })

  it('shows an assumption already applied, and does not resend it unchanged', async () => {
    const applied = {
      ...water,
      factor: 0.001,
      scale: 'kg → cubic meter via liquid water, 1 kg/L (0.001 cubic meter/kg)'
    }
    expect(appliedAssumption(applied.scale, applied.factor)).toEqual({
      quantity: '0.001',
      what: 'liquid water, 1 kg/L'
    })
    const onAssume = vi.fn()
    render(<AssumptionInput row={applied as never} onAssume={onAssume} />)
    expect(screen.getByLabelText(/How many cubic meter one kg is/)).toHaveValue('0.001')
    await userEvent.setup().click(screen.getByLabelText('What the figure rests on'))
    await userEvent.setup().tab()
    expect(onAssume).not.toHaveBeenCalled()
  })

  it('starts empty when the target changes, instead of offering the last one’s figure', async () => {
    const row = {
      ...water,
      kind: 'biosphere',
      name: 'Water',
      amount: 1000,
      compartment: ['air'],
      confidence: 'low',
      evidence: 'x',
      scaled_amount: 1000,
      candidates: [],
      needs_assumption: true
    }
    const { rerender } = render(<MatchCell row={row as never} onPick={() => {}} onAssume={() => {}} />)
    await userEvent.setup().type(screen.getByLabelText(/How many cubic meter one kg is/), '0.001')
    const energy = {
      ...row,
      target: { ...row.target, code: 'heat', unit: 'megajoule' },
      scale: 'kg cannot be converted to megajoule'
    }
    rerender(<MatchCell row={energy as never} onPick={() => {}} onAssume={() => {}} />)
    expect(screen.getByLabelText(/How many megajoule one kg is/)).toHaveValue('')
  })
})
