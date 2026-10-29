import { describe, expect, it } from 'vitest'
import { ORIENTATION_TOOL } from '../../mcp/catalog'
import { MUTATING_TOOLS, PARALLEL_SAFE_TOOLS, TOOLS } from './registry'
import { ACTION_PARAM, TOOL_EFFECTS, changesStructure, effectOf, toolAnnotations } from './effects'

type Props = Record<string, { description?: string; enum?: string[]; items?: { properties?: Props } }>

const propsOf = (name: string): Props =>
  ((TOOLS.find((t) => t.spec.function.name === name)?.spec.function.parameters as { properties?: Props })
    ?.properties ?? {}) as Props

/**
 * The actions a spec offers, read from the schema: an `enum` if there is one, otherwise the
 * "One of: a | b | c." / "set (default) | delete." description every consolidated tool uses.
 */
function schemaActions(prop: { description?: string; enum?: string[] }): string[] {
  if (Array.isArray(prop.enum)) return [...prop.enum].sort()
  const text = String(prop.description ?? '')
    .replace(/^\s*One of:\s*/i, '')
    .replace(/\.\s*$/, '')
  return text
    .split('|')
    .map((s) => s.replace(/\(default\)/i, '').trim())
    .sort()
}

const names = TOOLS.map((t) => t.spec.function.name)

describe('tool effects', () => {
  it('classify every registered tool, and nothing else but the MCP bootstrap tool', () => {
    for (const n of names) expect(TOOL_EFFECTS[n], n).toBeDefined()
    // `orientation` is MCP-only (mcp/catalog.ts) and a read; without its row the fail-closed default
    // showed it as IRREVERSIBLE in the External-agents drawer.
    for (const n of Object.keys(TOOL_EFFECTS)) expect([...names, ORIENTATION_TOOL], n).toContain(n)
    expect(effectOf(ORIENTATION_TOOL, {})).toBe('read')
  })

  it('list exactly the actions each schema offers', () => {
    for (const n of names) {
      const props = propsOf(n)
      const table = Object.keys(TOOL_EFFECTS[n]).sort()
      const param = ACTION_PARAM[n]
      if (!param) {
        // A tool that grows an `action` parameter must be registered in ACTION_PARAM.
        expect('action' in props, `${n} has an action parameter but no ACTION_PARAM entry`).toBe(false)
        expect(table, n).toEqual(['*'])
        continue
      }
      expect(props[param], `${n}.${param}`).toBeDefined()
      const offered = schemaActions(props[param])
      for (const a of offered) expect(a, `${n}: "${a}" is not a plain action name`).toMatch(/^[a-z_]+$/)
      expect(table, n).toEqual(offered)
      // Batch items that carry their own action must offer the same set.
      for (const [k, v] of Object.entries(props)) {
        const nested = v.items?.properties?.[param]
        if (nested) expect(schemaActions(nested), `${n}.${k}[].${param}`).toEqual(offered)
      }
    }
  })

  it('fail closed on unknown tools and actions', () => {
    expect(effectOf('no_such_tool', {})).toBe('irreversible')
    expect(effectOf('no_such_tool', undefined)).toBe('irreversible')
    expect(effectOf('canvas_view', { action: 'explode' })).toBe('irreversible')
    expect(toolAnnotations('no_such_tool')).toEqual({ readOnlyHint: false, destructiveHint: true })
  })

  it('pin the cases that matter', () => {
    expect(effectOf('get_current_model', {})).toBe('read')
    expect(effectOf('search_background', { query: 'steel' })).toBe('read')
    expect(effectOf('edit_process', { database: 'm', code: 'c' })).toBe('write')
    expect(effectOf('delete_model', { database: 'm' })).toBe('irreversible')
    // V390: the agent may take back its own change without a card.
    expect(effectOf('history', { action: 'undo' })).toBe('write')
    expect(effectOf('edit_lcia_method', { action: 'delete', method: ['a', 'b'] })).toBe('irreversible')
    expect(effectOf('edit_lcia_method', { action: 'create' })).toBe('write')
    for (const e of Object.values(TOOL_EFFECTS.canvas_view)) expect(e).not.toBe('irreversible')
    expect(effectOf('model_info', { action: 'get' })).toBe('read')
    expect(effectOf('lookup', { kind: 'geographies' })).toBe('read')
  })

  it('take the worst action of a call — missing action and batch items included', () => {
    expect(effectOf('manage_model', {})).toBe('irreversible')
    expect(effectOf('model_info', { action: '' })).toBe('write')
    expect(effectOf('edit_lcia_method', { action: 'create', items: [{ action: 'delete' }] })).toBe(
      'irreversible'
    )
    expect(effectOf('edit_exchange', { action: 'add', exchanges: [{ action: 'remove' }] })).toBe('write')
  })

  it('derive the MCP annotations from the table', () => {
    expect(toolAnnotations('list_models')).toEqual({ readOnlyHint: true, destructiveHint: false })
    // Mixed read/write: not read-only.
    expect(toolAnnotations('model_info')).toEqual({ readOnlyHint: false, destructiveHint: false })
    expect(toolAnnotations('edit_lcia_method')).toEqual({ readOnlyHint: false, destructiveHint: true })
    expect(toolAnnotations('canvas_view').destructiveHint).toBe(false)
  })

  it('agree with MUTATING_TOOLS where they overlap', () => {
    for (const n of MUTATING_TOOLS) {
      expect(TOOL_EFFECTS[n], n).toBeDefined()
      expect(
        Object.values(TOOL_EFFECTS[n]).some((e) => e !== 'read'),
        n
      ).toBe(true)
    }
  })

  // The converse does not hold and is not tested: calculate, compare_scenarios and review_model are
  // reads that must not run concurrently (see PARALLEL_SAFE_TOOLS). What must never happen is a tool
  // that writes — in any of its actions — landing in a Promise.all next to another call.
  it('let only pure reads run concurrently', () => {
    for (const n of PARALLEL_SAFE_TOOLS) {
      expect(TOOL_EFFECTS[n], n).toBeDefined()
      expect(Object.values(TOOL_EFFECTS[n]), n).toEqual(Object.values(TOOL_EFFECTS[n]).map(() => 'read'))
    }
  })
})

