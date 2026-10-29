/**
 * The view store's two promises: the canvas never waits for the backend, and nobody loses an
 * arrangement they made before the view moved out of the browser.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ method: string; path: string; body?: unknown }> = []
let getResponse: unknown = { view: {} }

vi.stubGlobal('window', {
  prism: {
    api: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      if (method === 'GET') return { status: 200, body: getResponse }
      return { status: 200, body: { view: body } }
    }
  },
  addEventListener: () => {},
  removeEventListener: () => {}
})

const store: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v
  },
  removeItem: (k: string) => {
    delete store[k]
  },
  get length() {
    return Object.keys(store).length
  },
  key: (i: number) => Object.keys(store)[i] ?? null
})

const mv = await import('./modelView')

beforeEach(() => {
  calls.length = 0
  getResponse = { view: {} }
  for (const k of Object.keys(store)) delete store[k]
})

describe('the model view store', () => {
  it('reads the pre-move keys so an old arrangement is not lost', () => {
    store['prism.canvas.M1'] = JSON.stringify({ pos: { a: { x: 1, y: 2 } }, refs: [] })
    store['prism.nodeColors'] = JSON.stringify({ a: '#93c120' })
    store['prism.ov.picked.M1'] = JSON.stringify(['m1'])
    store['prism.dr.cutoff.M1'] = JSON.stringify(0.05)
    const legacy = mv.legacyView('M1')
    expect(legacy?.layout?.pos).toEqual({ a: { x: 1, y: 2 } })
    expect(legacy?.colors).toEqual({ a: '#93c120' })
    expect(legacy?.results).toEqual({ picked: ['m1'] })
    expect(legacy?.detailed).toEqual({ cutoff: 0.05 })
  })

  it('answers synchronously from the cache — the canvas must not wait for a round trip', () => {
    store['prism.view.M2'] = JSON.stringify({ layout: { pos: { b: { x: 5, y: 6 } } } })
    expect(mv.viewSync('M2').layout).toEqual({ pos: { b: { x: 5, y: 6 } } })
    expect(calls).toHaveLength(0)
  })

  it('hands a pre-move arrangement to an empty backend exactly once', async () => {
    store['prism.canvas.M3'] = JSON.stringify({ pos: { c: { x: 7, y: 8 } } })
    getResponse = { view: {} } // backend has nothing for this model
    await mv.viewFetch('M3')
    const put = calls.filter((c) => c.method === 'PUT')
    expect(put).toHaveLength(1)
    expect((put[0].body as { view: { layout: unknown } }).view.layout).toEqual({
      pos: { c: { x: 7, y: 8 } }
    })
  })

  it('carries a pending write over to a renamed model, not to the name it left', async () => {
    // The write that is still in the 400 ms debounce when a rename lands would go to a model that no
    // longer exists — measured in the running app: a `PUT /views/<old name>` plus a cache key under it.
    mv.viewSet('M5', 'layout', { pos: { d: { x: 9, y: 9 } } })
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0) // still waiting
    mv.renameCachedView('M5', 'M5 renamed')

    const put = calls.filter((c) => c.method === 'PUT')
    expect(put).toHaveLength(1)
    expect(put[0].path).toContain(encodeURIComponent('M5 renamed'))
    expect(put[0].path).not.toContain('M5%20renamed%20') // …and only once, under the new name
    // The arrangement is the user's last action; it moves with the model rather than being dropped.
    expect(mv.viewSync('M5 renamed').layout).toEqual({ pos: { d: { x: 9, y: 9 } } })
    expect(store['prism.view.M5']).toBeUndefined()
    expect(JSON.parse(store['prism.view.M5 renamed']).layout).toEqual({ pos: { d: { x: 9, y: 9 } } })
  })

  it('takes the canvas keys along in the pending write, in memory and in the cache', () => {
    mv.viewSet('M13', 'layout', { pos: { 'M13/root': { x: 1, y: 2 } } })
    mv.renameCachedView('M13', 'M14')
    const sent = calls.filter((c) => c.method === 'PUT')
    expect((sent[0].body as { view: { layout: unknown } }).view.layout).toEqual({
      pos: { 'M14/root': { x: 1, y: 2 } }
    })
    expect(mv.viewSync('M14').layout).toEqual({ pos: { 'M14/root': { x: 1, y: 2 } } })
    expect(JSON.parse(store['prism.view.M14']).layout).toEqual({ pos: { 'M14/root': { x: 1, y: 2 } } })
  })

  it('drops a pending write and the cache when a model is deleted', () => {
    // Found in a development project: nine views under names of deleted models, written by exactly
    // this debounce firing after the delete. The request must never be made, not merely refused.
    vi.useFakeTimers()
    mv.viewSet('M9', 'layout', { pos: { a: { x: 1, y: 1 } } })
    expect(store['prism.view.M9']).toBeDefined()
    mv.forgetView('M9')
    vi.advanceTimersByTime(500)
    vi.useRealTimers()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    expect(store['prism.view.M9']).toBeUndefined()
    expect(mv.viewSync('M9')).toEqual({}) // nothing remembered in memory either
  })

  it('a field written while the server still holds nothing does not shrink the cached section', async () => {
    // The field-wise dirty merge (c75c0904) built {results: {scenSel: {}}} from an EMPTY answer and
    // uploaded that alone — colours and indicators the cache still had were gone.
    vi.useFakeTimers()
    store['prism.view.M12'] = JSON.stringify({
      results: { colors: { x: 'red' }, picked: ['climate'], scenSel: { gone: true } }
    })
    getResponse = { view: {} }
    try {
      const fetching = mv.viewFetch('M12')
      mv.viewSet('M12', 'results', { ...(mv.viewSync('M12').results as object), scenSel: {} })
      const view = await fetching
      expect(view.results).toEqual({ colors: { x: 'red' }, picked: ['climate'], scenSel: {} })
      vi.advanceTimersByTime(500)
      const put = calls.filter((c) => c.method === 'PUT')
      expect(put.length).toBeGreaterThan(0)
      expect((put.at(-1)!.body as { view: { results: unknown } }).view.results).toEqual({
        colors: { x: 'red' },
        picked: ['climate'],
        scenSel: {}
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps what was set while the GET was out, and saves that', async () => {
    // The results page fetched with baseline=true stored; the user switched it off during the round
    // trip; the late answer set it back on and the pending PUT saved it on.
    vi.useFakeTimers()
    let answer: (v: unknown) => void = () => {}
    const slow = new Promise((resolve) => {
      answer = resolve
    })
    const original = (globalThis as { window: { prism: { api: unknown } } }).window.prism.api
    ;(globalThis as { window: { prism: { api: unknown } } }).window.prism.api = async (
      method: string,
      path: string,
      body?: unknown
    ) => {
      calls.push({ method, path, body })
      if (method === 'GET') return { status: 200, body: await slow }
      return { status: 200, body: { view: body } }
    }
    try {
      const fetching = mv.viewFetch('M11')
      mv.viewSet('M11', 'results', { baseline: false })
      answer({ view: { results: { baseline: true, picked: ['m1'] }, colors: { a: '#fff' } } })
      const view = await fetching
      // The user's word on `baseline`, not the stale answer — and the answer's other fields stay: the
      // write went into an empty cache, which is not a whole section to put over the stored one.
      expect(view.results).toEqual({ baseline: false, picked: ['m1'] })
      expect(view.colors).toEqual({ a: '#fff' }) // …and the rest of the answer still lands
      vi.advanceTimersByTime(500)
      const put = calls.filter((c) => c.method === 'PUT')
      expect(put).toHaveLength(1)
      expect((put[0].body as { view: { results: unknown } }).view.results).toEqual({
        baseline: false,
        picked: ['m1']
      })
    } finally {
      ;(globalThis as { window: { prism: { api: unknown } } }).window.prism.api = original
      vi.useRealTimers()
    }
  })

  it('lets the backend win over the cache', async () => {
    store['prism.view.M4'] = JSON.stringify({ colors: { a: '#000' } })
    getResponse = { view: { colors: { a: '#fff' } } }
    const view = await mv.viewFetch('M4')
    expect(view.colors).toEqual({ a: '#fff' })
    expect(JSON.parse(store['prism.view.M4']).colors).toEqual({ a: '#fff' })
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0) // nothing to migrate
  })

  it('writes the cache at once and the backend only after the pause', async () => {
    vi.useFakeTimers()
    mv.viewSet('M5', 'colors', { a: '#111' })
    expect(JSON.parse(store['prism.view.M5']).colors).toEqual({ a: '#111' })
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    vi.advanceTimersByTime(500)
    vi.useRealTimers()
    await Promise.resolve()
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
  })

  it('collapses a drag into one write, and flush does not wait', () => {
    vi.useFakeTimers()
    for (let i = 0; i < 20; i++) mv.viewSet('M6', 'layout', { pos: { a: { x: i, y: i } } })
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0)
    mv.flushViews()
    vi.useRealTimers()
    const put = calls.filter((c) => c.method === 'PUT')
    expect(put).toHaveLength(1)
    expect(
      (put[0].body as { view: { layout: { pos: Record<string, { x: number }> } } }).view.layout.pos.a.x
    ).toBe(19)
  })

  it('keeps a section it does not know when writing another one', () => {
    store['prism.view.M7'] = JSON.stringify({ uncertainty: { seed: 3 }, colors: {} })
    mv.viewSet('M7', 'colors', { a: '#222' })
    expect(JSON.parse(store['prism.view.M7']).uncertainty).toEqual({ seed: 3 })
  })

  it('coalesces concurrent fetches of the same model into one request', async () => {
    // Nineteen useViewField call sites notice a missing model in the same render — each used to
    // be a candidate for its own round trip (found with the Results page going blank on a model
    // switch).
    getResponse = { view: { results: { subjSel: { root: true } } } }
    const [a, b] = await Promise.all([mv.viewFetch('M9'), mv.viewFetch('M9')])
    expect(a).toEqual(b)
    expect(calls.filter((c) => c.method === 'GET' && c.path.includes('M9')).length).toBe(1)
  })

  it('survives an unreachable backend by drawing from the cache', async () => {
    store['prism.view.M8'] = JSON.stringify({ colors: { a: '#333' } })
    const win = window as unknown as { prism: { api: unknown } }
    const original = win.prism.api
    win.prism.api = async () => {
      throw new Error('backend down')
    }
    const view = await mv.viewFetch('M8')
    win.prism.api = original
    expect(view.colors).toEqual({ a: '#333' })
  })
})

describe('viewLoaded (review P1)', () => {
  it('waits for a fetch still running instead of answering from the older copy', async () => {
    getResponse = { view: { results: { refCode: 'old' } } }
    await mv.viewFetch('L1')
    let release: () => void = () => {}
    const win = window as unknown as {
      prism: { api: (m: string, p: string, b?: unknown) => Promise<unknown> }
    }
    const original = win.prism.api
    win.prism.api = (m, p, b) =>
      m === 'GET'
        ? new Promise((r) => {
            release = () => r({ status: 200, body: { view: { results: { refCode: 'new' } } } })
          })
        : original(m, p, b)
    const again = mv.viewFetch('L1')
    const loaded = mv.viewLoaded('L1')
    release()
    await again
    expect(await loaded).toBe(true)
    win.prism.api = original
    expect((mv.viewSync('L1').results as { refCode: string }).refCode).toBe('new')
  })

  it('says false when the backend never answered, so nothing derived from the cache is written', async () => {
    store['prism.view.L2'] = JSON.stringify({ results: { refCode: 'cached' } })
    const win = window as unknown as { prism: { api: unknown } }
    const original = win.prism.api
    win.prism.api = async () => {
      throw new Error('backend down')
    }
    expect(await mv.viewLoaded('L2')).toBe(false)
    win.prism.api = original
  })
})

describe('renameCachedView and other models', () => {
  it("rewrites another model's cached view that compares a process of the renamed one", () => {
    store['prism.view.R1'] = JSON.stringify({
      results: { fgSubjects: [{ database: 'R2', code: 'root', name: 'x' }], refCode: 'R2/root', keys: 2 }
    })
    mv.renameCachedView('R2', 'R3')
    const r = JSON.parse(store['prism.view.R1']).results
    expect(r.fgSubjects[0].database).toBe('R3')
    expect(r.refCode).toBe('R3/root')
  })
})

describe('the cache and fields written while a request is out', () => {
  it('a field written while the GET is out outranks only that field, not the whole cached section', async () => {
    // The cache holds an old colour; the server a newer one. The Results page prunes its scenario
    // ticks before the GET returns — that write used to keep the WHOLE cached section.
    store['prism.view.D1'] = JSON.stringify({
      results: { colors: { hex: '#111111' }, scenSel: { gone: true } }
    })
    let release: () => void = () => {}
    const win = window as unknown as {
      prism: { api: (m: string, p: string, b?: unknown) => Promise<unknown> }
    }
    const original = win.prism.api
    win.prism.api = (m, p, b) =>
      m === 'GET'
        ? new Promise((r) => {
            release = () =>
              r({
                status: 200,
                body: {
                  view: { results: { colors: { hex: '#999999' }, scenSel: { gone: true }, picked: [1] } }
                }
              })
          })
        : original(m, p, b)
    const fetching = mv.viewFetch('D1')
    const cur = mv.viewSync('D1').results as Record<string, unknown>
    mv.viewSet('D1', 'results', { ...cur, scenSel: {} })
    release()
    await fetching
    win.prism.api = original
    expect(mv.viewSync('D1').results).toEqual({ colors: { hex: '#999999' }, scenSel: {}, picked: [1] })
  })

  it("sends a corrected write for another model's view after a rename", async () => {
    getResponse = {
      view: { results: { fgSubjects: [{ database: 'N2', code: 'root', name: 'x' }], keys: 2 } }
    }
    await mv.viewFetch('N1')
    calls.length = 0
    mv.renameCachedView('N2', 'N3')
    const put = calls.find((c) => c.method === 'PUT' && c.path.endsWith('/N1'))
    expect(put).toBeDefined()
    const results = (put!.body as { view: { results: { fgSubjects: { database: string }[] } } }).view.results
    expect(results.fgSubjects[0].database).toBe('N3')
  })
})

/**
 * Views are keyed by model name and a PUT lands in whichever workspace is
 * active when it arrives. With a model of the same name in two workspaces, a write still pending at
 * the switch — or the old canvas saving itself on the way out — overwrote the other workspace's view.
 */
