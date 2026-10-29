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

  it('turns a broken argument string into an error the model can read', async () => {
    const { s } = session()
    const oc = await s.run('get_current_model', '{not json')
    expect(oc.ok).toBe(false)
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