/**
 * Which calls end in a fitted canvas: the ones that add or remove boxes or arrows.
 * Amounts, names, tags, parameters and every read leave the user's framing alone.
 */
describe('changesStructure', () => {
  it('counts new and deleted processes, new and removed links, and undo/redo', () => {
    expect(changesStructure('create_process', { name: 'x' })).toBe(true)
    expect(changesStructure('delete_process', { code: 'x' })).toBe(true)
    expect(changesStructure('edit_exchange', { action: 'add' })).toBe(true)
    expect(changesStructure('edit_exchange', { action: 'replace_input' })).toBe(true)
    expect(changesStructure('history', { action: 'undo' })).toBe(true)
  })

  it('leaves out changes to what the canvas labels, and every read', () => {
    expect(changesStructure('edit_exchange', { action: 'set_amount' })).toBe(false)
    expect(changesStructure('edit_parameter', { action: 'set' })).toBe(false)
    expect(changesStructure('edit_process', { name: 'renamed' })).toBe(false)
    expect(changesStructure('calculate', {})).toBe(false)
    expect(changesStructure('get_model_graph', {})).toBe(false)
  })

  it('looks into batch items and counts a call without an action', () => {
    expect(
      changesStructure('edit_exchange', {
        action: 'set_amount',
        exchanges: [{ action: 'set_amount' }, { action: 'remove' }]
      })
    ).toBe(true)
    expect(changesStructure('edit_exchange', {})).toBe(true)
  })

  it('names only tools that exist, with actions they offer', () => {
    const names = new Set(TOOLS.map((t) => t.spec.function.name))
    for (const tool of ['create_process', 'delete_process', 'edit_exchange', 'history'])
      expect(names.has(tool)).toBe(true)
    expect(Object.keys(TOOL_EFFECTS.edit_exchange)).toEqual(
      expect.arrayContaining(['add', 'remove', 'replace_input'])
    )
  })
})
