// @vitest-environment jsdom
/**
 * A canvas arrow's label: the amount with its unit, under it the product, each behind its switch under
 * Settings → Modelling — and no label at all with both off.
 */
import { Position } from '@xyflow/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderWithPrism } from '../test/render'
import { makePrism } from '../test/prism'
import { DEFAULT_SETTINGS, getSettings, setSettings } from '../lib/settings'
import PrismEdge, { PRODUCT_MAX } from './PrismEdge'

const edge = (product: string | null): JSX.Element => (
  <svg>
    <PrismEdge
      id="e1"
      source="a"
      target="b"
      sourceX={0}
      sourceY={0}
      targetX={200}
      targetY={0}
      sourcePosition={Position.Right}
      targetPosition={Position.Left}
      label="0.5 kg"
      data={{ product }}
    />
  </svg>
)
const lines = (c: HTMLElement): string[] => [...c.querySelectorAll('tspan')].map((t) => t.textContent ?? '')
const switches = (edgeAmounts: boolean, edgeProducts: boolean): void =>
  setSettings({ ...getSettings(), modelling: { ...getSettings().modelling, edgeAmounts, edgeProducts } })

// Settings are written through the bridge, so the fake one has to be there before any switch is flipped.
beforeEach(() => {
  ;(window as unknown as { prism: unknown }).prism = makePrism().prism
})
afterEach(() => setSettings(DEFAULT_SETTINGS))

describe('the arrow label', () => {
  it('shows the amount and, under it, the product — both on by default', () => {
    expect(DEFAULT_SETTINGS.modelling.edgeAmounts && DEFAULT_SETTINGS.modelling.edgeProducts).toBe(true)
    // Exactly twenty characters: shown whole.
    const { container } = renderWithPrism(edge('glass bottle, 0.75 l'))
    expect(lines(container)).toEqual(['0.5 kg', 'glass bottle, 0.75 l'])
  })

  it('cuts a long product name and keeps the whole of it in the tooltip', () => {
    const long = 'market for electricity, low voltage, residential and commercial'
    const { container } = renderWithPrism(edge(long))
    expect(PRODUCT_MAX).toBe(20)
    expect(lines(container)[1]).toBe('market for electric…')
    expect(lines(container)[1].length).toBeLessThanOrEqual(PRODUCT_MAX)
    expect(container.querySelector('title')?.textContent).toBe(long)
  })

  it('follows the two switches, and draws no label with both off', () => {
    switches(true, false)
    expect(lines(renderWithPrism(edge('bottle')).container)).toEqual(['0.5 kg'])
    switches(false, true)
    expect(lines(renderWithPrism(edge('bottle')).container)).toEqual(['bottle'])
    switches(false, false)
    expect(
      renderWithPrism(edge('bottle')).container.querySelector('.react-flow__edge-textwrapper')
    ).toBeNull()
  })
})
