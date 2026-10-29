/**
 * The core IPC handlers, registered against a fake ipcMain and called the way the preload calls them.
 *
 * The helpers under them had tests; the handlers had none, so the one filter that keeps
 * a renderer from opening `file:///…` or `javascript:` through the OS was untested — a regression that
 * dropped it left every test green.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const openExternal = vi.fn()

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  shell: { openExternal, openPath: async () => '', showItemInFolder: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  app: { getSystemLocale: () => 'de-DE' }
}))

const { registerCore } = await import('./coreIpc')

beforeEach(() => {
  handlers.clear()
  openExternal.mockClear()
  registerCore({
    apiRequest: async (method, path) => ({ status: 200, body: { method, path } }),
    getStatus: () => ({ phase: 'ready' })
  })
})

describe('the core IPC surface', () => {
  it('opens web links in the OS browser and nothing else', () => {
    const open = handlers.get('prism:openExternal')!
    open(null, 'https://example.org/docs')
    open(null, 'HTTP://example.org')
    expect(openExternal).toHaveBeenCalledTimes(2)
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://share/x', '', 42, null]) {
      open(null, bad)
    }
    expect(openExternal).toHaveBeenCalledTimes(2)
  })

  it('proxies an API request as sent and reads the status live', async () => {
    const api = handlers.get('prism:api')!
    expect(await api(null, { method: 'GET', path: '/api/v1/x' })).toEqual({
      status: 200,
      body: { method: 'GET', path: '/api/v1/x' }
    })
    expect(handlers.get('prism:status')!(null)).toEqual({ phase: 'ready' })
  })

  it('tells the renderer the regional format, for numbers copied to the clipboard', () => {
    expect(handlers.get('prism:systemLocale')!(null)).toBe('de-DE')
  })
})
