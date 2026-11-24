import { describe, expect, it } from 'vitest'
import { ApiError } from '../lib/api'
import { deleteRefusal, paramInUseMessage, paramUses } from './paramInUse'

const amount = { kind: 'exchange', label: "the amount of 'Carbon dioxide, fossil' in 'bottle'", owner: null }

describe('the refusal of deleting a parameter in use', () => {
  it('sends a person to the page that changes an exchange formula, not to a tool', () => {
    expect(paramInUseMessage('mass', [amount])).toBe(
      "Not deleted: 'mass' is still used by the amount of 'Carbon dioxide, fossil' in 'bottle'. " +
        'Change the formula of that amount on the Model page first, then delete it.'
    )
  })

  it('names every kind of user with its own way out', () => {
    const told = paramInUseMessage('share', [
      { kind: 'parameter', label: "parameter 'eol'", owner: 'eol' },
      amount,
      { ...amount, label: "the amount of 'steel' in 'bottle'" },
      { kind: 'scenario', label: "scenario 'High'", owner: null }
    ])
    expect(told).toBe(
      "Not deleted: 'share' is still used by parameter 'eol', the amount of 'Carbon dioxide, fossil' in " +
        "'bottle', the amount of 'steel' in 'bottle' and scenario 'High'. Change the formula of those amounts " +
        "on the Model page, give 'eol' a value or formula without it on this page and take the override out " +
        'of that scenario on the Scenarios page first, then delete it.'
    )
    expect(told).not.toMatch(/edit_|"action"/)
  })

  it('leaves every other failure as it came', () => {
    const other = new ApiError('Parameter not found.', 404, 'param_not_found')
    expect(deleteRefusal('mass', other)).toBe(other)
    // A refusal without readable uses keeps the backend's sentence rather than inventing one.
    const bare = new ApiError('Not deleted — hint', 400, 'param_in_use', { uses: [{ kind: 1 }] })
    expect(paramUses(bare.details)).toEqual([])
    expect(deleteRefusal('mass', bare)).toBe(bare)
    const told = deleteRefusal('mass', new ApiError('x', 400, 'param_in_use', { uses: [amount] }))
    expect((told as Error).message).toMatch(/^Not deleted: 'mass' is still used by the amount/)
  })
})