describe('a workspace switch', () => {
  it('sends what is pending before the backend moves, drops writes while it moves, and starts clean', async () => {
    const puts = (): typeof calls => calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/Shared'))
    mv.viewSet('Shared', 'results', { marker: 'A' }) // still in its 400 ms pause
    expect(puts()).toHaveLength(0)

    const fence = await mv.beginWorkspaceSwitch()
    const sent = puts()
    expect(sent).toHaveLength(1) // into the workspace it was made in
    expect((sent[0].body as { view: { results: unknown } }).view.results).toEqual({ marker: 'A' })

    // The backend has switched; the old canvas tidies up on its way out.
    mv.viewSet('Shared', 'layout', { pos: { a: { x: 10, y: 20 } } })
    mv.flushViews()
    expect(puts()).toHaveLength(1) // nothing more went out

    mv.endWorkspaceSwitch(fence)
    expect(Object.keys(store).filter((k) => k.startsWith('prism.view.'))).toEqual([])
    expect(mv.viewSync('Shared')).toEqual({}) // B's model starts from B's server answer, not A's copy
  })

  it('carries on as before when the switch is refused', () => {
    mv.cancelWorkspaceSwitch(0)
    mv.viewSet('Kept', 'results', { marker: 'still A' })
    expect(mv.viewSync('Kept').results).toEqual({ marker: 'still A' })
  })
})

