/**
 * Keep the main window on PrismLCA's own page, and hand web links to the OS browser.
 *
 * The main window used to have neither a window-open handler nor a navigation guard; only the
 * splash had one. A plain click on a link in the chat was caught in the renderer and sent through
 * `prism:openExternal`, but a middle-click is a different event that nobody caught, and Electron's
 * default for it is a NEW app window with the foreign page in it — opened with the opener's
 * webPreferences, so with our preload and `window.prism` in reach of whatever site the link pointed
 * at. The links in a chat answer are written by a model, some of them straight from a web search.
 * The same hole let a stray `<a href>` without a click handler, or a file dropped next to a drop
 * target, navigate the whole window away from the app.
 */
import { shell, type WebContents } from 'electron'

/**
 * Open a real web link in the OS browser — never any other scheme (`file:`, `javascript:`, `smb:`…).
 * `activate` brings the browser to the front on macOS. Windows does that anyway. On Linux it is the
 * window manager's call: KDE/GNOME on Wayland keep an already-open browser behind PrismLCA
 * (focus-stealing prevention), and no Electron option can override that — the user's desktop setting
 * can (KDE: Window Behaviour → Focus → Focus stealing prevention).
 */
export function openInBrowser(url: unknown): void {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url, { activate: true })
}

/** Same page, at most another hash or query: what a reload or an in-app link does. */
function sameDocument(target: string, current: string): boolean {
  try {
    const a = new URL(target)
    const b = new URL(current)
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
  } catch {
    return false
  }
}

function sameOrigin(target: string, current: string): boolean {
  try {
    return new URL(target).origin === new URL(current).origin
  } catch {
    return false
  }
}

export function guardWindow(contents: WebContents): void {
  // No second app window, ever: nothing in the renderer opens one on purpose. A web link goes to the
  // browser instead, whichever way it was clicked.
  contents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const current = contents.getURL()
    // A blob: URL is one the page made itself (an export being saved), never a way out.
    if (sameDocument(url, current) || url.startsWith('blob:')) return
    event.preventDefault()
    // The dev server is http too; a link back into it is a mistake, not a page for the browser.
    if (!sameOrigin(url, current)) openInBrowser(url)
  })
}
