import { describe, expect, it, vi } from 'vitest'
import { validateToolArgs } from './argSchema'
import { TOOLS } from './tools/registry'

const schemaOf = (name: string): Record<string, unknown> =>
  TOOLS.find((t) => t.spec.function.name === name)!.spec.function.parameters

const check = (name: string, args: Record<string, unknown>): string | null =>
  validateToolArgs(name, schemaOf(name), args)

describe('validateToolArgs — the shapes models actually send', () => {
  it('lets a correct call through, for every tool with an empty-safe schema', () => {
    expect(check('list_models', {})).toBeNull()
    expect(check('edit_parameter', { action: 'set', name: 'mass', value: 2 })).toBeNull()
    expect(check('plan', { steps: [{ step: 'Read the model', status: 'in_progress' }] })).toBeNull()
  })

  it('names a stringified array as such (V277/V279) instead of "must be array"', () => {
    const msg = check('search_background', { queries: '["steel", "glass"]' })
    expect(msg).toMatch(/"queries" must be a JSON array/)
    expect(msg).toMatch(/arrived as ONE string/)
    expect(msg).toMatch(/send the array itself/)
    // The exit for a call the transport re-encoded (V397): named once, so the retry is not the same shape.
    expect(msg).toMatch(/single-value field/)
  })

  it('tells a model to DROP an empty list that arrived as "[]" beside the single-value field (V417b)', () => {
    // Sonnet 5.5 took the single-value exit above but kept `queries: []` beside `query`,
    // and the route delivered it as the string "[]" — four more refusals for a field it did not need.
    const msg = check('search_background', { query: 'silicone product', queries: '[]' })
    expect(msg).toMatch(/"queries" arrived as "\[\]"/)
    expect(msg).toMatch(/Drop the field entirely/)
    expect(msg).not.toMatch(/arrived as ONE string/)
  })

  it('offers strings in "queries" and objects in "filtered_queries", never a union (V417)', () => {
    // The only two arrays in the catalogue with `items.anyOf` were the only two that arrived
    // JSON-encoded as strings; 50+ homogeneous arrays in the same session came through intact.
    expect(check('search_background', { queries: ['steel', 'glass'] })).toBeNull()
    expect(
      check('search_background', { filtered_queries: [{ query: 'steel', geographies: ['DE'] }] })
    ).toBeNull()
    expect(check('search_background', { queries: [{ query: 'steel' }] })).toMatch(/queries/)
    expect(check('research_web', { questions: ['typical lifetime of a tap'] })).toBeNull()
    expect(check('research_web', { detailed_questions: [{ question: 'x', context: 'y' }] })).toBeNull()
  })

  it('names a missing required argument', () => {
    expect(check('plan', {})).toMatch(/Missing required argument "steps"/)
  })

  it('says which value an enum takes, and what arrived', () => {
    const msg = check('plan', { steps: [{ step: 'x', status: 'done' }] })
    expect(msg).toMatch(/"steps\[0\]\.status" must be one of/)
    expect(msg).toMatch(/"completed"/)
    expect(msg).toMatch(/you sent "done"/)
  })

  it('names the fields of an object an item must be (model_info limitations)', () => {
    const r = validateToolArgs('model_info', schemaOf('model_info'), {
      action: 'set',
      limitations: ['Masses are own estimates.']
    })
    expect(r).toMatch(/"limitations\[0\]" must be an object with the fields text \(required\), kind, subject/)
  })

  it('tells a number sent as a string what to send instead', () => {
    const msg = check('edit_exchange', { action: 'set_amount', activity_code: 'a', uid: 'u', amount: '2.5' })
    expect(msg).toMatch(/"amount" must be a number, not the string "2.5" — send 2.5 without quotes/)
  })

  it('tolerates null for an optional field (edit_tags "omit value to clear")', () => {
    expect(
      check('edit_tags', {
        action: 'assign',
        group: 'Life-cycle phase',
        value: null,
        keys: [{ database: 'd', code: 'c' }]
      })
    ).toBeNull()
  })

  it('reports at most three faults and counts the rest', () => {
    const msg = check('plan', {
      steps: [{ status: 'nope' }, { status: 'nope' }, { status: 'nope' }, { status: 'nope' }]
    })
    expect(msg).toBeTruthy()
    expect((msg!.match(/\. /g) ?? []).length).toBeLessThanOrEqual(5)
    expect(msg).toMatch(/\(\d+ more\)/)
  })

  it('compiles every registered tool schema', () => {
    const logged: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => void logged.push(String(m)))
    try {
      for (const t of TOOLS) validateToolArgs(t.spec.function.name, t.spec.function.parameters, {})
    } finally {
      spy.mockRestore()
    }
    expect(logged.filter((l) => /does not compile/.test(l))).toEqual([])
  })
})
