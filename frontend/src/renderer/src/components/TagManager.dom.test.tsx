import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import TagManager from './TagManager'

const noop = vi.fn()
const handlers = {
  onClose: noop,
  onGroupByTags: noop,
  onCreateGroup: noop,
  onDeleteGroup: noop,
  onAddValue: noop,
  onRemoveValue: noop,
  onMergeValue: noop,
  onMergeGroup: noop,
  confirm: noop
}

describe('the Tags window', () => {
  it('marks the open model’s groups and draws a line where the workspace’s others begin', () => {
    const { container } = render(
      <TagManager
        {...handlers}
        groups={[
          { name: 'Life-cycle phase', color: '#0a0', values: ['Production'], used: true },
          { name: 'Material', color: '#00a', values: [] },
          { name: 'Part', color: '#a00', values: [] }
        ]}
      />
    )
    expect(screen.getByText('used in this model').closest('.tagman-group')).toHaveTextContent(
      'Life-cycle phase'
    )
    expect(screen.getAllByText('Other groups in this workspace')).toHaveLength(1)
    const order = [...container.querySelectorAll('.tagman-others, .tagman-name')].map((e) => e.textContent)
    expect(order).toEqual([
      'Life-cycle phaseused in this model',
      'Other groups in this workspace',
      'Material',
      'Part'
    ])
  })

  it('draws no line when the model uses no group, or all of them', () => {
    render(<TagManager {...handlers} groups={[{ name: 'Material', color: '#00a', values: [] }]} />)
    expect(screen.queryByText('Other groups in this workspace')).toBeNull()
  })
})
