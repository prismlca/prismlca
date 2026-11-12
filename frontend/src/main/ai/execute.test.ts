import { describe, expect, it, vi } from 'vitest'

import { createToolSession, failedItems, softError, type ApiRaw } from './execute'

/** A backend that answers every call with the same body and remembers what it was asked. */
function fakeApi(body: unknown = { ok: true }, status = 200): { api: ApiRaw; calls: unknown[][] } {
  const calls: unknown[][] = []
  const api: ApiRaw = async (method, path, b, headers) => {
    calls.push([method, path, b, headers])
    return { status, body }
  }
  return { api, calls }
}

function session(over: Partial<Parameters<typeof createToolSession>[0]> = {}) {
  const { api, calls } = fakeApi()
  const s = createToolSession({
    apiRaw: api,
    headers: () => ({ 'X-Prism-Turn': 't1', 'X-Prism-Client': 'Test Client 1.0' }),
    ui: async () => ({ ok: true }),
    activeDb: 'Shampoo',
    ...over
  })
  return { s, calls }
}

describe('createToolSession', () => {
  it('builds a ctx with the session model and the run memory', () => {
    const { s } = session()
    expect(s.ctx.activeDb).toBe('Shampoo')
    expect(s.ctx.inspected).toBeInstanceOf(Set)
    expect(s.ctx.searched).toBeInstanceOf(Map)
  })

  it('sends the session headers with every backend call', async () => {
    const { s, calls } = session()
    const oc = await s.run('history', { action: 'undo' })
    expect(oc.ok).toBe(true)
    expect(calls[0][3]).toEqual({ 'X-Prism-Turn': 't1', 'X-Prism-Client': 'Test Client 1.0' })
  })

  it('reports a mutation only for a MUTATING tool that was not refused', async () => {
    const { s } = session()
    const done = await s.run('history', '{"action":"undo"}')
    expect(done.ok && done.mutated).toBe(true)
    // An action the tool rejects inside its own answer changed nothing: no reload, no repeat reset.
    const refused = await s.run('history', { action: 'explode' })
    expect(refused.ok && refused.soft).toBeTruthy()
    expect(refused.ok && refused.mutated).toBe(false)
    // A read is never a mutation, even when it succeeds.
    const read = await s.run('get_current_model', {})
    expect(read.ok && read.mutated).toBe(false)
  })

  it('refuses an unknown tool, a switched-off tool, and a call after Stop', async () => {
    const { s } = session({ disabledTools: ['history'] })
    const unknown = await s.run('no_such_tool', {})
    expect(!unknown.ok && unknown.error).toMatch(/Unknown tool/)
    const off = await s.run('history', { action: 'undo' })
    expect(!off.ok && off.error).toMatch(/switched off/)
    const ac = new AbortController()
    ac.abort()
    const stopped = await s.run('get_current_model', {}, { signal: ac.signal })
    expect(!stopped.ok && stopped.error).toMatch(/Stopped by the user/)
  })

  it('refuses arguments cut off on the way, runs nothing, and says what arrived', async () => {
    const { s, calls } = session()
    const oc = await s.run('search_background', '{"filtered_queries": ')
    expect(oc.ok).toBe(true)
    if (!oc.ok) return
    expect(oc.soft).toMatch(/search_background call were not valid JSON/)
    expect(oc.soft).toContain('What arrived: `{"filtered_queries": `.')
    expect(JSON.parse(oc.result).error).toBe(oc.soft)
    expect(oc.mutated).toBe(false)
    expect(calls).toEqual([])
  })

  it('refuses JSON that is not an object, naming what came', async () => {
    const { s, calls } = session()
    for (const [raw, kind] of [
      ['[]', 'an array'],
      ['null', 'null'],
      ['"x"', 'a string']
    ]) {
      const oc = await s.run('model_info', raw)
      expect(oc.ok && oc.soft, raw).toMatch(new RegExp(`must be a JSON object .*${kind}`))
    }
    expect(calls).toEqual([])
  })

  it('still reads no arguments at all as a parameterless call', async () => {
    const { s, calls } = session()
    for (const raw of ['', '  ']) {
      const oc = await s.run('list_models', raw)
      expect(oc.ok && !oc.soft, JSON.stringify(raw)).toBe(true)
    }
    expect(calls.length).toBeGreaterThan(0)
  })

  it('blocks the same broken bytes sent again, like any repeat', async () => {
    const { s } = session({ repeatEscape: 'stop and answer.' })
    const outcomes = []
    for (let i = 0; i < 5; i++) outcomes.push(await s.run('search_background', '{"filtered_queries": '))
    expect(outcomes.slice(0, 3).every((o) => o.ok && o.soft)).toBe(true)
    const blocked = outcomes.find((o) => !o.ok)
    expect(blocked && !blocked.ok && blocked.error).toMatch(/stop and answer/)
  })

  it('blocks the byte-identical repeat with the escape sentence', async () => {
    const { s } = session({ repeatEscape: 'stop and answer.' })
    const outcomes = []
    for (let i = 0; i < 5; i++) outcomes.push(await s.run('get_current_model', '{}'))
    const blocked = outcomes.find((o) => !o.ok)
    expect(blocked && !blocked.ok && blocked.error).toMatch(/stop and answer/)
  })

  it('lets a job be polled as often as it takes', async () => {
    const { s } = session()
    for (let i = 0; i < 6; i++) {
      const oc = await s.run('calculate', { database: 'Shampoo', job: 'status', job_id: 'j1' })
      expect(oc.ok, `poll ${i}`).toBe(true)
    }
    // The guard still holds for everything else.
    const outcomes = []
    for (let i = 0; i < 5; i++)
      outcomes.push(await s.run('calculate', { database: 'Shampoo', code: 'c', method: ['m'] }))
    expect(outcomes.some((o) => !o.ok)).toBe(true)
  })

  it('hands an image and a transcript back as their own fields', async () => {
    const ui = vi.fn(async (name: string) =>
      name === 'screenshot_canvas' ? { image: 'data:image/png;base64,AAAA' } : { answers: [['Option A']] }
    )
    const { s } = session({ ui })
    const shot = await s.run('screenshot_canvas', {})
    expect(shot.ok && shot.image).toBe('data:image/png;base64,AAAA')
    expect(shot.ok && shot.result).toMatch(/Screenshot captured/)
    const ask = await s.run('ask_user', {
      question: 'Which?',
      options: [{ label: 'Option A' }, { label: 'B' }]
    })
    expect(ask.ok && ask.transcript).toContain('Option A')
    expect(ask.ok && JSON.parse(ask.result).answer).toEqual(['Option A'])
  })

  it('says beside the screenshot that the app opened the model view for it', async () => {
    const ui = vi.fn(async () => ({ image: 'data:image/png;base64,AAAA', switched_to: 'model view' }))
    const { s } = session({ ui })
    const shot = await s.run('screenshot_canvas', {})
    expect(shot.ok && shot.image).toBe('data:image/png;base64,AAAA')
    expect(shot.ok && JSON.parse(shot.result)).toEqual({
      switched_to: 'model view',
      screenshot: 'see the image in the next message'
    })
  })

  it('lets the caller refuse a call before it runs, with the effect in hand', async () => {
    const seen: Array<[string, string]> = []
    const { s } = session({
      beforeRun: async (name, _args, effect) => {
        seen.push([name, effect])
        if (effect !== 'read') throw new Error('not now')
      }
    })
    const read = await s.run('get_current_model', {})
    expect(read.ok).toBe(true)
    const write = await s.run('history', { action: 'undo' })
    expect(!write.ok && write.error).toBe('not now')
    // `write`, not `irreversible`, since 229c2117: undo and redo of the assistant's own changes no
    // longer raise the approval card, so their effect is an ordinary write.
    expect(seen).toEqual([
      ['get_current_model', 'read'],
      ['history', 'write']
    ])
  })

  it('hands the gate an action named like an Object.prototype member as irreversible', async () => {
    const seen: Array<[string, string]> = []
    const { s, calls } = session({
      beforeRun: async (name, _args, effect) => {
        seen.push([name, effect])
        if (effect !== 'read') throw new Error('not now')
      }
    })
    const tags = await s.run('edit_tags', {
      action: 'constructor',
      group: 'Phase',
      assignments: [{ keys: [{ database: 'Shampoo', code: 'p1' }], value: 'Use' }]
    })
    const params = await s.run('edit_parameter', {
      action: 'valueOf',
      parameters: [{ name: 'mass', value: 2 }]
    })
    expect(!tags.ok && tags.error).toBe('not now')
    expect(!params.ok && params.error).toBe('not now')
    expect(seen).toEqual([
      ['edit_tags', 'irreversible'],
      ['edit_parameter', 'irreversible']
    ])
    expect(calls).toEqual([])
  })

  it('appends the unknown-field hint to a failed call', async () => {
    const { api } = fakeApi({ detail: [{ loc: ['body', 'action'], msg: 'Field required' }] }, 422)
    const { s } = session({ apiRaw: api })
    const oc = await s.run('history', { action: 'undo', codes: ['x'] })
    expect(!oc.ok && oc.error).toMatch(/"codes"/)
  })
})

