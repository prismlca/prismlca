import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import GroupTools from './GroupTools'

/**
 * The leftmost toolbar slot is a piece of *state* logic wearing three buttons: Group and Add to group
 * belong to a multi-selection, Ungroup belongs to a selected box, and none of them may be reachable
 * when the canvas is showing neither. A button left over from the previous selection is the failure
 * worth a test — it would group processes that are no longer selected.
 *
 * Nothing here asks for a colour any more, and that is asserted too: a swatch row in the toolbar would
 * mean the question came back.
 */
const tools = (props: Partial<Parameters<typeof GroupTools>[0]> = {}) => {
  const onGroup = vi.fn()
  const onAddTo = vi.fn()
  const onUngroup = vi.fn()
  const view = render(
    <GroupTools
      selectedCount={0}
      groupSelected={false}
      addTo={null}
      onGroup={onGroup}
      onAddTo={onAddTo}
      onUngroup={onUngroup}
      {...props}
    />
  )
  const rerender = (next: Partial<Parameters<typeof GroupTools>[0]>): void =>
    view.rerender(
      <GroupTools
        selectedCount={0}
        groupSelected={false}
        addTo={null}
        onGroup={onGroup}
        onAddTo={onAddTo}
        onUngroup={onUngroup}
        {...next}
      />
    )
  return { ...view, rerender, onGroup, onAddTo, onUngroup }
}

describe('the group slot in the canvas toolbar', () => {
  it('shows nothing until something is selected', () => {
    const { container } = tools()
    expect(container.querySelector('.group-tool')).toBeNull()
  })

  it('needs two processes — one is not a group', () => {
    const { container, rerender } = tools({ selectedCount: 1 })
    expect(container.querySelector('.group-tool')).toBeNull()

    rerender({ selectedCount: 2 })
    expect(screen.getByRole('button', { name: 'Group' })).toBeInTheDocument()
  })

  it('groups on the first click, without asking for a colour', () => {
    // The colour carries no meaning and the next unused one is always a fine answer, so the question
    // stood between the user and the thing they had asked for.
    const { onGroup, container } = tools({ selectedCount: 3 })
    fireEvent.click(screen.getByRole('button', { name: 'Group' }))
    expect(onGroup).toHaveBeenCalledTimes(1)
    expect(container.querySelector('.tint-swatch')).toBeNull()
    expect(container.querySelector('.group-palette')).toBeNull()
  })

  it('offers Add to group only when the selection reaches into exactly one box', () => {
    const { container, rerender, onAddTo } = tools({ selectedCount: 3 })
    // The precondition itself is `addTarget`'s (lib/groups.ts); here the entry must simply follow it.
    expect(screen.queryByRole('button', { name: 'Add to group' })).toBeNull()

    rerender({ selectedCount: 3, addTo: { label: 'Packaging', count: 2 } })
    const add = screen.getByRole('button', { name: 'Add to group' })
    // The title names the box and how many processes move — the entry appears beside Group, so which
    // of the two is which has to be readable without trying it.
    expect(add.title).toContain('Packaging')
    expect(add.title).toContain('2 selected processes')
    fireEvent.click(add)
    expect(onAddTo).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Group' })).toBeInTheDocument() // both, not either

    // A selected box is a different subject: no processes are selected, so there is nothing to add.
    rerender({ groupSelected: true, addTo: { label: 'Packaging', count: 2 } })
    expect(screen.queryByRole('button', { name: 'Add to group' })).toBeNull()
    expect(container.querySelector('.group-tool')).not.toBeNull()
  })

  it('swaps Group for Ungroup when a box is the selection', () => {
    const { onUngroup } = tools({ groupSelected: true })
    expect(screen.queryByRole('button', { name: 'Group' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Ungroup' }))
    expect(onUngroup).toHaveBeenCalled()
  })

  it('has no colour control of its own — the dot moved onto the box', () => {
    // The picker used to live up here, which is why the reasoning about popovers is still in the file.
    const { container } = tools({ groupSelected: true })
    expect(container.querySelector('.group-dot-btn')).toBeNull()
    expect(screen.queryByRole('button', { name: "Change the group's colour" })).toBeNull()
  })

  it('drops the whole slot when the selection it belonged to goes away', () => {
    const { container, rerender } = tools({ selectedCount: 2, addTo: { label: 'Packaging', count: 1 } })
    expect(container.querySelector('.group-tool')).not.toBeNull()
    rerender({ selectedCount: 0 })
    expect(container.querySelector('.group-tool')).toBeNull()
  })
})
