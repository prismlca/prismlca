import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import TagMenu from './TagMenu'

const GROUPS = [
  { name: 'Life-cycle phase', color: '#0a0', values: ['Raw materials', 'Production'] },
  { name: 'Part', color: '#00a', values: ['Lid'] }
]
const props = {
  pos: { x: 0, y: 0 },
  groups: GROUPS,
  onSet: vi.fn(),
  onClose: vi.fn(),
  onNewGroup: vi.fn(),
  onNewValue: vi.fn()
}

describe('the tag menu of a box', () => {
  it('says what "none" means where the process using the box passes a value down', () => {
    render(<TagMenu {...props} current={{}} inherited={{ 'Life-cycle phase': 'Production' }} />)
    const [phase, part] = screen.getAllByRole('combobox') as HTMLSelectElement[]
    // Nothing is selected — the input holds no tag of its own — but the empty choice names what applies.
    expect(phase.value).toBe('')
    expect(phase.options[0].textContent).toBe('— inherited: Production —')
    expect(part.options[0].textContent).toBe('— none —')
  })

  it('lists the model’s groups in the order they arrive', () => {
    render(<TagMenu {...props} current={{}} />)
    const names = [...document.querySelectorAll('.tagmenu-group-name')].map((e) => e.textContent)
    expect(names).toEqual(['Life-cycle phase', 'Part'])
  })

  it('closes on Escape, as the other canvas menus do — its backdrop takes every click until then', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<TagMenu {...props} onClose={onClose} current={{}} />)
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'Production')
    // The menu stays open after a choice, for the next group.
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('lets Escape in the "new tag" field abandon only the new tag', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<TagMenu {...props} onClose={onClose} current={{}} />)
    await user.click(screen.getByTitle('Add a tag to "Part"'))
    await user.type(screen.getByPlaceholderText('New tag for "Part"…'), 'Bott{Escape}')
    expect(screen.queryByPlaceholderText('New tag for "Part"…')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
