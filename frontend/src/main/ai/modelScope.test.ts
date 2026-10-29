import { describe, expect, it } from 'vitest'

import { createToolSession, type ApiRaw } from './execute'
import {
  namedDatabases,
  resolveDatabase,
  scopedDatabaseList,
  scopeRefusal,
  type KindOf,
  type ModelScope
} from './modelScope'
import { buildSystemPrompt, SCOPE_RULE } from './systemPrompt'
import { toolSpecs } from './tools'
import { loadTurnContext } from './turnContext'

const KINDS: Record<string, string> = {
  A: 'foreground',
  B: 'foreground',
  X: 'foreground',
  'My processes': 'library',
  'ecoinvent-3.12-cutoff': 'background',
  biosphere3: 'biosphere'
}
const kindOf: KindOf = async (name) => resolveDatabase(new Map(Object.entries(KINDS)), name)
const scope: ModelScope = { readable: ['B'], switchedOff: ['C'] }
const refusal = (tool: string, args: Record<string, unknown>): Promise<string | null> =>
  scopeRefusal(tool, args, 'A', scope, kindOf)

describe('scopeRefusal — what the in-app chat may name', () => {
  it('reads its own model, its comparison model and the shared databases', async () => {
    expect(await refusal('get_process_details', { database: 'A', code: 'p' })).toBeNull()
    expect(await refusal('get_process_details', { database: 'B', code: 'p' })).toBeNull()
    expect(await refusal('calculate', { database: 'B', code: 'p', method: ['m'] })).toBeNull()
    expect(await refusal('compare', { subjects: [{ database: 'A' }, { database: 'B' }] })).toBeNull()
    expect(
      await refusal('search_background', { databases: ['ecoinvent-3.12-cutoff', 'My processes'] })
    ).toBeNull()
  })

  it('does not read another model, and says how it could become readable', async () => {
    const r = await refusal('get_model_graph', { database: 'X' })
    expect(r).toContain('"X" is neither this chat\'s model nor one of its comparison models')
    expect(r).toContain('Model info → Compared with')
    expect(r).toContain('may read its comparison model(s) "B"')
  })

  it('names the switch when the model is linked but switched off in this chat', async () => {
    const r = await scopeRefusal('model_info', { action: 'get', database: 'C' }, 'A', scope, async (n) => ({
      name: n,
      kind: 'foreground'
    }))
    expect(r).toContain('switched off in this chat')
  })

  it('writes only into its own model — not a comparison model, not the library', async () => {
    expect(await refusal('create_process', { database: 'A', name: 'p' })).toBeNull()
    expect(await refusal('create_process', { database: 'B', name: 'p' })).toContain('is a comparison model')
    expect(await refusal('model_info', { action: 'set', database: 'B', goal: 'g' })).toContain('never change')
    expect(await refusal('edit_process', { database: 'My processes', code: 'p' })).toContain(
      'read-only in this chat'
    )
    expect(await refusal('create_process', { database: 'X', name: 'p' })).toContain('not "X"')
  })

  it('links inputs from the background, the biosphere, the library and itself — never from another model', async () => {
    const add = (db: string): Record<string, unknown> => ({
      action: 'add',
      activity_database: 'A',
      activity_code: 'p',
      input_database: db,
      input_code: 'q',
      amount: 1
    })
    for (const ok of ['A', 'ecoinvent-3.12-cutoff', 'biosphere3', 'My processes'])
      expect(await refusal('edit_exchange', add(ok))).toBeNull()
    expect(await refusal('edit_exchange', add('B'))).toContain('a comparison model included')
    expect(await refusal('edit_exchange', add('X'))).toContain('not from another model')
    const batch = {
      exchanges: [{ action: 'replace_input', uid: 'u', new_input_database: 'B', new_input_code: 'q' }]
    }
    expect(await refusal('edit_exchange', batch)).toContain('not from another model')
  })

  it('shows a comparison model in the result view, which writes only its own view', async () => {
    expect(await refusal('setup_results', { subjects: [{ database: 'B', code: 'q' }] })).toBeNull()
    expect(await refusal('setup_results', { subjects: [{ database: 'X', code: 'q' }] })).not.toBeNull()
  })

  it('refuses the model lifecycle but renames its own model', async () => {
    expect(await refusal('manage_model', { action: 'create', name: 'New' })).toContain(
      'cannot create a model'
    )
    expect(await refusal('manage_model', { action: 'duplicate', source: 'A', name: 'A2' })).toContain(
      'cannot copy'
    )
    expect(await refusal('delete_model', { database: 'A' })).toContain('cannot delete models')
    expect(await refusal('canvas_view', { action: 'open_model', database: 'B' })).toContain(
      'cannot open another model'
    )
    expect(await refusal('canvas_view', { action: 'open_page', page: 'results' })).toBeNull()
    expect(await refusal('manage_model', { action: 'rename', database: 'A', name: 'A2' })).toBeNull()
    expect(await refusal('manage_model', { action: 'rename', database: 'B', name: 'B2' })).not.toBeNull()
  })

  it('treats a review as a write: it records a note in the reviewed model', async () => {
    expect(await refusal('review_model', { database: 'A', code: 'p' })).toBeNull()
    expect(await refusal('review_model', { database: 'B', code: 'p' })).toContain('is a comparison model')
  })

  it('finds a database name the schema does not have, at any depth', async () => {
    expect(namedDatabases({ code: 'p', extra: { items: [{ input_database: 'X' }] } })).toEqual([
      { field: 'input_database', top: 'extra', name: 'X' }
    ])
    expect(
      await refusal('edit_parameter', { action: 'set', name: 'n', value: 1, database: 'X' })
    ).not.toBeNull()
  })

  it('resolves a name the way the backend does — case and punctuation do not count', async () => {
    expect(await refusal('get_model_graph', { database: 'x' })).toContain('"X" is neither')
    expect(await refusal('create_process', { database: 'a', name: 'p' })).toBeNull()
    expect(await refusal('get_process_details', { database: 'ECOINVENT 3.12 cutoff', code: 'p' })).toBeNull()
  })

  it('reaches an old input from another model to change or remove it, but links none', async () => {
    const edit = (action: string): Record<string, unknown> => ({
      action,
      activity_database: 'A',
      activity_code: 'p',
      input_database: 'X',
      input_code: 'q'
    })
    for (const action of ['remove', 'set_amount', 'set_comment'])
      expect(await refusal('edit_exchange', edit(action))).toBeNull()
    expect(await refusal('edit_exchange', edit('add'))).toContain('not from another model')
    const swap = { ...edit('replace_input'), new_input_database: 'My processes', new_input_code: 'lib' }
    expect(await refusal('edit_exchange', swap)).toBeNull()
    const batch = { action: 'remove', exchanges: [{ action: 'add', input_database: 'X', input_code: 'q' }] }
    expect(await refusal('edit_exchange', batch)).toContain('not from another model')
  })

  it('lets a shared input of a batch act as its items do', async () => {
    const batch = (...actions: string[]): Record<string, unknown> => ({
      activity_database: 'A',
      input_database: 'X',
      exchanges: actions.map((action) => ({ action, input_code: 'q' }))
    })
    expect(await refusal('edit_exchange', batch('remove', 'set_amount'))).toBeNull()
    expect(await refusal('edit_exchange', batch('remove', 'add'))).toContain('not from another model')
  })

  it('leaves a name that does not exist to the tool', async () => {
    expect(await refusal('get_process_details', { database: 'nope', code: 'p' })).toBeNull()
  })
})

