import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

  it('marks the groups the open model uses', () => {
    render(<TagMenu {...props} groups={[{ ...GROUPS[0], used: true }, GROUPS[1]]} current={{}} />)
    expect(screen.getAllByText('used')).toHaveLength(1)
    expect(screen.getByText('used').closest('.tagmenu-group')).toHaveTextContent('Life-cycle phase')
  })
})
