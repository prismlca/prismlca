/**
 * The consent gate for the search model download: no dialog when the model is there, Quit really
 * quits (through app.quit, so the backend is killed by the 'quit' handler), and Download polls the
 * backend until the model is ready while the splash shows the progress.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const showMessageBox = vi.fn()
const quit = vi.fn()
const exit = vi.fn()

vi.mock('electron', () => ({
  app: { quit: () => quit(), exit: (code: number) => exit(code) },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) }
}))

const { ensureSearchModel } = await import('./searchModel')

const TOTAL = 2_293_331_623

function state(s: string, done = 0, error: string | null = null) {
  return { status: 200, body: { state: s, bytes_done: done, bytes_total: TOTAL, error } }
}

/** An apiRequest that answers GET/POST from queues; the last answer repeats. */
function fakeApi(gets: ReturnType<typeof state>[], posts: ReturnType<typeof state>[] = []) {
  const calls: string[] = []
  const fn = vi.fn(async (method: string, path: string) => {
    calls.push(`${method} ${path}`)
    const q = method === 'GET' ? gets : posts
    return q.length > 1 ? q.shift()! : q[0]
  })
  return { fn, calls }
}

function fakeSplash() {
  return { win: {} as never, setStatus: vi.fn(), close: vi.fn() }
}

beforeEach(() => {
  showMessageBox.mockReset()
  quit.mockReset()
  exit.mockReset()
  delete process.env.PRISM_SMOKE
})

describe('ensureSearchModel', () => {
  it('asks nothing when the model is ready', async () => {
    const api = fakeApi([state('ready', TOTAL)])
    expect(await ensureSearchModel(api.fn, fakeSplash())).toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(api.calls).toEqual(['GET /api/v1/system/search-model'])
  })

  it('asks nothing headless (PRISM_SMOKE) and starts no download', async () => {
    process.env.PRISM_SMOKE = '1'
    const api = fakeApi([state('missing')])
    expect(await ensureSearchModel(api.fn, null)).toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(api.calls.some((c) => c.startsWith('POST'))).toBe(false)
  })

  it('quits on Quit, without downloading', async () => {
    showMessageBox.mockResolvedValue({ response: 1 })
    const api = fakeApi([state('missing')])
    const splash = fakeSplash()
    expect(await ensureSearchModel(api.fn, splash)).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    expect(api.calls.some((c) => c.startsWith('POST'))).toBe(false)
    // Parented to the splash window, with the two buttons and the consent text.
    const [parent, opts] = showMessageBox.mock.calls[0]
    expect(parent).toBe(splash.win)
    expect(opts.buttons).toEqual(['Download (2.3 GB)', 'Quit'])
    expect(opts.defaultId).toBe(0)
    expect(opts.cancelId).toBe(1)
    expect(opts.detail).toContain('huggingface.co')
  })

  it('downloads on Download and polls until ready', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    const api = fakeApi(
      [state('missing'), state('downloading', 800_000_000), state('ready', TOTAL)],
      [state('downloading', 0)]
    )
    const splash = fakeSplash()
    expect(await ensureSearchModel(api.fn, splash, { intervalMs: 1 })).toBe(true)
    expect(api.calls).toEqual([
      'GET /api/v1/system/search-model',
      'POST /api/v1/system/search-model/download',
      'GET /api/v1/system/search-model',
      'GET /api/v1/system/search-model'
    ])
    expect(showMessageBox).toHaveBeenCalledOnce()
    expect(quit).not.toHaveBeenCalled()
    const statuses = splash.setStatus.mock.calls
    expect(statuses[0]).toEqual(['Downloading search model… 0.0 of 2.3 GB', 55])
    expect(statuses[1][0]).toBe('Downloading search model… 0.8 of 2.3 GB')
    expect(statuses[1][1]).toBeGreaterThan(55)
    expect(statuses[1][1]).toBeLessThan(85)
  })

  it('offers Retry after a failed download, and Quit from there quits', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0 }) // Download
    showMessageBox.mockResolvedValueOnce({ response: 0 }) // Retry
    showMessageBox.mockResolvedValueOnce({ response: 1 }) // Quit
    const api = fakeApi([state('missing')], [state('error', 0, 'OSError: connection reset')])
    expect(await ensureSearchModel(api.fn, null, { intervalMs: 1 })).toBe(false)
    expect(api.calls.filter((c) => c.startsWith('POST'))).toHaveLength(2)
    const failed = showMessageBox.mock.calls[1][0]
    expect(failed.title).toBe('Download failed')
    expect(failed.detail).toContain('connection reset')
    expect(failed.buttons).toEqual(['Retry', 'Quit'])
    expect(quit).toHaveBeenCalledOnce()
  })

  it('does not block the start when the backend cannot say', async () => {
    const api = { fn: vi.fn(async () => ({ status: 404, body: { error: {} } })) }
    expect(await ensureSearchModel(api.fn, null)).toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
