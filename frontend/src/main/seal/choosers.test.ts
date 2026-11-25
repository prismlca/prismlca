/**
 * The choosers Chromium shows itself, against a fake window debugger: file choosers intercepted and
 * cancelled, colour choosers cancelled by the page script and reported through its binding, each written
 * down — and the window counted as sealed only once every step was accepted. The page script itself runs
 * against a minimal DOM stand-in: the click that would open a colour chooser is cancelled, others are not.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { App, WebContents } from 'electron'
import { BINDING, COLOUR_GUARD, sealChoosers } from './choosers'
import { openSealLog, type SealEntry } from './log'

function freshLog(): { log: ReturnType<typeof openSealLog>; entries: () => SealEntry[] } {
  const path = join(mkdtempSync(join(tmpdir(), 'prism-seal-')), 'sealed.jsonl')
  const entries = (): SealEntry[] => {
    try {
      return readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as SealEntry)
    } catch {
      return []
    }
  }
  return { log: openSealLog(path, 'main', 4242), entries }
}

class FakeDebugger extends EventEmitter {
  attached = false
  commands: string[] = []
  constructor(private readonly refuse: 'attach' | string | null = null) {
    super()
  }
  attach(): void {
    if (this.refuse === 'attach') throw new Error('Another debugger is already attached')
    this.attached = true
  }
  async sendCommand(method: string): Promise<unknown> {
    this.commands.push(method)
    if (method === this.refuse) throw new Error(`'${method}' wasn't found`)
    if (method === 'DOM.describeNode')
      return { node: { attributes: ['type', 'file', 'accept', 'image/*', 'aria-label', 'Upload a logo'] } }
    return {}
  }
}

function windowOpens(dbg: FakeDebugger): { entries: () => SealEntry[] } {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const app = new EventEmitter()
  const { log, entries } = freshLog()
  sealChoosers(app as unknown as App, log)
  const contents = { id: 7, debugger: dbg, isDestroyed: () => false } as unknown as WebContents
  app.emit('web-contents-created', {}, contents)
  return { entries }
}

describe('sealChoosers', () => {
  it('cancels both choosers in every new window, and writes each one down', async () => {
    const dbg = new FakeDebugger()
    const { entries } = windowOpens(dbg)
    expect(dbg.attached).toBe(true)
    await vi.waitFor(() => expect(entries()).toHaveLength(1))
    expect(dbg.commands).toEqual([
      'Page.enable',
      'Page.setInterceptFileChooserDialog',
      'Runtime.enable',
      'Runtime.addBinding',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.evaluate'
    ])
    expect(entries()[0]).toMatchObject({
      kind: 'sealed',
      target: 'choosers of window 7',
      via: 'debugger',
      outcome: 'in place'
    })

    dbg.emit('message', {}, 'Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 31 })
    await vi.waitFor(() => expect(entries()).toHaveLength(2))
    dbg.emit('message', {}, 'Runtime.bindingCalled', {
      name: BINDING,
      payload: JSON.stringify({ chooser: 'colour', label: 'Accent colour' })
    })
    dbg.emit('message', {}, 'Runtime.bindingCalled', { name: 'somethingElse', payload: '{}' })
    expect(entries().slice(1)).toEqual([
      expect.objectContaining({
        kind: 'dialog',
        target: 'file chooser (selectSingle) accept="image/*" aria-label="Upload a logo"',
        via: '<input type=file>',
        outcome: 'cancelled'
      }),
      expect.objectContaining({
        kind: 'dialog',
        target: 'colour chooser "Accent colour"',
        via: '<input type=color>',
        outcome: 'cancelled'
      })
    ])
  })

  it('writes down a window it could not seal, and one that lost its debugger', async () => {
    expect(windowOpens(new FakeDebugger('attach')).entries()[0]).toMatchObject({
      target: 'choosers of window 7: Another debugger is already attached',
      outcome: 'failed'
    })
    const refused = windowOpens(new FakeDebugger('Runtime.addBinding'))
    await vi.waitFor(() => expect(refused.entries()).toHaveLength(1))
    expect(refused.entries()[0]).toMatchObject({ kind: 'dialog', outcome: 'failed' })

    const dbg = new FakeDebugger()
    const lost = windowOpens(dbg)
    await vi.waitFor(() => expect(lost.entries()).toHaveLength(1))
    dbg.emit('detach', {}, 'target closed')
    expect(lost.entries()).toHaveLength(1) // the window closed: nothing left to guard
    dbg.emit('detach', {}, 'canceled_by_user')
    expect(lost.entries()[1]).toMatchObject({
      target: 'choosers of window 7: debugger detached (canceled_by_user)',
      outcome: 'failed'
    })
  })
})

describe('the page script', () => {
  /** A window with one listener list and an input class: enough for the guard, run as the page would. */
  function page(): {
    click: (input: object) => boolean
    showPicker: (input: object) => string | undefined
    make: (type: string, label?: string) => object
    reported: string[]
  } {
    const listeners: ((e: { target: object; preventDefault: () => void }) => void)[] = []
    const reported: string[] = []
    class HTMLInputElement {
      constructor(
        public type: string,
        private readonly label = ''
      ) {}
      getAttribute(name: string): string | null {
        return name === 'aria-label' ? this.label : null
      }
      showPicker(): string {
        return 'native picker'
      }
    }
    const window: Record<string, unknown> = {
      [BINDING]: (payload: string) => reported.push(payload),
      addEventListener: (type: string, fn: (typeof listeners)[number], capture: boolean) => {
        if (type === 'click' && capture) listeners.push(fn)
      },
      HTMLInputElement
    }
    window.window = window
    runInNewContext(COLOUR_GUARD, window)
    runInNewContext(COLOUR_GUARD, window) // a second run (the document already loaded) adds nothing
    return {
      reported,
      make: (type, label) => new HTMLInputElement(type, label),
      click: (input) => {
        let prevented = false
        for (const fn of listeners) fn({ target: input, preventDefault: () => (prevented = true) })
        return prevented
      },
      showPicker: (input) => (input as HTMLInputElement).showPicker() as string | undefined
    }
  }

  it('cancels the click and showPicker of a colour input, reports each once, and leaves the rest', () => {
    const p = page()
    expect(p.click(p.make('color', 'Accent colour'))).toBe(true)
    expect(p.showPicker(p.make('color'))).toBeUndefined()
    expect(p.click(p.make('checkbox'))).toBe(false)
    expect(p.showPicker(p.make('date'))).toBe('native picker')
    expect(p.reported.map((r) => JSON.parse(r) as unknown)).toEqual([
      { chooser: 'colour', label: 'Accent colour' },
      { chooser: 'colour', label: '' }
    ])
  })
})
