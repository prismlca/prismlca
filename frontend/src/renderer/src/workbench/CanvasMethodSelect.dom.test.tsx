// @vitest-environment jsdom
/**
 * The chooser shows the method this model calculates with, hands back the method itself when another
 * is picked, and names a chosen method that is gone instead of showing a neighbour in its place.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MethodEntry } from '../lib/methods'
import CanvasMethodSelect from './CanvasMethodSelect'

const m = (method: string[], recommended = true): MethodEntry => ({
  method,
  name: method.join(' · '),
  unit: 'kg CO2-Eq',
  recommended
})
const methods = [
  m(['CML v4.8 2016 no LT', 'acidification no LT'], false),
  m(['My methods', 'AAA']),
  m(['My methods', 'CCC'])
]

const chooser = (): HTMLSelectElement =>
  screen.getByRole('combobox', { name: 'LCIA method' }) as HTMLSelectElement
const shown = (): string => chooser().selectedOptions[0]?.textContent ?? ''

describe('the LCIA method chooser', () => {
  it('shows the chosen method and hands back the picked method, not its row', () => {
    const onChoose = vi.fn()
    render(
      <CanvasMethodSelect
        methods={methods}
        method={{ method: methods[2].method, index: 2, gone: null, checking: null }}
        onChoose={onChoose}
      />
    )
    expect(shown()).toBe('★ My methods · CCC')
    expect(chooser().title).toBe('My methods · CCC')
    expect(chooser().getAttribute('aria-invalid')).toBeNull()
    fireEvent.change(chooser(), { target: { value: '1' } })
    expect(onChoose).toHaveBeenCalledWith(['My methods', 'AAA'])
  })

  it('names a chosen method that is gone, and offers every other one', () => {
    const onChoose = vi.fn()
    render(
      <CanvasMethodSelect
        methods={methods}
        method={{ method: null, index: -1, gone: ['My methods', 'BBB'], checking: null }}
        onChoose={onChoose}
      />
    )
    expect(shown()).toBe('⚠ My methods · BBB — no longer available')
    expect(chooser().title).toContain('"My methods · BBB" is no longer in the method catalogue')
    expect(chooser().getAttribute('aria-invalid')).toBe('true')
    expect(chooser().options).toHaveLength(methods.length + 1)
    fireEvent.change(chooser(), { target: { value: '2' } })
    expect(onChoose).toHaveBeenCalledWith(['My methods', 'CCC'])
  })

  it('shows a chosen method unmarked while the catalogue is being read again', () => {
    render(
      <CanvasMethodSelect
        methods={methods}
        method={{ method: null, index: -1, gone: null, checking: ['My methods', 'BBB'] }}
        onChoose={vi.fn()}
      />
    )
    expect(shown()).toBe('My methods · BBB')
    expect(chooser().title).toBe('Reading the method catalogue for "My methods · BBB" …')
    expect(chooser().getAttribute('aria-invalid')).toBeNull()
  })

  it('waits for the catalogue', () => {
    render(
      <CanvasMethodSelect
        methods={[]}
        method={{ method: null, index: -1, gone: null, checking: null }}
        onChoose={vi.fn()}
      />
    )
    expect(chooser().disabled).toBe(true)
    expect(shown()).toBe('no methods')
  })
})
