import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ResultBar from './ResultBar'

/**
 * An outdated canvas score must not look like the result: it is the largest number on the screen, and with
 * only a tag beside it an intermediate state's score read as the finished model's. Stale, the score is
 * withdrawn (the class the stylesheet strikes through and mutes) and carries the reason as its hint, while the
 * tag stays in the text for anyone who reads rather than looks.
 */
const RESULT = {
  total: 105.311,
  unit: 'kg CO2-Eq',
  method: 'EF v3.1 · climate change',
  fu: '1 bottle',
  seconds: 0.4,
  nodes: 12
}

const score = (): HTMLElement => screen.getByText(/105\.311/)

describe('ResultBar', () => {
  it('withdraws an outdated score and keeps the tag that says why', () => {
    render(<ResultBar result={RESULT} stale onClear={vi.fn()} />)
    expect(score().tagName).toBe('B')
    expect(score()).toHaveClass('rb-outdated')
    expect(score().getAttribute('title')).toMatch(/model has changed since this calculation/)
    const tag = screen.getByText('Outdated — recalculate')
    expect(tag).toHaveClass('rb-stale')
    expect(tag).toBeVisible()
    // The tag follows the number in reading order, so the number is never announced without it.
    expect(score().compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows a current score plainly, without the withdrawal or the tag', () => {
    render(<ResultBar result={RESULT} stale={false} onClear={vi.fn()} />)
    expect(score().tagName).toBe('B')
    expect(score()).not.toHaveClass('rb-outdated')
    expect(score()).not.toHaveAttribute('title')
    expect(screen.queryByText('Outdated — recalculate')).toBeNull()
  })
})
