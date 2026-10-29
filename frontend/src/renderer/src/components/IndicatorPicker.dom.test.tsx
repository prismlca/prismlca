import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import IndicatorPicker, { methodKey, type PickerMethod } from './IndicatorPicker'
import { renderWithPrism } from '../test/render'

/**
 * You have to be able to tell what you are ticking (V203).
 *
 * A ReCiPe endpoint family names its damage category second and the indicator third, so a picker that
 * prints `method[1]` offered twelve rows reading "★ ecosystem quality · species.yr" and two chips whose
 * × buttons removed different things. The rule lives in `lib/methods`; what this test guards is the
 * thing a unit test of it cannot see — that the picker judges against the whole catalogue it was given
 * rather than against the rows it happens to show.
 */
const ENDPOINT = 'ReCiPe 2016 v1.03, endpoint (H)'

const method = (family: string, category: string, indicator?: string): PickerMethod => ({
  method: indicator ? [family, category, indicator] : [family, category],
  name: [family, category, indicator].filter(Boolean).join(' · '),
  unit: family === ENDPOINT ? 'species.yr' : 'kg CO2-Eq',
  recommended: true
})

const CATALOGUE: PickerMethod[] = [
  method(ENDPOINT, 'ecosystem quality', 'climate change: freshwater ecosystems'),
  method(ENDPOINT, 'ecosystem quality', 'climate change: terrestrial ecosystems'),
  method(ENDPOINT, 'ecosystem quality', 'water use: aquatic ecosystems'),
  method('EF v3.1', 'climate change', 'global warming potential (GWP100)')
]

const openPicker = async (user: ReturnType<typeof userEvent.setup>): Promise<void> =>
  user.click(screen.getByRole('button', { name: '+ Add indicator' }))

describe('IndicatorPicker', () => {
  it('gives every indicator of a three-part family a name of its own', async () => {
    const user = userEvent.setup()
    const picked = [methodKey(CATALOGUE[0].method), methodKey(CATALOGUE[1].method)]
    renderWithPrism(<IndicatorPicker methods={CATALOGUE} picked={picked} onChange={() => {}} />)
    await openPicker(user)

    // The rows of the family the dropdown starts on: three checkboxes, three different names.
    const rows = screen.getAllByRole('checkbox').map((box) => box.closest('label')?.textContent ?? '')
    expect(rows).toHaveLength(3)
    expect(new Set(rows).size).toBe(3)
    expect(rows[0]).toContain('ecosystem quality / climate change: freshwater ecosystems')

    // …and the two chips above them, whose × buttons remove different indicators.
    const removals = screen.getAllByTitle('Remove this indicator').map((b) => b.getAttribute('aria-label'))
    expect(removals).toEqual([
      'Remove ecosystem quality / climate change: freshwater ecosystems',
      'Remove ecosystem quality / climate change: terrestrial ecosystems'
    ])
  })

  it('leaves a family whose category is its indicator alone', async () => {
    const user = userEvent.setup()
    const ef = CATALOGUE[3]
    renderWithPrism(<IndicatorPicker methods={[ef]} picked={[methodKey(ef.method)]} onChange={() => {}} />)
    await openPicker(user)
    expect(screen.getByRole('checkbox').closest('label')?.textContent).toContain('climate change')
    expect(screen.getByRole('checkbox').closest('label')?.textContent).not.toContain('global warming')
  })
})

/**
 * It works like the Results rail's picker: the selection in view as chips, the catalogue only behind
 * "+ Add indicator", closed again by "Done". A report rail is mostly settings; the catalogue is needed
 * only while choosing.
 */
describe('IndicatorPicker — opened on request', () => {
  function Host({
    initial = [],
    onChange
  }: {
    initial?: string[]
    onChange?: (next: string[]) => void
  }): JSX.Element {
    const [picked, setPicked] = useState(initial)
    return (
      <IndicatorPicker
        methods={CATALOGUE}
        picked={picked}
        onChange={(next) => {
          onChange?.(next)
          setPicked(next)
        }}
      />
    )
  }

  it('shows no family dropdown and no list until "+ Add indicator" is clicked', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Host />)

    expect(screen.getByText('None selected.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Method family')).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Filter indicators…')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Select all' })).not.toBeInTheDocument()

    await openPicker(user)
    expect(screen.getByLabelText('Method family')).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('closes again on "Done", keeping what was ticked as chips', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderWithPrism(<Host onChange={onChange} />)

    await openPicker(user)
    await user.click(screen.getAllByRole('checkbox')[0])
    expect(onChange).toHaveBeenLastCalledWith([methodKey(CATALOGUE[0].method)])

    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByLabelText('Method family')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.getByRole('button', { name: '+ Add indicator' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('None selected.')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Remove ecosystem quality / climate change: freshwater ecosystems' })
    ).toBeInTheDocument()
  })

  it('opens on the family of what is picked, not on the first family', async () => {
    const user = userEvent.setup()
    renderWithPrism(<Host initial={[methodKey(CATALOGUE[3].method)]} />)

    await openPicker(user)
    expect(screen.getByLabelText('Method family')).toHaveValue('EF v3.1')
    expect(screen.getByRole('checkbox')).toBeChecked()
    // Browsing another family and closing does not stick when nothing was ticked there.
    await user.selectOptions(screen.getByLabelText('Method family'), ENDPOINT)
    await user.click(screen.getByRole('button', { name: 'Done' }))
    await openPicker(user)
    expect(screen.getByLabelText('Method family')).toHaveValue('EF v3.1')
  })

  it('removes an indicator with the × on its chip, without opening the list', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const gwp = methodKey(CATALOGUE[3].method)
    const fresh = methodKey(CATALOGUE[0].method)
    renderWithPrism(<Host initial={[fresh, gwp]} onChange={onChange} />)

    // Chips sit under their family, as on Results.
    const efGroup = screen.getByTitle('EF v3.1').closest('.ind-chip-group') as HTMLElement
    expect(within(efGroup).getByText('climate change')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Remove climate change' }))
    expect(onChange).toHaveBeenLastCalledWith([fresh])
    expect(screen.queryByTitle('EF v3.1')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Method family')).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Remove ecosystem quality / climate change: freshwater ecosystems' })
    )
    expect(onChange).toHaveBeenLastCalledWith([])
    expect(screen.getByText('None selected.')).toBeInTheDocument()
  })
})
