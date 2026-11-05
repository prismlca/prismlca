import { describe, expect, it } from 'vitest'
import { approvalTarget, needsChatApproval } from './approval'
import { createToolSession, type ApiRaw } from './execute'

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

  it('names the family a delete or upsert acts on, whatever an undeclared `old` says', () => {
    // Only rename reads `old`.
    for (const action of ['delete', 'upsert', ' delete '])
      expect(
        approvalTarget('manage_method_family', { action, family: 'Important', old: 'Scratch' }, 'x'),
        action
      ).toBe('family "Important"')
    // No action routes nowhere; the card still names the declared field, never the alias.
    expect(approvalTarget('manage_method_family', { family: 'Important', old: 'Scratch' }, 'x')).toBe(
      'family "Important"'
    )
    // Rename keeps the implementation's precedence, including an `old` that names nothing usable.
    expect(approvalTarget('manage_method_family', { action: 'rename', family: 'F', old: '' }, 'x')).toBeNull()
  })

  it('lets an approved delete act on exactly the family the card named', async () => {
    const sent: Array<[string, unknown]> = []
    const apiRaw: ApiRaw = async (_m, path, body) => (sent.push([path, body]), { status: 200, body: {} })
    const cards: Array<string | null> = []
    const session = createToolSession({
      apiRaw,
      headers: () => ({}),
      ui: async () => ({ answers: [] }),
      activeDb: 'M',
      beforeRun: async (name, args) => {
        cards.push(approvalTarget(name, args, 'M'))
        session.ctx.preApproved = true
      }
    })
    await session.run('manage_method_family', { action: 'delete', family: 'Important', old: 'Scratch' })
    expect(cards).toEqual(['family "Important"'])
    expect(sent).toEqual([['/api/v1/lcia/family/delete', { family: 'Important' }]])
  })
})
