// @vitest-environment jsdom
/**
 * The factor comparison table: agreeing factors tinted, every header a keyboard-reachable sort button that
 * says its direction to assistive technology.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import LciaCompareTable from './LciaCompareTable'
import type { CfResponse } from './lciaCompare'

const data: CfResponse = {
  methods: [
    { method: ['IPCC', 'climate', 'GWP100'], name: 'GWP100', unit: 'kg CO2-eq' },
    { method: ['IPCC', 'climate', 'GWP20'], name: 'GWP20', unit: 'kg CO2-eq' }
  ],
  flows: [
    { flow: 'methane', categories: ['air'], unit: 'kg', factors: [27.9, 81.2] },
    { flow: 'Carbon dioxide', categories: ['air'], unit: 'kg', factors: [1, 1] }
  ]
}

const rows = (): string[] =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(r).getAllByRole('cell')[0].textContent ?? '')

describe('the factor comparison table', () => {
  it('tints the factors that agree within a row', () => {
    const { container } = render(<LciaCompareTable data={data} onError={() => {}} />)
    const same = [...container.querySelectorAll('td.lcia-same')].map((td) => td.textContent)
    expect(same).toEqual(['1', '1'])
  })

  it('sorts from header buttons, and says the direction on the header', () => {
    render(<LciaCompareTable data={data} onError={() => {}} />)
    const byFlow = screen.getByRole('button', { name: 'Flow' })
    expect(byFlow.tagName).toBe('BUTTON') // reachable with Tab, operable with Enter
    fireEvent.click(byFlow)
    expect(rows()).toEqual(['Carbon dioxide', 'methane'])
    expect(byFlow.closest('th')?.getAttribute('aria-sort')).toBe('ascending')
    fireEvent.click(screen.getByRole('button', { name: /^GWP100/ }))
    fireEvent.click(screen.getByRole('button', { name: /^GWP100/ }))
    expect(rows()).toEqual(['methane', 'Carbon dioxide'])
    expect(
      screen
        .getByRole('button', { name: /^GWP100/ })
        .closest('th')
        ?.getAttribute('aria-sort')
    ).toBe('descending')
  })
})
