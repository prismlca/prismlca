import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import TagManager from './TagManager'

const handlers = () => ({
  otherModels: [] as string[],
  onAdopt: vi.fn(),
  onClose: vi.fn(),
  onGroupByTags: vi.fn(),
  onCreateGroup: vi.fn(),
  onDeleteGroup: vi.fn(),
  onAddValue: vi.fn(),
  onRemoveValue: vi.fn(),
  onMergeValue: vi.fn(),
  onMergeGroup: vi.fn(),
  describeChange: vi.fn(async (): Promise<string> => ''),
  confirm: vi.fn()
})

const GROUPS = [
  {
    name: 'Life-cycle phase',
    color: '#0a0',
    values: ['Production', 'Use', 'Refurbishment'],
    used: true,
    unused: ['Refurbishment']
  },
  { name: 'Part', color: '#a00', values: [], used: false, unused: [] }
]

describe('the Tags window', () => {
  it('lists the model’s groups in its own order, with no line between used and unused ones', () => {
    const { container } = render(<TagManager {...handlers()} groups={GROUPS} />)
    expect([...container.querySelectorAll('.tagman-name')].map((e) => e.textContent)).toEqual([
      'Life-cycle phase',
      'Part'
    ])
    expect(screen.getByText(/This model’s tag groups/)).toBeInTheDocument()
  })

  it('marks a tag no process carries and removes it without asking', () => {
    const h = handlers()
    render(<TagManager {...h} groups={GROUPS} />)
    const unused = screen.getByText('Refurbishment').closest('.tagman-chip')!
    expect(unused).toHaveClass('unused')
    expect(screen.getByText('Use').closest('.tagman-chip')).not.toHaveClass('unused')
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Refurbishment' }))
    expect(h.onRemoveValue).toHaveBeenCalledWith('Life-cycle phase', 'Refurbishment')
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it('asks before removing a tag that processes carry, naming the reports that cite it', async () => {
    const h = handlers()
    const note =
      'Report “Study” (1 chapter) cites “Use”; those figures show as missing until the chapters are updated.'
    h.describeChange.mockResolvedValue(note)
    render(<TagManager {...h} groups={GROUPS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Use' }))
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1))
    expect(h.describeChange).toHaveBeenCalledWith('Life-cycle phase', 'Use', null)
    expect(h.onRemoveValue).not.toHaveBeenCalled()
    const spec = h.confirm.mock.calls[0][0]
    expect(spec.message).toBe(
      `Remove "Use" from "Life-cycle phase" and untag all processes carrying it? ${note}`
    )
    spec.onConfirm()
    expect(h.onRemoveValue).toHaveBeenCalledWith('Life-cycle phase', 'Use')
  })

  it('says in the delete confirm what else the delete touches, and deletes on confirm', async () => {
    const h = handlers()
    h.describeChange.mockResolvedValue('“Part” is taken out of the Results split.')
    render(<TagManager {...h} groups={GROUPS} />)
    fireEvent.click(screen.getAllByTitle('Delete this group (untags every process)')[1])
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1))
    expect(h.describeChange).toHaveBeenCalledWith('Part', null, null)
    const spec = h.confirm.mock.calls[0][0]
    expect(spec.message).toBe(
      'Delete the group "Part" and remove its tags from all processes? “Part” is taken out of the Results split.'
    )
    spec.onConfirm()
    expect(h.onDeleteGroup).toHaveBeenCalledWith('Part')
  })

  it('takes over another model’s groups, and offers that only when there is another model', () => {
    const h = handlers()
    const { rerender } = render(<TagManager {...h} groups={[]} />)
    expect(screen.queryByText('Take over')).toBeNull()
    rerender(<TagManager {...h} groups={[]} otherModels={['Bottle', 'Can']} />)
    const take = screen.getByRole('button', { name: 'Take over' })
    expect(take).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Model to take the tag groups from'), { target: { value: 'Can' } })
    fireEvent.click(take)
    expect(h.onAdopt).toHaveBeenCalledWith('Can')
  })

  it('says in the merge confirm what else the merge takes along, and merges on confirm', async () => {
    const h = handlers()
    h.describeChange.mockResolvedValue('The Results split uses “Life-cycle phase” and will use “Part”.')
    render(<TagManager {...h} groups={GROUPS} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Merge into…' })[0])
    fireEvent.change(screen.getByLabelText('Merge group Life-cycle phase into'), {
      target: { value: 'Part' }
    })
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1))
    expect(h.describeChange).toHaveBeenCalledWith('Life-cycle phase', null, 'Part')
    const spec = h.confirm.mock.calls[0][0]
    expect(spec.message).toContain(
      'disappears. The Results split uses “Life-cycle phase” and will use “Part”. Undoable.'
    )
    spec.onConfirm()
    expect(h.onMergeGroup).toHaveBeenCalledWith('Life-cycle phase', 'Part')
  })

  it('asks about a value merge with nothing to add when no report cites the value', async () => {
    const h = handlers()
    render(<TagManager {...h} groups={GROUPS} />)
    fireEvent.click(screen.getByRole('button', { name: 'Merge tag Use' }))
    fireEvent.change(screen.getByLabelText('Merge tag Use into'), { target: { value: 'Production' } })
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1))
    expect(h.describeChange).toHaveBeenCalledWith('Life-cycle phase', 'Use', 'Production')
    expect(h.confirm.mock.calls[0][0].message).toMatch(/disappears from the group\. Undoable\.$/)
  })
})
