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
const openPath = vi.fn(async (_path: string) => '')
const showItemInFolder = vi.fn()

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  shell: { openExternal, openPath, showItemInFolder },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  app: { getSystemLocale: () => 'de-DE' }
}))

const { registerCore } = await import('./coreIpc')

beforeEach(() => {
  handlers.clear()
  openExternal.mockClear()
  openPath.mockClear()
  showItemInFolder.mockClear()
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

describe('opening a chat attachment', () => {
  const SOURCES = '/ws/prism_meta/sources'
  /** The backend's answer: the index entry of `id` points at `stored`. */
  const serve = (index: Record<string, string>, status = 200): void => {
    registerCore({
      apiRequest: async (_method, path) => {
        const id = decodeURIComponent(path.split('/')[5])
        const stored = index[id]
        return stored
          ? { status, body: { path: `${SOURCES}/${stored}` } }
          : { status: 404, body: { detail: `No stored attachment '${id}'.` } }
      },
      getStatus: () => ({ phase: 'ready' })
    })
  }
  const open = (id: string, reveal?: boolean): Promise<{ path?: string; error?: string }> =>
    handlers.get('prism:openSource')!(null, id, reveal) as Promise<{ path?: string; error?: string }>

  it('opens documents, spreadsheets, PDFs, text and images with their app', async () => {
    const ids = [
      'aaaaaaaaaaaa-EPD.pdf',
      'aaaaaaaaaaaa-data.xlsx',
      'aaaaaaaaaaaa-plan.xltx',
      'aaaaaaaaaaaa-report.docx',
      'aaaaaaaaaaaa-table.csv',
      'aaaaaaaaaaaa-table.tsv',
      'aaaaaaaaaaaa-notes.txt',
      'aaaaaaaaaaaa-notes.md',
      'aaaaaaaaaaaa-run.log',
      'aaaaaaaaaaaa-photo.JPG',
      'aaaaaaaaaaaa-chart.png',
      'aaaaaaaaaaaa-chart.webp',
      'aaaaaaaaaaaa-chart.gif'
    ]
    serve(Object.fromEntries(ids.map((id) => [id, id])))
    for (const id of ids) expect(await open(id)).toEqual({ path: `${SOURCES}/${id}` })
    expect(openPath.mock.calls.map((c) => c[0])).toEqual(ids.map((id) => `${SOURCES}/${id}`))
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('shows every other kind in its folder instead of opening it', async () => {
    const ids = [
      'aaaaaaaaaaaa-readme.js',
      'aaaaaaaaaaaa-run.py',
      'aaaaaaaaaaaa-run.sh',
      'aaaaaaaaaaaa-book.xlsm',
      'aaaaaaaaaaaa-book.xltm',
      'aaaaaaaaaaaa-page.html',
      'aaaaaaaaaaaa-data.xml',
      'aaaaaaaaaaaa-tool.exe',
      'aaaaaaaaaaaa-noextension'
    ]
    serve(Object.fromEntries(ids.map((id) => [id, id])))
    for (const id of ids) {
      const r = await open(id)
      expect(r.path).toBe(`${SOURCES}/${id}`)
      expect(r.error).toMatch(/shown in its folder rather than opened/)
    }
    expect(openPath).not.toHaveBeenCalled()
    expect(showItemInFolder.mock.calls.map((c) => c[0])).toEqual(ids.map((id) => `${SOURCES}/${id}`))
    expect((await open('aaaaaaaaaaaa-readme.js')).error).toMatch(/^This \.js file /)
    expect((await open('aaaaaaaaaaaa-noextension')).error).toMatch(/^This file /)
  })

  it('acts only on the file the attachment is filed under', async () => {
    serve({
      'aaaaaaaaaaaa-EPD.pdf': 'payload.exe',
      'aaaaaaaaaaaa-b.pdf': 'aaaaaaaaaaaa-c.pdf',
      'x.exe:y.pdf': 'x.exe:y.pdf'
    })
    for (const id of ['aaaaaaaaaaaa-EPD.pdf', 'aaaaaaaaaaaa-b.pdf', 'x.exe:y.pdf']) {
      expect((await open(id)).error).toMatch(/does not match this attachment/)
      expect((await open(id, true)).error).toMatch(/does not match this attachment/)
    }
    expect(openPath).not.toHaveBeenCalled()
    expect(showItemInFolder).not.toHaveBeenCalled()
  })

  it('shows any kind in the file manager when asked to', async () => {
    serve({ 'aaaaaaaaaaaa-EPD.pdf': 'aaaaaaaaaaaa-EPD.pdf', 'aaaaaaaaaaaa-run.py': 'aaaaaaaaaaaa-run.py' })
    expect(await open('aaaaaaaaaaaa-EPD.pdf', true)).toEqual({ path: `${SOURCES}/aaaaaaaaaaaa-EPD.pdf` })
    expect(await open('aaaaaaaaaaaa-run.py', true)).toEqual({ path: `${SOURCES}/aaaaaaaaaaaa-run.py` })
    expect(showItemInFolder).toHaveBeenCalledTimes(2)
    expect(openPath).not.toHaveBeenCalled()
  })

  it("passes on the backend's refusal and the OS's reason", async () => {
    serve({})
    expect(await open('aaaaaaaaaaaa-gone.pdf')).toEqual({
      error: "No stored attachment 'aaaaaaaaaaaa-gone.pdf'."
    })
    serve({ 'aaaaaaaaaaaa-EPD.pdf': 'aaaaaaaaaaaa-EPD.pdf' })
    openPath.mockResolvedValueOnce('No application is associated with the file.')
    expect(await open('aaaaaaaaaaaa-EPD.pdf')).toEqual({
      error: 'No application is associated with the file.',
      path: `${SOURCES}/aaaaaaaaaaaa-EPD.pdf`
    })
  })
})
