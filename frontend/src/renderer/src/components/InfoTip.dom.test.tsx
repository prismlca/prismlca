import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import { InfoTip } from './InfoTip'

/**
 * Opening the panel is CSS (`:hover`/`:focus-within`), which jsdom does not evaluate — so what is
 * worth holding here is the part that is not CSS: the icon is reachable and named, the text is
 * really in the document rather than an attribute, and the click does not fall through to the
 * field. That last one is the reason the button exists in this shape: these tips sit inside a
 * `<label>`, where any un-swallowed click lands on the control.
 */
describe('InfoTip', () => {
  it('names the icon after the field it explains', () => {
    render(<InfoTip label="Review model">Argues against the study.</InfoTip>)
    expect(screen.getByRole('button', { name: 'About Review model' })).toBeTruthy()
  })

  it('keeps the explanation in the document, not in a title attribute', () => {
    render(<InfoTip label="Chat model">The assistant on the canvas.</InfoTip>)
    const tip = screen.getByRole('tooltip')
    expect(tip.textContent).toBe('The assistant on the canvas.')
  })

  it('swallows its click so the surrounding label does not focus the field', () => {
    render(
      <label>
        <span>
          Chat model
          <InfoTip label="Chat model">Explains it.</InfoTip>
        </span>
        <select data-testid="pick">
          <option value="a">a</option>
        </select>
      </label>
    )
    const select = screen.getByTestId('pick')
    fireEvent.click(screen.getByRole('button', { name: 'About Chat model' }))
    expect(document.activeElement).not.toBe(select)
  })
})