describe('a workspace switch, the asynchronous edges', () => {
  it('drops a GET that answers after the switch, and a second end does not wipe the new view', async () => {
    let release: (v: unknown) => void = () => {}
    const realApi = (window as unknown as { prism: { api: unknown } }).prism.api
    ;(window as unknown as { prism: { api: unknown } }).prism.api = async (method: string, path: string) => {
      calls.push({ method, path })
      if (method === 'GET' && path.endsWith('/Late')) return new Promise((r) => (release = r))
      return { status: 200, body: { view: { layout: { pos: { b: { x: 1, y: 1 } } } } } }
    }
    try {
      const late = mv.viewFetch('Late') // asked in workspace A
      const fence = await mv.beginWorkspaceSwitch()
      mv.endWorkspaceSwitch(fence)
      release({ status: 200, body: { view: { layout: { pos: { a: { x: 9, y: 9 } } } } } })
      expect(await late).toEqual({}) // A's answer is not taken into B
      expect(mv.viewSync('Late')).toEqual({})

      const fresh = await mv.viewFetch('InB')
      expect(fresh.layout).toEqual({ pos: { b: { x: 1, y: 1 } } })
      mv.endWorkspaceSwitch(fence) // a second end (the `finally`) is a no-op
      expect(mv.viewSync('InB').layout).toEqual({ pos: { b: { x: 1, y: 1 } } })
    } finally {
      ;(window as unknown as { prism: { api: unknown } }).prism.api = realApi
    }
  })
})

