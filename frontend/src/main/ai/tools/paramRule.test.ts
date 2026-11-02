import { describe, expect, it } from 'vitest'
import { RULE_SCHEMA, ruleFor } from './paramRule'

describe('the rule the assistant gives a new parameter', () => {
  it('offers no list of values, only the switch', () => {
    expect(RULE_SCHEMA.properties.kind.enum).toEqual(['positive', 'negative', 'range', 'switch'])
    expect(Object.keys(RULE_SCHEMA.properties)).not.toContain('values')
  })

  it('stores the switch as the list 0, 1 and passes the others through', () => {
    expect(ruleFor({ kind: 'switch' })).toEqual({ kind: 'list', values: [0, 1] })
    expect(ruleFor({ kind: 'range', min: 0, max: 1 })).toEqual({ kind: 'range', min: 0, max: 1 })
    expect(ruleFor({ kind: 'positive' })).toEqual({ kind: 'positive' })
  })

  it('reads a rule a model sent as a JSON string, and leaves an absent one absent', () => {
    expect(ruleFor('{"kind":"switch"}')).toEqual({ kind: 'list', values: [0, 1] })
    expect(ruleFor(undefined)).toBeUndefined()
    expect(ruleFor(null)).toBeUndefined()
  })
})
