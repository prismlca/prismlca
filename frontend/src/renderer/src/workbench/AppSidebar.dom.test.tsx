import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AppSidebar, { STUDY_NAV } from './AppSidebar'

/**
 * What the folded rail owes the user: a way back that can be seen (the panel under the navigation,
 * with a button at its foot — the fold button beside the mark is gone at that width), the page names
 * still readable as hints, and no project dropdown left in the tab order of a strip 56 px wide that
 * cannot show it.
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

  it('folded, the panel under the navigation is the way back, with a visible button at its foot', () => {
    const toggle = vi.fn()
    const { rerender } = render(<AppSidebar {...props} collapsed onToggleCollapsed={toggle} />)
    expect(document.querySelector('.side-fold')).toBeNull()
    const zone = document.querySelector('.side-expand-zone')!
    // The button is drawn inside the panel and carries the hint; the rest of the panel carries none.
    const button = screen.getByTitle('Expand sidebar')
    expect(zone.contains(button)).toBe(true)
    expect(button.querySelector('svg')).toBeTruthy()
    expect(zone.getAttribute('title')).toBeNull()
    // One control, not two: a single stop for Tab and a single name for a screen reader.
    expect(screen.getAllByRole('button', { name: 'Expand sidebar' })).toEqual([zone])
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalledTimes(1)
    expect(toggle).toHaveBeenLastCalledWith(false)
    fireEvent.click(zone)
    expect(toggle).toHaveBeenCalledTimes(2)
    expect(toggle).toHaveBeenLastCalledWith(false)
    rerender(<AppSidebar {...props} collapsed={false} onToggleCollapsed={toggle} />)
    expect(screen.queryByTitle('Expand sidebar')).toBeNull()
    fireEvent.click(screen.getByLabelText('Collapse sidebar'))
    expect(toggle).toHaveBeenLastCalledWith(true)
  })

  it('a fold that follows the window does not animate; one asked for with a click does', () => {
    const pillTransition = (): string => document.querySelector<HTMLElement>('.nav-pill')!.style.transition
    const { rerender } = render(<AppSidebar {...props} collapsed={false} snap onToggleCollapsed={vi.fn()} />)
    rerender(<AppSidebar {...props} collapsed snap onToggleCollapsed={vi.fn()} />)
    // The class switches the grid's transition off (shell.css), the pill jumps along with it.
    expect(document.querySelector('.side')!.classList.contains('side-snap')).toBe(true)
    expect(pillTransition()).toBe('none')
    // Navigating on such a rail still glides: only the fold itself is exempt.
    rerender(<AppSidebar {...props} view="results" collapsed snap onToggleCollapsed={vi.fn()} />)
    expect(pillTransition()).toBe('')
    rerender(<AppSidebar {...props} view="results" collapsed={false} onToggleCollapsed={vi.fn()} />)
    expect(document.querySelector('.side')!.classList.contains('side-snap')).toBe(false)
    expect(pillTransition()).toBe('')
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

  it('the rows are buttons in the page navigation, which Tab reaches and Enter opens', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    render(<AppSidebar {...props} onNavigate={onNavigate} collapsed={false} onToggleCollapsed={vi.fn()} />)
    const nav = screen.getByRole('navigation', { name: 'Pages' })
    const rows = within(nav).getAllByRole('button')
    expect(rows.map((r) => r.textContent?.replace('›', '').trim())).toEqual(STUDY_NAV.map((it) => it.label))
    // The page you are on is said in words too, not only by the green pill.
    expect(within(nav).getByRole('button', { current: 'page' })).toHaveAccessibleName('Model')
    await user.tab() // the fold button comes first
    await user.tab()
    expect(within(nav).getByRole('button', { name: 'Overview' })).toHaveFocus()
    await user.tab()
    await user.tab()
    await user.keyboard('{Enter}')
    expect(onNavigate).toHaveBeenLastCalledWith('parameters')
    await user.keyboard(' ')
    expect(onNavigate).toHaveBeenCalledTimes(2)
  })

  it('folded, a row is still named by its page', () => {
    render(<AppSidebar {...props} collapsed onToggleCollapsed={vi.fn()} />)
    const nav = screen.getByRole('navigation', { name: 'Pages' })
    for (const it of STUDY_NAV) expect(within(nav).getByRole('button', { name: it.label })).toBeTruthy()
  })

  it('without a model, the pages that need one are disabled and Tab passes them by', async () => {
    const user = userEvent.setup()
    render(
      <AppSidebar {...props} view="overview" activeDb={null} collapsed={false} onToggleCollapsed={vi.fn()} />
    )
    const nav = screen.getByRole('navigation', { name: 'Pages' })
    expect(within(nav).getByRole('button', { name: 'Results' })).toBeDisabled()
    expect(within(nav).getByRole('button', { name: 'LCIA' })).toBeEnabled()
    await user.tab()
    await user.tab()
    expect(within(nav).getByRole('button', { name: 'Overview' })).toHaveFocus()
    await user.tab()
    expect(within(nav).getByRole('button', { name: 'LCIA' })).toHaveFocus()
  })
})
