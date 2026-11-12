import { describe, expect, it } from 'vitest'
import { KEEP_EMPTY, withoutEmptyArgs } from './emptyArgs'
import { TOOLS } from './tools/registry'

const schemaOf = (name: string): Record<string, unknown> =>
  TOOLS.find((t) => t.spec.function.name === name)!.spec.function.parameters

const norm = (name: string, args: Record<string, unknown>): Record<string, unknown> =>
  withoutEmptyArgs(name, schemaOf(name), args)

describe('withoutEmptyArgs — the central rule', () => {
  it('drops "", whitespace, [], {} and null in optional fields', () => {
    expect(
      norm('get_process_details', {
        code: 'abc',
        database: '',
        name: '   ',
        codes: [],
        location: null,
        detail: ''
      })
    ).toEqual({ code: 'abc' })
  })

  it('never touches a required field — the tool names what is missing', () => {
    expect(norm('set_classification', { database: '', code: '', isic: '' })).toEqual({
      database: '',
      code: ''
    })
    expect(norm('explain_result', { mode: '', code: 'x' })).toEqual({ mode: '', code: 'x' })
  })

  it('drops an object whose fields are all empty: phase {"dimension": "", "value": ""} (V480)', () => {
    // GPT-6.1 Sol sent it on every explain_result call; the backend filtered every flow away and
    // answered a silent total of 0.
    expect(norm('explain_result', { mode: 'flows', code: 'x', phase: { dimension: '', value: '' } })).toEqual(
      {
        mode: 'flows',
        code: 'x'
      }
    )
    // One field said is a phase that was meant: kept as sent, for the tool to judge.
    const half = { dimension: 'Life-cycle phase', value: '' }
    expect(norm('explain_result', { mode: 'flows', code: 'x', phase: half }).phase).toEqual(half)
  })

  it('reads 0 as "not given" only in counts and the year', () => {
    expect(norm('search_background', { query: 'steel', limit: 0 })).toEqual({ query: 'steel' })
    expect(norm('explain_result', { mode: 'tree', code: 'x', top_n: 0, cutoff: 0, amount: 0 })).toEqual({
      mode: 'tree',
      code: 'x',
      cutoff: 0,
      amount: 0
    })
    expect(norm('research_bom', { product: 'lamp', max_components: 0, total_mass_kg: 0 })).toEqual({
      product: 'lamp',
      total_mass_kg: 0
    })
    expect(norm('eurostat_eol', { dataset: 'env_waspac', year: 0, country: '' })).toEqual({
      dataset: 'env_waspac'
    })
    expect(norm('edit_parameter', { name: 'share', value: 0 })).toEqual({ name: 'share', value: 0 })
    expect(norm('calculate', { code: 'x', amount: 0 })).toEqual({ code: 'x', amount: 0 })
  })

  it('follows the item schema into list items, and never drops or shortens a list item', () => {
    const out = norm('eurostat_eol', {
      queries: [
        { dataset: 'env_waspac', country: 'DE', year: 0, waste_code: '' },
        { dataset: 'env_wasmun', country: '' }
      ]
    })
    expect(out).toEqual({ queries: [{ dataset: 'env_waspac', country: 'DE' }, { dataset: 'env_wasmun' }] })
    // An item that ends up empty is still an item — the tool answers for it.
    expect(norm('edit_process', { processes: [{ comment: '' }, { code: 'a', name: '' }] })).toEqual({
      processes: [{}, { code: 'a' }]
    })
    // `""` in a list of scenarios is the baseline; a list of strings is never filtered.
    expect(norm('explain_result', { mode: 'tree', code: 'x', scenarios: ['', 's1'] }).scenarios).toEqual([
      '',
      's1'
    ])
    expect(norm('search_background', { queries: ['', 'steel'] }).queries).toEqual(['', 'steel'])
  })

  it('treats a free-form map as empty only without keys — its keys say something', () => {
    expect(norm('edit_scenario', { action: 'create', name: 'A', overrides: {} })).toEqual({
      action: 'create',
      name: 'A'
    })
    const map = { recycling_rate: '' }
    expect(norm('edit_scenario', { action: 'create', name: 'A', overrides: map }).overrides).toEqual(map)
  })

  it('leaves fields the schema does not declare as they came, and the given object unchanged', () => {
    const args = { query: 'steel', databases: [], made_up: '' }
    const out = norm('search_background', args)
    expect(out).toEqual({ query: 'steel', made_up: '' })
    expect(args).toEqual({ query: 'steel', databases: [], made_up: '' })
    const clean = { query: 'steel' }
    expect(norm('search_background', clean)).toBe(clean)
  })

  it('lets an item\'s group fall back to the call\'s instead of reading "" as a group', () => {
    const out = norm('edit_tags', {
      group: 'Life-cycle phase',
      assignments: [{ keys: [{ database: 'M', code: 'a' }], value: 'Use', group: '' }]
    })
    expect(out.assignments).toEqual([{ keys: [{ database: 'M', code: 'a' }], value: 'Use' }])
  })
})