describe('two switches in a row', () => {
  it('lets only the switch that raised the fence take it down', async () => {
    const first = await mv.beginWorkspaceSwitch()
    const second = await mv.beginWorkspaceSwitch()
    mv.endWorkspaceSwitch(first) // the older one finishing late
    mv.viewSet('Guarded', 'results', { x: 1 })
    expect(mv.viewSync('Guarded').results).toBeUndefined() // still fenced: the write was dropped
    mv.endWorkspaceSwitch(second)
    mv.viewSet('Guarded', 'results', { x: 2 })
    expect(mv.viewSync('Guarded').results).toEqual({ x: 2 })
  })
})

describe('a PUT that fails', () => {
  /** PUTs answer 503 while `down` is true; GETs answer with `getResponse`. */
  async function withBackend(run: (setDown: (v: boolean) => void) => Promise<void>): Promise<void> {
    let down = true
    const w = (globalThis as { window: { prism: { api: unknown } } }).window.prism
    const original = w.api
    w.api = async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      if (method === 'GET') return { status: 200, body: getResponse }
      if (down) return { status: 503, body: { detail: 'backend restarting' } }
      return { status: 200, body: { view: body } }
    }
    try {
      await run((v) => {
        down = v
      })
    } finally {
      w.api = original
    }
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  const puts = (db: string) => calls.filter((c) => c.method === 'PUT' && c.path.endsWith(`/${db}`))

  it('stays marked, so the next flush sends it again — and a write that landed is not resent', async () => {
    await withBackend(async (setDown) => {
      mv.viewSet('F1', 'colors', { a: '#123' })
      mv.flushViews()
      await settle()
      expect(puts('F1')).toHaveLength(1)
      setDown(false)
      mv.flushViews() // no timer any more, but still marked
      await settle()
      expect(puts('F1')).toHaveLength(2)
      expect((puts('F1')[1].body as { view: { colors: unknown } }).view.colors).toEqual({ a: '#123' })
      mv.flushViews() // acknowledged now: nothing left to send
      await settle()
      expect(puts('F1')).toHaveLength(2)
    })
  })

  it('a GET answering after the failed PUT does not take the edit back', async () => {
    // The restart case: the PUT failed while the backend went down, and the next fetch answered with
    // the older stored view — which used to replace the cache, since nothing was marked any more.
    await withBackend(async () => {
      mv.viewSet('F2', 'results', { baseline: false })
      mv.flushViews()
      await settle()
      getResponse = { view: { results: { baseline: true }, colors: { a: '#fff' } } }
      const view = await mv.viewFetch('F2')
      expect(view.results).toEqual({ baseline: false })
      expect(view.colors).toEqual({ a: '#fff' })
    })
  })

  it('is forgotten with a deleted model', async () => {
    await withBackend(async () => {
      mv.viewSet('F3', 'colors', { a: '#456' })
      mv.flushViews()
      await settle()
      mv.forgetView('F3')
      mv.flushViews()
      await settle()
      expect(puts('F3')).toHaveLength(1)
    })
  })
})

