import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import AppSidebar, { STUDY_NAV } from './AppSidebar'

/**
 * What the folded rail owes the user: a way back (the panel under the navigation — the fold button
 * itself is gone at that width), the page names still readable as hints, and no project dropdown
 * left in the tab order of a strip 56 px wide that cannot show it.
 */
const props = {
  view: 'model' as const,
  onNavigate: vi.fn(),
  activeDb: 'demo',
  activeKind: 'foreground',
  projectSelect: <select data-testid="proj" />,
  projectActions: <button type="button">New</button>
}

describe('AppSidebar', () => {
  it('shows labels and the project card when open', () => {
    render(<AppSidebar {...props} collapsed={false} onToggleCollapsed={vi.fn()} />)
    expect(screen.getByText('Parameters')).toBeTruthy()
    expect(screen.getByTestId('proj')).toBeTruthy()
    expect(document.querySelector('.side-expand-zone')).toBeNull()
    // Open, the rows need no hint: the name is written on them.
    expect(document.querySelector('.navitem[title]')).toBeNull()
  })

  it('folds: no project card, every row carries its name as a hint', () => {
    render(<AppSidebar {...props} collapsed onToggleCollapsed={vi.fn()} />)
    expect(screen.queryByTestId('proj')).toBeNull()
    expect(document.querySelectorAll('.navitem[title]').length).toBe(STUDY_NAV.length)
    for (const it of STUDY_NAV) expect(screen.getByTitle(it.label)).toBeTruthy()
  })

  it('folded, the panel under the navigation is the only way back — the fold button is gone', () => {
    const toggle = vi.fn()
    const { rerender } = render(<AppSidebar {...props} collapsed onToggleCollapsed={toggle} />)
    expect(document.querySelector('.side-fold')).toBeNull()
    // No hint on the zone either: the cursor is what announces it, and a tooltip would be a second
    // announcement, which we do not want.
    expect(document.querySelector('.side-expand-zone')!.getAttribute('title')).toBeNull()
    fireEvent.click(document.querySelector('.side-expand-zone')!)
    expect(toggle).toHaveBeenLastCalledWith(false)
    rerender(<AppSidebar {...props} collapsed={false} onToggleCollapsed={toggle} />)
    fireEvent.click(screen.getByLabelText('Collapse sidebar'))
    expect(toggle).toHaveBeenLastCalledWith(true)
  })

  it('without a model, opens only Overview and LCIA and says so', () => {
    const onNavigate = vi.fn()
    render(
      <AppSidebar
        {...props}
        view="overview"
        activeDb={null}
        onNavigate={onNavigate}
        collapsed={false}
        onToggleCollapsed={vi.fn()}
      />
    )
    for (const label of ['Model', 'Parameters', 'Scenarios', 'LCIA', 'Results', 'Report', 'Overview'])
      fireEvent.click(screen.getByText(label))
    expect(onNavigate.mock.calls).toEqual([['lcia'], ['overview']])
    expect(screen.getByText('Model').closest('.navitem')?.getAttribute('title')).toBe('Create a model first')
    expect(screen.getByText('No model yet')).toBeTruthy()
  })
})