describe('softError / failedItems', () => {
  it('read a returned refusal and a batch failure count', () => {
    expect(softError('{"error":"no"}')).toBe('no')
    expect(softError('{"ok":true}')).toBeUndefined()
    expect(softError('plain text')).toBeUndefined()
    expect(failedItems('{"total":3,"failed":2}')).toBe(2)
    expect(failedItems('{"total":3,"failed":0}')).toBeUndefined()
  })
})

describe('batch shapes the models actually send', () => {
  it('create_process creates the top-level process AND the list (V363)', async () => {
    const { s, calls } = session()
    const r = await s.run('create_process', {
      name: 'Main node',
      comment: 'FU carrier',
      processes: [{ name: 'Phase A' }, { name: 'Phase B' }]
    })
    expect(r.ok).toBe(true)
    const created = calls.filter(([m, p]) => m === 'POST' && p === '/api/v1/model/activities')
    expect(created.map((c) => (c[2] as { name: string }).name)).toEqual(['Main node', 'Phase A', 'Phase B'])
    expect(created.every((c) => (c[2] as { processes?: unknown }).processes === undefined)).toBe(true)
  })

  it('a bare database or location beside the list is not a process', async () => {
    const { s, calls } = session()
    await s.run('create_process', { database: 'Shampoo', processes: [{ name: 'Only one' }] })
    const created = calls.filter(([m, p]) => m === 'POST' && p === '/api/v1/model/activities')
    expect(created).toHaveLength(1)
  })

  it('names a corrupted field name instead of a schema symptom (V356)', async () => {
    const { s } = session()
    const corrupted =
      '{"note</arg_key> \\"0.0963 kg\\", \\"status\\": \\"completed\\"</arg_value><arg_key>steps":[{"step":"Calculate","status":"completed"}]}'
    const r = await s.run('plan', corrupted)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/arrived corrupted/)
      expect(r.error).toContain('</arg_key>')
      expect(r.error).not.toMatch(/steps must be an ARRAY/)
    }
  })
})