describe('scopedDatabaseList', () => {
  it('lists the own model, the readable comparison models and the shared databases only', () => {
    const all = Object.entries(KINDS).map(([name, kind]) => ({ name, kind }))
    const r = scopedDatabaseList(all, 'A', scope)
    expect(r.databases.map((d) => d.name)).toEqual([
      'A',
      'B',
      'My processes',
      'ecoinvent-3.12-cutoff',
      'biosphere3'
    ])
    expect(r.databases.find((d) => d.name === 'B')).toMatchObject({ comparison: true })
    expect(r.scope).toContain('other models are not listed')
  })
})

describe('the fence in the shared executor', () => {
  function fenced(over: Partial<Parameters<typeof createToolSession>[0]> = {}) {
    const calls: Array<[string, string, Record<string, string> | undefined]> = []
    const api: ApiRaw = async (method, path, _b, headers) => {
      calls.push([method, path, headers])
      if (path === '/api/v1/databases')
        return { status: 200, body: Object.entries(KINDS).map(([name, kind]) => ({ name, kind })) }
      return { status: 200, body: { ok: true } }
    }
    const asked: string[] = []
    const s = createToolSession({
      apiRaw: api,
      headers: () => ({ 'X-Prism-Turn': 't1' }),
      ui: async () => ({ ok: true }),
      activeDb: 'Müller A',
      modelScope: { readable: ['B'] },
      beforeRun: async (name) => {
        asked.push(name)
      },
      ...over
    })
    return { s, calls, asked }
  }

  it('names the chat model, percent-encoded, on every backend call — the current name after a rename', async () => {
    const { s, calls } = fenced()
    await s.run('history', { action: 'undo' })
    expect(calls[0][2]).toEqual({ 'X-Prism-Turn': 't1', 'X-Prism-Model': encodeURIComponent('Müller A') })
    s.ctx.activeDb = 'Renamed'
    await s.run('history', { action: 'redo' })
    expect(calls[1][2]?.['X-Prism-Model']).toBe('Renamed')
  })

  it('refuses before the approval card and sends nothing for the refused call', async () => {
    const { s, calls, asked } = fenced()
    const oc = await s.run('manage_model', { action: 'create', name: 'New' })
    expect(oc.ok).toBe(false)
    expect(asked).toEqual([])
    expect(calls).toEqual([])
  })

  it('renames through the tool and fences the name the backend gave the model', async () => {
    const headers: Array<Record<string, string> | undefined> = []
    const api: ApiRaw = async (_m, path, _b, h) => {
      headers.push(h)
      return path === '/api/v1/databases/foreground/rename'
        ? { status: 200, body: { name: 'C', kind: 'foreground' } }
        : { status: 200, body: { ok: true } }
    }
    const s = createToolSession({
      apiRaw: api,
      headers: () => ({}),
      ui: async () => ({}),
      activeDb: 'A',
      modelScope: { readable: [] }
    })
    const oc = await s.run('manage_model', { action: 'rename', database: 'A', name: ' C ' })
    expect(oc.ok).toBe(true)
    expect(s.ctx.activeDb).toBe('C')
    await s.run('history', { action: 'undo' })
    expect(headers.at(-1)?.['X-Prism-Model']).toBe('C')
  })

  it("reads a comparison model's parameters, and refuses a database a tool would silently ignore", async () => {
    const { s, calls } = fenced()
    expect((await s.run('list_parameters', { database: 'B' })).ok).toBe(true)
    expect(calls.some(([, path]) => path === '/api/v1/params?database=B')).toBe(true)
    const ignored = await s.run('evaluate_formula', { formula: 'a*2', database: 'B' })
    expect(!ignored.ok && ignored.error).toContain('has no "database" argument')
    const own = await s.run('evaluate_formula', { formula: 'a*2', database: 'müller-a' })
    expect(own.ok).toBe(true)
    const mcp = fenced({ modelScope: undefined })
    expect((await mcp.s.run('evaluate_formula', { formula: 'a*2', database: 'B' })).ok).toBe(true)
  })

  it('stays closed when the list of databases cannot be had', async () => {
    const api: ApiRaw = async (_m, path) =>
      path === '/api/v1/databases'
        ? { status: 500, body: { error: 'down' } }
        : { status: 200, body: { ok: true } }
    const s = createToolSession({
      apiRaw: api,
      headers: () => ({}),
      ui: async () => ({}),
      activeDb: 'A',
      modelScope: { readable: [] }
    })
    const oc = await s.run('get_model_graph', { database: 'X' })
    expect(oc.ok).toBe(false)
    expect(!oc.ok && oc.error).toContain('could not check which databases exist')
  })

  it('leaves an MCP session alone: no fence, no header', async () => {
    const { s, calls } = fenced({ modelScope: undefined })
    const oc = await s.run('manage_model', { action: 'create', name: 'New' })
    expect(oc.ok).toBe(true)
    expect(calls.at(-1)?.[2]).toEqual({ 'X-Prism-Turn': 't1' })
  })

  it('filters list_models for the chat only', async () => {
    const names = async (over: Partial<Parameters<typeof createToolSession>[0]>): Promise<string[]> => {
      const oc = await fenced(over).s.run('list_models', {})
      if (!oc.ok) throw new Error(oc.error)
      return JSON.parse(oc.result).databases.map((d: { name: string }) => d.name)
    }
    expect(await names({})).not.toContain('X')
    expect(await names({ modelScope: undefined })).toContain('X')
  })
})

