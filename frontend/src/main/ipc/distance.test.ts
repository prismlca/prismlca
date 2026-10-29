/**
 * The lookup IPC as the panel reaches it — registered against a fake ipcMain and called by channel.
 * What it has to get right beyond forwarding: a Stop from a window aborts THAT window's running
 * lookup (the service sees the signal), a Stop with nothing running says so, and a second lookup
 * from the same window replaces the first instead of running beside it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) }
}))
vi.mock('../secrets', () => ({
  resolve: () => ({ key: 'k', source: 'stored' }),
  setSecret: () => undefined,
  clearSecret: () => undefined,
  status: () => ({ present: true })
}))
vi.mock('../settings', () => ({ getSettings: () => ({ transport: {} }) }))
vi.mock('../distance/usage', () => ({
  getDistanceUsage: () => ({}),
  recordDistanceCalls: () => undefined,
  usedGeocodingToday: () => 0
}))
vi.mock('../distance/geocode', () => ({ suggest: async () => [] }))

// The service is the thing under the handler, not under test here: it hands back a promise that
// settles only when the test says, and exposes the signal it was given.
const runs: Array<{ signal: AbortSignal | undefined; finish: (v: unknown) => void }> = []
vi.mock('../distance/service', () => ({
  computeDistances: (_mode: unknown, _pairs: unknown, opts: { signal?: AbortSignal }) =>
    new Promise((resolve) => runs.push({ signal: opts.signal, finish: resolve })),
  distancesAvailable: () => true,
  effectiveGeocoder: () => 'ors'
}))

const { registerDistanceIpc } = await import('./distance')
const win = (id: number): unknown => ({ sender: { id } })

beforeEach(() => {
  handlers.clear()
  runs.length = 0
  registerDistanceIpc({ apiRequest: async () => ({ status: 200, body: {} }) })
})

describe('the distance lookup IPC', () => {
  it('Stop aborts the running lookup of the window that asked, and only that one', async () => {
    const compute = handlers.get('distance:compute')!
    const cancel = handlers.get('distance:cancel')!
    const a = compute(win(1), { mode: 'road', from: 'A', to: 'B' })
    const b = compute(win(2), { mode: 'road', from: 'C', to: 'D' })
    expect(runs).toHaveLength(2)
    expect(runs[0].signal?.aborted).toBe(false)

    expect(await cancel(win(1))).toEqual({ ok: true })
    expect(runs[0].signal?.aborted).toBe(true)
    expect(runs[1].signal?.aborted).toBe(false)

    runs[0].finish({ results: [] })
    runs[1].finish({ results: [] })
    await Promise.all([a, b])
    // Nothing left to stop — for either window.
    expect(await cancel(win(1))).toEqual({ ok: false })
    expect(await cancel(win(2))).toEqual({ ok: false })
  })

  it('a new lookup from the same window replaces the running one', async () => {
    const compute = handlers.get('distance:compute')!
    const first = compute(win(1), { mode: 'road', from: 'A', to: 'B' })
    const second = compute(win(1), { mode: 'road', from: 'A', to: 'C' })
    expect(runs[0].signal?.aborted).toBe(true)
    expect(runs[1].signal?.aborted).toBe(false)
    runs[0].finish({ results: [] })
    // The first settling late must not forget the second's controller.
    await first
    expect(await handlers.get('distance:cancel')!(win(1))).toEqual({ ok: true })
    expect(runs[1].signal?.aborted).toBe(true)
    runs[1].finish({ results: [] })
    await second
  })
})