describe('a rename correction while a PUT is out', () => {
  it('is not cleared by the earlier PUT landing, and is sent again when it fails itself', async () => {
    getResponse = { view: { results: { fgSubjects: [{ database: 'R2', code: 'root', name: 'x' }] } } }
    await mv.viewFetch('R1')
    const w = (globalThis as { window: { prism: { api: unknown } } }).window.prism
    const original = w.api
    // PUTs answer in the order the test releases them; the first succeeds, the second fails.
    // Other models' leftovers from earlier tests answer at once; only R1's PUTs are held.
    const held: Array<(ok: boolean) => void> = []
    w.api = (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body })
      if (method === 'GET') return Promise.resolve({ status: 200, body: getResponse })
      if (!path.endsWith('/R1')) return Promise.resolve({ status: 200, body: { view: body } })
      return new Promise((resolve) =>
        held.push((ok) => resolve(ok ? { status: 200, body: { view: body } } : { status: 503, body: {} }))
      )
    }
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) await Promise.resolve()
    }
    try {
      calls.length = 0
      mv.viewSet('R1', 'colors', { a: '#abc' })
      mv.flushViews() // PUT 1, revision of the colour edit
      mv.renameCachedView('R2', 'R3') // PUT 2, the corrected copy
      expect(held).toHaveLength(2)
      held[0](true)
      await settle()
      held[1](false)
      await settle()
      mv.flushViews()
      await settle()
      const puts = calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/R1'))
      expect(puts).toHaveLength(3)
      const last = (puts[2].body as { view: { results: { fgSubjects: { database: string }[] } } }).view
      expect(last.results.fgSubjects[0].database).toBe('R3')
      held[2](true)
      await settle()
    } finally {
      w.api = original
    }
  })
})
