/**
 * The main window's guard, against a fake webContents: no second window, no navigation away from the
 * app, and web links handed to the browser whichever way they were clicked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

const openExternal = vi.fn()
vi.mock('electron', () => ({ shell: { openExternal } }))

const { guardWindow } = await import('./windowGuard')

type OpenHandler = (d: { url: string }) => { action: string }
type NavHandler = (e: { preventDefault: () => void }, url: string) => void

function fakeContents(current: string): {
  contents: WebContents
  open: (url: string) => { action: string }
  navigate: (url: string) => boolean
} {
  let onOpen: OpenHandler = () => ({ action: 'allow' })
  let onNav: NavHandler = () => undefined
  const contents = {
    setWindowOpenHandler: (fn: OpenHandler) => (onOpen = fn),
    on: (name: string, fn: NavHandler) => {
      if (name === 'will-navigate') onNav = fn
    },
    getURL: () => current
  } as unknown as WebContents
  guardWindow(contents)
  return {
    contents,
    open: (url) => onOpen({ url }),
    // true = the navigation was cancelled
    navigate: (url) => {
      let prevented = false
      onNav({ preventDefault: () => (prevented = true) }, url)
      return prevented
    }
  }
}

const PROD = 'file:///opt/PrismLCA/resources/app.asar/out/renderer/index.html'
const DEV = 'http://localhost:5173/'

beforeEach(() => openExternal.mockClear())

describe('the main window guard', () => {
  it('never opens a second window, and sends a middle-clicked web link to the browser', () => {
    const w = fakeContents(PROD)
    expect(w.open('https://worldsteel.org/report')).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledWith('https://worldsteel.org/report', { activate: true })
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'about:blank']) {
      expect(w.open(bad)).toEqual({ action: 'deny' })
    }
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it('lets the app reload or change its hash, and keeps it from navigating anywhere else', () => {
    const w = fakeContents(PROD)
    expect(w.navigate(`${PROD}#results`)).toBe(false)
    expect(w.navigate(`${PROD}?view=model`)).toBe(false)
    expect(w.navigate('blob:file:///3f2a-41c9')).toBe(false)
    // A file dropped beside a drop target: cancelled, and not handed to the OS either.
    expect(w.navigate('file:///home/u/datasheet.pdf')).toBe(true)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('sends a link that would have replaced the app to the browser instead', () => {
    const w = fakeContents(PROD)
    expect(w.navigate('https://example.org/')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('https://example.org/', { activate: true })
  })

  it('does not open the dev server in the browser', () => {
    const w = fakeContents(DEV)
    expect(w.navigate(`${DEV}#x`)).toBe(false)
    expect(w.navigate('http://localhost:5173/elsewhere')).toBe(true)
    expect(openExternal).not.toHaveBeenCalled()
  })
})
