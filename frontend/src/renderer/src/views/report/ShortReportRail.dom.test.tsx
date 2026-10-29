/**
 * The short report's "Compare with": the model's scenarios and nothing else. A variant is the reference
 * process under other parameter values; the model's other processes are not offered beside it.
 */
import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ShortReportRail, { DEFAULT_SHORT_SETTINGS, type ShortSettings } from './ShortReportRail'
import { NO_SHORT_HEAD } from './ShortHeadGroup'
import { renderWithPrism } from '../../test/render'

const ACTS = [
  { code: 'root', name: 'Watering can' },
  { code: 'spout', name: 'Spout, injection moulded' }
]

function renderRail(
  scenarios: { id: string; name: string }[],
  settings: ShortSettings = DEFAULT_SHORT_SETTINGS
): { update: ReturnType<typeof vi.fn> } {
  const update = vi.fn()
  renderWithPrism(
    <ShortReportRail
      code="root"
      setCode={() => {}}
      acts={ACTS}
      scenarios={scenarios}
      families={[]}
      methods={[]}
      picked={[]}
      onPicked={() => {}}
      settings={settings}
      update={update}
      head={NO_SHORT_HEAD}
      onHead={() => {}}
      templates={[]}
      onTemplatesChanged={() => {}}
      busy={false}
      onGenerate={() => {}}
      onSavePdf={() => {}}
    />,
    { routes: { 'GET /api/v1/report/palettes': { palettes: [] } } }
  )
  return { update }
}

describe('the short report rail → Compare with', () => {
  it('lists the scenarios and none of the model’s other processes', async () => {
    const user = userEvent.setup()
    const { update } = renderRail([{ id: 's1', name: 'Recycled PP' }])

    // The Subject group opens by default; its only checkboxes are the variants on offer.
    expect(screen.getByText('Compare with')).toBeInTheDocument()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.map((b) => b.closest('label')?.textContent)).toEqual(['Recycled PP'])
    expect(screen.queryByRole('checkbox', { name: 'Spout, injection moulded' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Recycled PP' }))
    expect(update).toHaveBeenLastCalledWith({ compare: [{ scenario: 's1' }] })
  })

  it('shows no "Compare with" at all when the model has no scenario', () => {
    renderRail([])
    expect(screen.getByText('Reference process')).toBeInTheDocument()
    expect(screen.queryByText('Compare with')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
  })

  it('unticks a scenario without touching the others', async () => {
    const user = userEvent.setup()
    const settings = { ...DEFAULT_SHORT_SETTINGS, compare: [{ scenario: 's1' }, { scenario: 's2' }] }
    const { update } = renderRail(
      [
        { id: 's1', name: 'Recycled PP' },
        { id: 's2', name: 'Thinner wall' }
      ],
      settings
    )
    expect(screen.getByRole('checkbox', { name: 'Thinner wall' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'Recycled PP' }))
    expect(update).toHaveBeenLastCalledWith({ compare: [{ scenario: 's2' }] })
  })
})
