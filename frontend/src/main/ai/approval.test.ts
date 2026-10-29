import { describe, expect, it } from 'vitest'
import { approvalTarget, needsChatApproval } from './approval'

describe('the chat approval rule', () => {
  it('asks only for irreversible effects, never for history, never when switched off', () => {
    expect(needsChatApproval(undefined, 'delete_model', 'irreversible')).toBe(true)
    expect(needsChatApproval('irreversible', 'edit_lcia_method', 'irreversible')).toBe(true)
    expect(needsChatApproval('irreversible', 'delete_process', 'write')).toBe(false)
    expect(needsChatApproval('irreversible', 'history', 'irreversible')).toBe(false)
    expect(needsChatApproval('never', 'delete_model', 'irreversible')).toBe(false)
  })

  it('names the target from the arguments, falling back to the open model only when none is given', () => {
    expect(approvalTarget('delete_model', { database: 'production' }, 'scratch')).toBe('model "production"')
    expect(approvalTarget('delete_model', {}, 'scratch')).toBe('model "scratch"')
    expect(approvalTarget('manage_model', { action: 'rename', database: 'a', name: 'b' }, null)).toBe(
      'model "a" → "b"'
    )
    expect(approvalTarget('edit_lcia_method', { action: 'delete', method: ['My', 'GWP'] }, 'x')).toBe(
      'method "My · GWP"'
    )
    expect(approvalTarget('manage_method_family', { action: 'delete', family: 'Draft' }, 'x')).toBe(
      'family "Draft"'
    )
    // `old` wins over `family`, as in the implementation — the card must name what is renamed.
    expect(
      approvalTarget(
        'manage_method_family',
        { action: 'rename', family: 'Scratch', old: 'Production', name: 'R' },
        'x'
      )
    ).toBe('family "Production"')
    expect(approvalTarget('edit_lcia_method', { action: 'rename' }, 'x')).toBeNull()
  })
})
