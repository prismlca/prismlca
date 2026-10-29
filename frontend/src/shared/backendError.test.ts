import { describe, expect, it } from 'vitest'
import { apiError } from './backendError'

describe('apiError', () => {
  it('keeps message, hint, code and the structured details of the backend envelope', () => {
    const consumers = [{ database: 'm', code: 'b', name: 'Bottle' }]
    const e = apiError(409, {
      error: {
        code: 'delete_blocked',
        message: "'a' is consumed",
        hint: 'pass force=true',
        details: { consumers }
      }
    })
    expect(e?.message).toBe("'a' is consumed — pass force=true")
    expect(e?.code).toBe('delete_blocked')
    expect(e?.status).toBe(409)
    expect(e?.details).toEqual({ consumers })
  })

  it('has no details when the backend sends none, and no error for a healthy status', () => {
    expect(apiError(404, { error: { code: 'not_found', message: 'gone' } })?.details).toBeUndefined()
    expect(apiError(200, {})).toBeNull()
  })
})
