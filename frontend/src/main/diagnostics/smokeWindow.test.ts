import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { checkWindow, PROBE } from './smokeWindow'

type Verdict = { state: string; detail?: string; shows?: string }

/** A WebContents stand-in: events are emitted by the test, the probe answers from a list of verdicts. */
function fakeContents(verdicts: Array<Verdict | Error>, loading = false) {
  const em = new EventEmitter()
  let probes = 0
  return {
    on: (event: string, fn: (...args: unknown[]) => void) => (em.on(event, fn), undefined),
    emit: (event: string, ...args: unknown[]) => em.emit(event, ...args),
    isLoading: () => loading,
    isDestroyed: () => false,
    executeJavaScript: async () => {
      const v = verdicts[Math.min(probes++, verdicts.length - 1)]
      if (v instanceof Error) throw v
      return v
    },
    get probes() {
      return probes
    },
    setLoading: (v: boolean) => (loading = v)
  }
}

// The checker only reads the parts of WebContents the fake provides.
const check = (wc: ReturnType<typeof fakeContents>, timeoutMs = 200) =>
  checkWindow(wc as unknown as Parameters<typeof checkWindow>[0], timeoutMs, 5)

describe('checkWindow', () => {
  it('passes once the workbench has rendered and answered through the bridge', async () => {
    const wc = fakeContents([
      { state: 'waiting', shows: '' },
      { state: 'waiting', shows: '' },
      { state: 'ready' }
    ])
    expect(await check(wc)).toEqual([])
    expect(wc.probes).toBe(3)
  })

  it('does not probe a page that is still loading', async () => {
    const wc = fakeContents([{ state: 'ready' }], true)
    const result = await check(wc, 50)
    expect(wc.probes).toBe(0)
    expect(result).toEqual(['waited 0 s for the page to finish loading'])
  })

  it('fails when the workbench never renders, with what the page shows and its console errors', async () => {
    const wc = fakeContents([{ state: 'waiting', shows: 'PrismLCA is starting its local engine…' }])
    const pending = check(wc, 60)
    wc.emit('console-message', { level: 'warning', message: 'noise' })
    wc.emit('console-message', { level: 'error', message: 'Uncaught TypeError: x is undefined' })
    expect(await pending).toEqual([
      'waited 0 s for the workbench to render; the page shows: PrismLCA is starting its local engine…',
      'renderer console error: Uncaught TypeError: x is undefined'
    ])
  })

  it('reports the probe’s own verdict and a probe that throws', async () => {
    expect(await check(fakeContents([{ state: 'failed', detail: 'bridge missing' }]))).toEqual([
      'bridge missing'
    ])
    expect(await check(fakeContents([new Error("No handler registered for 'prism:api'")]))).toEqual([
      "the probe threw: Error: No handler registered for 'prism:api'"
    ])
  })

  it('fails at its deadline when the page never answers the probe', async () => {
    const wc = fakeContents([])
    wc.executeJavaScript = () => new Promise(() => {}) // a hung renderer, or a bridge call that never returns
    const started = Date.now()
    expect(await check(wc, 100)).toEqual(['the page did not answer the probe within 0.1 s'])
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('stops at a failed preload, a failed main-frame load or a crashed renderer', async () => {
    const preload = fakeContents([{ state: 'waiting', shows: '' }], true)
    const p1 = check(preload, 5_000)
    preload.emit('preload-error', {}, '/app/out/preload/index.js', new Error('Cannot find module'))
    expect(await p1).toEqual(['the preload script /app/out/preload/index.js failed: Cannot find module'])

    const load = fakeContents([{ state: 'waiting', shows: '' }], true)
    const p2 = check(load, 5_000)
    load.emit('did-fail-load', {}, -3, 'ABORTED', 'https://ads.example/frame', false)
    load.emit('did-fail-load', {}, -6, 'FILE_NOT_FOUND', 'file:///app/out/renderer/index.html', true)
    expect(await p2).toEqual([
      'the page did not load (-6 FILE_NOT_FOUND): file:///app/out/renderer/index.html'
    ])

    const gone = fakeContents([{ state: 'waiting', shows: '' }])
    const p3 = check(gone, 5_000)
    gone.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(await p3).toEqual(['the renderer process ended: crashed'])
  })
})

describe('PROBE', () => {
  // The probe runs in the page; here it runs against stand-ins for the page's `window` and `document`.
  const run = (window: unknown, document: unknown): Promise<Verdict> =>
    new Function('window', 'document', `return ${PROBE}`)(window, document)
  const page = (nav: boolean) => ({
    querySelector: (s: string) => (s === '.navitem, .setup-gate' && nav ? {} : null),
    body: { innerText: '  Starting\n  engine ' }
  })
  const bridge = (status: number) => ({
    prism: { api: async (method: string, path: string) => ({ status, body: { method, path } }) }
  })

  it('fails without the preload bridge, waits at the gate, passes on a 200 through the bridge', async () => {
    expect(await run({}, page(true))).toEqual({
      state: 'failed',
      detail: 'the preload bridge (window.prism) is missing in the page'
    })
    expect(await run(bridge(200), page(false))).toEqual({ state: 'waiting', shows: 'Starting engine' })
    expect(await run(bridge(200), page(true))).toEqual({ state: 'ready' })
    expect(await run(bridge(503), page(true))).toEqual({
      state: 'failed',
      detail: 'a request through the bridge answered 503'
    })
  })
})