describe('what the chat is offered and told', () => {
  it('states the fence in the chat prompt only; the MCP orientation keeps the old line', () => {
    const chat = buildSystemPrompt({ activeDb: 'A', skills: [], modelScope: true })
    expect(chat).toContain(SCOPE_RULE)
    expect(chat).not.toContain('Prefer the **active model**')
    expect(chat).toContain('Renaming the model is **NOT undoable**')
    const mcp = buildSystemPrompt({ activeDb: 'A', skills: [] })
    expect(mcp).not.toContain(SCOPE_RULE)
    expect(mcp).toContain('Prefer the **active model** for edits unless the user names another.')
    expect(mcp).toContain(
      'Model-level operations (create/duplicate/rename/**delete** a model) are **NOT undoable**'
    )
  })

  it('still has delete_model in the shared catalogue — the chat filters it at its call site', () => {
    expect(toolSpecs(true).some((t) => t.function.name === 'delete_model')).toBe(true)
  })
})

describe('loadTurnContext', () => {
  function backend(study: unknown, fail = false): { api: ApiRaw; paths: string[] } {
    const paths: string[] = []
    const api: ApiRaw = async (_m, path) => {
      paths.push(path)
      if (fail) throw new Error('backend starting')
      if (path.startsWith('/api/v1/study?')) return { status: 200, body: study }
      return { status: 200, body: { markdown: `brief ${decodeURIComponent(path.split('=')[1])}` } }
    }
    return { api, paths }
  }

  it('reads a comparison model only when it is linked AND switched on, and briefs only those', async () => {
    const { api, paths } = backend({ language: 'de', compared_with: ['B', 'C'] })
    const t = await loadTurnContext(api, 'A', ['B', 'Unlinked'])
    expect(t.studyLanguage).toBe('de')
    expect(t.scope).toEqual({ readable: ['B'], switchedOff: ['C'] })
    expect(t.comparisonBriefs).toEqual(['brief B'])
    expect(paths.filter((p) => p.includes('comparison-brief'))).toHaveLength(1)
  })

  it('stays closed when the backend does not answer', async () => {
    const t = await loadTurnContext(backend(null, true).api, 'A', ['B'])
    expect(t).toEqual({
      studyLanguage: undefined,
      scope: { readable: [], switchedOff: [] },
      comparisonBriefs: []
    })
  })
})
