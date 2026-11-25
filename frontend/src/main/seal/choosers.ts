/**
 * The choosers Chromium shows itself, for `<input type="file">` and `<input type="color">`: neither passes
 * through Electron's `dialog`, so a sealed instance cancels them in each window over its debugger, which
 * any number of clients may share — the driver's own connection stays.
 *
 * - File choosers: Chromium hands them to the debugger (`Page.setInterceptFileChooserDialog`), which
 *   cancels them.
 * - Colour choosers have no such hand-over. A script in each page cancels the click that would open one
 *   (and `showPicker`), and reports it back through a binding.
 *
 * Each window's choosers are written down as `in place` once Chromium has accepted every step, or as
 * `failed`; doctor checks every open window has the line.
 */
import type { App, WebContents } from 'electron'
import type { SealLog } from './log'

/** The function the page script reports a cancelled colour chooser through. */
export const BINDING = '__prismSealed'

/** Runs in every page before its own scripts: a click that would open a colour chooser opens none. */
export const COLOUR_GUARD = `(() => {
  if (window.__prismSealedGuard) return
  window.__prismSealedGuard = true
  const report = (input) => {
    const label = input.getAttribute('aria-label') || input.name || input.id || ''
    try { window.${BINDING}(JSON.stringify({ chooser: 'colour', label })) } catch {}
  }
  addEventListener('click', (e) => {
    const t = e.target
    if (t instanceof HTMLInputElement && t.type === 'color') { e.preventDefault(); report(t) }
  }, true)
  const show = HTMLInputElement.prototype.showPicker
  HTMLInputElement.prototype.showPicker = function () {
    if (this.type === 'color') { report(this); return }
    return show.call(this)
  }
})()`

export function sealChoosers(app: App, log: SealLog): void {
  app.on('web-contents-created', (_e, contents: WebContents) => {
    const what = `choosers of window ${contents.id}`
    const dbg = contents.debugger
    try {
      dbg.attach('1.3')
    } catch (e) {
      log.write('dialog', `${what}: ${(e as Error).message}`, 'debugger', 'failed')
      return
    }
    // A window that closes takes its debugger with it; any other detach leaves its choosers open.
    dbg.on('detach', (_ev, reason: string) => {
      if (contents.isDestroyed() || reason === 'target closed') return
      log.write('dialog', `${what}: debugger detached (${reason})`, 'debugger', 'failed')
    })
    dbg.on('message', (_ev, method: string, params: Record<string, unknown>) => {
      if (method === 'Page.fileChooserOpened') {
        const mode = typeof params.mode === 'string' ? params.mode : 'single'
        void describeInput(contents, params.backendNodeId as number | undefined).then((input) =>
          log.write('dialog', `file chooser (${mode})${input}`, '<input type=file>', 'cancelled')
        )
      } else if (method === 'Runtime.bindingCalled' && params.name === BINDING) {
        let label = ''
        try {
          label = String((JSON.parse(String(params.payload)) as { label?: unknown }).label ?? '')
        } catch {
          /* a payload the guard did not write */
        }
        log.write('dialog', `colour chooser${label ? ` "${label}"` : ''}`, '<input type=color>', 'cancelled')
      }
    })
    // Chromium consults only an enabled Page domain: without Page.enable the interception is accepted and
    // the native dialog opens anyway. The guard goes into every new document and into the one loaded now.
    const steps: [string, Record<string, unknown>?][] = [
      ['Page.enable'],
      ['Page.setInterceptFileChooserDialog', { enabled: true, cancel: true }],
      ['Runtime.enable'],
      ['Runtime.addBinding', { name: BINDING }],
      ['Page.addScriptToEvaluateOnNewDocument', { source: COLOUR_GUARD }],
      ['Runtime.evaluate', { expression: COLOUR_GUARD }]
    ]
    steps
      .reduce<Promise<unknown>>(
        (done, [method, params]) => done.then(() => dbg.sendCommand(method, params)),
        Promise.resolve()
      )
      .then(
        () => log.write('sealed', what, 'debugger', 'in place'),
        (e: Error) => log.write('dialog', `${what}: ${e.message}`, 'debugger', 'failed')
      )
  })
}

/** What the log can say about the input that asked: its accept list and label, when the window tells. */
async function describeInput(contents: WebContents, backendNodeId: number | undefined): Promise<string> {
  if (backendNodeId === undefined || contents.isDestroyed()) return ''
  try {
    const { node } = (await contents.debugger.sendCommand('DOM.describeNode', { backendNodeId })) as {
      node: { attributes?: string[] }
    }
    const attrs = node.attributes ?? []
    const pairs: string[] = []
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (['accept', 'aria-label', 'name', 'id'].includes(attrs[i]))
        pairs.push(`${attrs[i]}="${attrs[i + 1]}"`)
    }
    return pairs.length ? ` ${pairs.join(' ')}` : ''
  } catch {
    return ''
  }
}
