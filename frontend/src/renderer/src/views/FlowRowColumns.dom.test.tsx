import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

import { FlowRow } from './ActivityEditor'

/**
 * What a flow row in the inspector spends its 271 px on.
 *
 * The unit cell shows the short form the canvas arrows use, so the column could shrink to 26 px:
 * the long forms did not fit the old 34 px either — "kilogram" ran into the comment button and
 * "ton kilometer" wrapped onto two lines. And a read-only row has no remove button, so it renders no
 * cell for it; the CSS drops its column for `.flow.ro` and the name gets the room. The comment column
 * stays only when the dataset has a comment on some flow (`.flow.ro.notes`), and a row without one then
 * keeps the cell empty so the amounts stay aligned.
 */
const flow = (unit: string | null, comment: string | null = null) => ({
  uid: 'x1',
  input: { database: 'eco', code: 'c1', name: 'market for transport, freight, lorry', unit, location: 'RER' },
  amount: 2,
  type: 'technosphere',
  direction: 'input' as const,
  formula: null,
  comment
})

const row = (
  unit: string | null,
  readOnly: boolean,
  noteColumn = false,
  comment: string | null = null
): HTMLElement => {
  const { container } = render(
    <FlowRow
      flow={flow(unit, comment)}
      readOnly={readOnly}
      reference={false}
      noteColumn={noteColumn}
      onAmount={vi.fn()}
      onFormula={vi.fn()}
      onComment={vi.fn()}
      onRemove={vi.fn()}
    />
  )
  return container.querySelector('.flow') as HTMLElement
}

describe('inspector flow row', () => {
  it('shows the short unit, with the stored long form in the tooltip', () => {
    const unit = row('ton kilometer', false).querySelector('.flow-unit') as HTMLElement
    expect(unit.textContent).toBe('tkm')
    expect(unit.title).toBe('ton kilometer')
  })

  it('keeps a unit without a short form as it is stored', () => {
    expect(row('unit', false).querySelector('.flow-unit')?.textContent).toBe('unit')
  })

  it('renders three cells when read-only and five when editable', () => {
    const ro = row('kilogram', true)
    expect(ro.className).toBe('flow ro')
    expect(ro.children).toHaveLength(3)
    expect(row('kilogram', false).children).toHaveLength(5)
  })

  it('keeps a comment column on a read-only dataset that has comments, filled or not', () => {
    const commented = row('kilogram', true, true, 'Calculated from the plant report.')
    expect(commented.className).toBe('flow ro notes')
    expect(commented.children).toHaveLength(4)
    expect(commented.querySelector('.flow-note-btn')).not.toBeNull()
    const bare = row('kilogram', true, true)
    expect(bare.children).toHaveLength(4)
    expect(bare.querySelector('.flow-note-btn')).toBeNull()
  })
})