describe('empty optional arguments (V464)', () => {
  const body = (calls: unknown[][], path: string): any => calls.find(([, p]) => p === path)?.[2]

  it('reach the tool, the gate and the backend already dropped — not just the schema check', async () => {
    const seen: Record<string, unknown>[] = []
    const { s, calls } = session({
      beforeRun: async (_name, args) => {
        seen.push(args)
      }
    })
    const oc = await s.run('set_classification', {
      database: 'Shampoo',
      code: 'p1',
      isic: 'C',
      cpc: '',
      cpc_name: null
    })
    expect(oc.ok).toBe(true)
    expect(seen).toEqual([{ database: 'Shampoo', code: 'p1', isic: 'C' }])
    const sent = body(calls, '/api/v1/model/activities/classification')
    expect(sent).toMatchObject({ database: 'Shampoo', code: 'p1', isic: 'C' })
    expect(sent).not.toHaveProperty('cpc')
    expect(sent).not.toHaveProperty('cpc_name')
  })

  it('an all-empty phase is no phase: no filter reaches the backend (V480)', async () => {
    const { s, calls } = session()
    await s.run('explain_result', {
      mode: 'flows',
      code: 'p1',
      phase: { dimension: '', value: '' },
      top_n: 0
    })
    const sent = body(calls, '/api/v1/calc/elementary-flows')
    expect(sent).toBeTruthy()
    expect(sent).not.toHaveProperty('phase')
    // top_n 0 is "not given": the tool's own default applies.
    expect(sent.top_n).toBe(15)
  })

  it('edit_tags: value "" still clears, and empty keys are refused as missing', async () => {
    const { s, calls } = session()
    await s.run('edit_tags', {
      action: 'assign',
      group: 'G',
      keys: [{ database: 'Shampoo', code: 'p1' }],
      value: ''
    })
    const sent = body(calls, '/api/v1/model/tags/set')
    expect(sent.keys).toEqual([{ database: 'Shampoo', code: 'p1' }])
    expect(sent.value ?? null).toBeNull() // null/absent = clear (backend TagSetRequest)
    const none = await s.run('edit_tags', { action: 'assign', group: 'G', keys: [], value: 'Use' })
    expect(none.ok && none.soft).toMatch(/action="assign" also requires: keys/)
  })

  it('a batch where every item failed comes back refused, not as a success', async () => {
    const { s, calls } = session()
    const batch = {
      assignments: [
        { keys: [], value: 'Use' },
        { keys: [], value: 'End of life' }
      ]
    }
    const oc = await s.run('edit_tags', batch)
    expect(oc.ok).toBe(true)
    if (!oc.ok) return
    expect(oc.soft).toMatch(/^All 2 items failed — none succeeded/)
    expect(oc.itemsFailed).toBe(2)
    expect(calls).toEqual([])
    // An item of a writing batch can fail after part of it was written (an exchange added before its
    // formula was refused): the caches are refreshed as after a write …
    expect(oc.mutated).toBe(true)
    // … but the refusal does not lift the repeat block.
    await s.run('edit_tags', batch)
    await s.run('edit_tags', batch)
    const blocked = await s.run('edit_tags', batch)
    expect(!blocked.ok && blocked.error).toMatch(/^Blocked: .*Its last answer was: "All 2 items failed/)
  })

  it('a read batch where every item failed changes nothing', async () => {
    const { s } = session({ apiRaw: async () => ({ status: 404, body: { detail: 'not found' } }) })
    const oc = await s.run('explain_result', { mode: 'tree', code: 'p1', methods: [['A'], ['B']] })
    expect(oc.ok && oc.soft).toMatch(/^All 2 items failed/)
    expect(oc.ok && oc.mutated).toBe(false)
  })

  it('eurostat_eol: year 0 and an empty country reach the service as left out', async () => {
    const asked: unknown[] = []
    const { s } = session({
      eurostatAvailable: true,
      eurostat: async (q) => {
        asked.push(q)
        return {
          dataset: 'env_waspac',
          scope: 'DE',
          year: 2024,
          values: { rows: [], count: 0 },
          flags_and_status: { warning: null, flagged_values: 0, total_values: 0 },
          dataset_metadata: { table: 't', api_query: 'q', attribution: 'Eurostat', last_update: null }
        } as never
      }
    })
    const oc = await s.run('eurostat_eol', { dataset: 'env_waspac', country: '', year: 0, waste_code: '' })
    expect(oc.ok && !oc.soft).toBe(true)
    expect(asked).toEqual([{ dataset: 'env_waspac' }])
  })

  it('a session without a fence (MCP) runs the same rule, its exceptions included', async () => {
    const { s, calls } = session({ modelScope: undefined })
    await s.run('edit_exchange', {
      action: 'set_comment',
      activity_code: 'p1',
      uid: 'u1',
      comment: ''
    })
    // "" is an instruction here (clear the comment), kept as sent.
    expect(body(calls, '/api/v1/model/exchanges/comment')).toMatchObject({ uid: 'u1', comment: '' })
  })
})

describe('an empty required "database" in the fenced chat (V483)', () => {
  it('is the chat\'s own model, not a write into "a model the request does not name"', async () => {
    const { s, calls } = session({ modelScope: { readable: [] } })
    const oc = await s.run('set_classification', { database: '', code: 'p1', isic: 'C' })
    expect(oc.ok && !oc.soft).toBe(true)
    const sent = calls.find(([, p]) => p === '/api/v1/model/activities/classification')
    expect((sent?.[2] as { database: string }).database).toBe('Shampoo')
    expect((sent?.[3] as Record<string, string>)['X-Prism-Model']).toBe('Shampoo')
  })

  it('stays as sent outside the chat: an MCP session has no model to assume', async () => {
    const { s, calls } = session()
    await s.run('set_classification', { database: '', code: 'p1', isic: 'C' })
    const sent = calls.find(([, p]) => p === '/api/v1/model/activities/classification')
    expect((sent?.[2] as { database: string }).database).toBe('')
  })
})

describe('the repeat block quotes what the call was told (V464)', () => {
  it('names the last refusal instead of guessing at a missing argument', async () => {
    const { s } = session()
    for (let i = 0; i < 3; i++) await s.run('history', { action: 'explode' })
    const blocked = await s.run('history', { action: 'explode' })
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.error).toContain('Its last answer was: "Unknown action "explode".')
    expect(blocked.error).not.toMatch(/may be missing/)
    // The block itself is not an answer worth quoting: a fifth try still quotes the tool.
    const again = await s.run('history', { action: 'explode' })
    expect(!again.ok && again.error).toContain('Its last answer was: "Unknown action')
  })
})
