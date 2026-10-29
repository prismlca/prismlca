import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { StackLegend } from './results/charts'

const keys = Array.from({ length: 20 }, (_, i) => `k${i}`)
// k19 is the heaviest, k0 the lightest: the folded legend must pick by weight, not by position.
const weights = new Map(keys.map((k, i) => [k, i]))
const label = (k: string): string => `${k} — a very long classification name`

function Host({ n = keys.length }: { n?: number }) {
  const [open, setOpen] = useState(false)
  return (
    <StackLegend
      keys={keys.slice(0, n)}
      label={label}
      weights={weights}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    />
  )
}

const shown = (): string[] => [...document.querySelectorAll('.stack-leg-text')].map((e) => e.textContent!)

describe('StackLegend', () => {
  it('lists every entry up to fifteen, without a toggle', () => {
    render(<Host n={15} />)
    expect(shown()).toHaveLength(15)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('folds a long legend to the ten heaviest, names the rest on hover, and unfolds on click', () => {
    render(<Host />)
    expect(shown()).toEqual(keys.slice(10).map(label))
    const more = screen.getByRole('button', { name: '+10 more' })
    // Heaviest first in the tooltip too.
    expect(more.getAttribute('title')).toBe(keys.slice(0, 10).reverse().map(label).join('\n'))
    fireEvent.click(more)
    expect(shown()).toHaveLength(20)
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
    expect(shown()).toHaveLength(10)
  })

  it('keeps the full name in the tooltip of a cut entry', () => {
    render(<Host n={3} />)
    expect(document.querySelector('.stack-leg-item')!.getAttribute('title')).toBe(label('k0'))
  })

  it('names at most 25 folded entries in the tooltip', () => {
    const many = Array.from({ length: 60 }, (_, i) => `c${i}`)
    render(<StackLegend keys={many} label={(k) => k} weights={new Map()} open={false} onToggle={() => {}} />)
    const tip = screen.getByRole('button', { name: '+50 more' }).getAttribute('title')!.split('\n')
    expect(tip).toHaveLength(26)
    expect(tip[25]).toBe('… and 25 more')
  })
})