describe('withoutEmptyArgs — where empty means something (KEEP_EMPTY)', () => {
  it('edit_exchange: "" clears formula and comment on set_formula / set_comment / set_amount', () => {
    for (const action of ['set_formula', 'set_comment', 'set_amount']) {
      const args = { action, uid: 'u1', formula: '', comment: '' }
      expect(norm('edit_exchange', args)).toEqual(args)
    }
  })

  it('edit_exchange: on replace_input (and add) an empty formula or comment is padding', () => {
    // Three observed runs: `replace_input` with `formula: ""` dropped the formula it should carry over.
    expect(
      norm('edit_exchange', {
        action: 'replace_input',
        uid: 'u1',
        new_input_code: 'n',
        formula: '',
        comment: ''
      })
    ).toEqual({ action: 'replace_input', uid: 'u1', new_input_code: 'n' })
    expect(norm('edit_exchange', { action: 'add', input_code: 'c', amount: 1, comment: '' })).toEqual({
      action: 'add',
      input_code: 'c',
      amount: 1
    })
  })

  it("edit_exchange batch: an item's own action decides, else the call's", () => {
    const out = norm('edit_exchange', {
      action: 'set_amount',
      exchanges: [
        { uid: 'a', amount: 2, comment: '' },
        { uid: 'b', action: 'set_comment', comment: '' },
        { uid: 'c', action: 'replace_input', new_input_code: 'n', comment: '', formula: '' }
      ]
    })
    expect(out.exchanges).toEqual([
      { uid: 'a', amount: 2, comment: '' },
      { uid: 'b', action: 'set_comment', comment: '' },
      { uid: 'c', action: 'replace_input', new_input_code: 'n' }
    ])
  })

  it('edit_parameter: "" clears unit and comment, single and batch; an empty group is padding', () => {
    expect(norm('edit_parameter', { name: 'm', unit: '', comment: '', group: '' })).toEqual({
      name: 'm',
      unit: '',
      comment: ''
    })
    expect(norm('edit_parameter', { parameters: [{ name: 'm', unit: '', comment: '', group: '' }] })).toEqual(
      {
        parameters: [{ name: 'm', unit: '', comment: '' }]
      }
    )
  })

  it('setup_results: split_by "" puts the split back to automatic', () => {
    expect(norm('setup_results', { tab: 'overview', split_by: '', methods: [] })).toEqual({
      tab: 'overview',
      split_by: ''
    })
  })

  it('edit_lcia_method: description "" clears the family description on create/duplicate only', () => {
    for (const action of ['create', 'duplicate']) {
      expect(norm('edit_lcia_method', { action, family: 'F', name: 'N', description: '' })).toHaveProperty(
        'description',
        ''
      )
    }
    expect(
      norm('edit_lcia_method', { action: 'rename', method: ['F', 'N'], name: 'M', description: '' })
    ).not.toHaveProperty('description')
  })

  it('search_background: an empty per-query filter lifts the call-level one; a call-level [] is padding', () => {
    const out = norm('search_background', {
      geographies: [],
      activity_types: [],
      filtered_queries: [{ query: 'steel', geographies: [], activity_types: [], limit: 0 }]
    })
    expect(out).toEqual({ filtered_queries: [{ query: 'steel', geographies: [], activity_types: [] }] })
  })

  it('edit_tags: value "" still clears on assign (as left out), and empty keys go missing', () => {
    expect(
      norm('edit_tags', { action: 'assign', group: 'G', keys: [{ database: 'M', code: 'a' }], value: '' })
    ).toEqual({ action: 'assign', group: 'G', keys: [{ database: 'M', code: 'a' }] })
    expect(norm('edit_tags', { action: 'assign', group: 'G', keys: [] })).toEqual({
      action: 'assign',
      group: 'G'
    })
  })

  it('names only fields the tool schemas declare', () => {
    for (const [tool, paths] of Object.entries(KEEP_EMPTY)) {
      const schema = schemaOf(tool) as { properties: Record<string, any> }
      for (const path of Object.keys(paths)) {
        const [head, field] = path.split('[].')
        const node = field ? schema.properties[head]?.items?.properties?.[field] : schema.properties[head]
        expect(node, `${tool} ${path}`).toBeTruthy()
      }
    }
  })
})
