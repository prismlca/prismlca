import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import NodeContextMenu, { type CtxMenuState } from './NodeContextMenu'

/** The menu names what an entry acts on and hands every target over, not only the node clicked. */
const menu = (over: Partial<CtxMenuState>): CtxMenuState => ({
  x: 0,
  y: 0,
  id: 'ei/a',
  upstream: 4,
  readOnly: true,
  selCount: 1,
  targets: { expand: ['ei/a'], collapse: [], locked: ['ei/a'], own: [] },
  groupId: null,
  addTo: null,
  ...over
})

function open(state: CtxMenuState) {
  const handlers = {
    onExpand: vi.fn(),
    onCollapse: vi.fn(),
    onGroup: vi.fn(),
    onAddTo: vi.fn(),
    onUngroup: vi.fn(),
    onLocalize: vi.fn(),
    onDuplicate: vi.fn(),
    onToLibrary: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn()
  }
  render(<NodeContextMenu menu={state} {...handlers} />)
  return handlers
}

describe('NodeContextMenu', () => {
  it('reads as before on one node', () => {
    open(menu({}))
    expect(screen.getByText('Expand upstream (4)')).toBeTruthy()
    expect(screen.getByText('Localize (edit)')).toBeTruthy()
    expect(screen.queryByText(/Collapse/)).toBeNull()
  })

  it('on a selection, counts the processes and hands all of them over', () => {
    const h = open(
      menu({
        selCount: 3,
        targets: { expand: ['ei/a', 'ei/b'], collapse: ['ei/c'], locked: ['ei/a', 'ei/b', 'ei/c'], own: [] }
      })
    )
    fireEvent.click(screen.getByText('Expand upstream of 2 processes'))
    expect(h.onExpand).toHaveBeenCalledWith(['ei/a', 'ei/b'])
    fireEvent.click(screen.getByText('Collapse upstream of 1 process'))
    expect(h.onCollapse).toHaveBeenCalledWith(['ei/c'])
    fireEvent.click(screen.getByText('Localize 3 processes'))
    expect(h.onLocalize).toHaveBeenCalledWith(['ei/a', 'ei/b', 'ei/c'])
    fireEvent.click(screen.getByText('Remove 3 processes from canvas'))
    expect(h.onDelete).toHaveBeenCalledWith(['ei/a', 'ei/b', 'ei/c'])
  })

  it("deletes the selection's own processes from a process's menu", () => {
    const h = open(
      menu({
        id: 'm1/p',
        readOnly: false,
        selCount: 3,
        targets: { expand: [], collapse: [], locked: ['ei/a'], own: ['m1/p', 'm1/q'] }
      })
    )
    fireEvent.click(screen.getByText('Delete 2 processes'))
    expect(h.onDelete).toHaveBeenCalledWith(['m1/p', 'm1/q'])
    expect(screen.getByText('Duplicate')).toBeTruthy() // acts on the clicked process alone
  })

  it('says so when nothing has hidden upstream', () => {
    open(menu({ upstream: 0, targets: { expand: [], collapse: [], locked: ['ei/a'], own: [] } }))
    expect((screen.getByText('No hidden upstream') as HTMLButtonElement).disabled).toBe(true)
  })
})
