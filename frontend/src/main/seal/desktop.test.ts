/**
 * The desktop half of the seal against fake Electron objects: links, files and folders are written down
 * and reported done, and every dialog is cancelled the way Esc would cancel it.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Dialog, Shell } from 'electron'
import { cancelAnswer, sealDialogs, sealShell } from './desktop'
import { openSealLog, type SealEntry } from './log'

function freshLog(): { log: ReturnType<typeof openSealLog>; entries: () => SealEntry[] } {
  const path = join(mkdtempSync(join(tmpdir(), 'prism-seal-')), 'sealed.jsonl')
  const log = openSealLog(path, 'main', 4242)
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
  return { log, entries }
}

describe('sealShell', () => {
  it('writes down links, files and folders and reports them done without handing them on', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const real = { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() }
    const shell = { ...real } as unknown as Shell
    const { log, entries } = freshLog()
    sealShell(shell, log)

    await expect(shell.openExternal('https://www.prismlca.com/handbook/')).resolves.toBeUndefined()
    await expect(shell.openPath('/tmp/report.pdf')).resolves.toBe('')
    expect(shell.showItemInFolder('/tmp/report.pdf')).toBeUndefined()

    expect(real.openExternal).not.toHaveBeenCalled()
    expect(real.openPath).not.toHaveBeenCalled()
    expect(real.showItemInFolder).not.toHaveBeenCalled()
    expect(entries().map((e) => [e.kind, e.target, e.via, e.outcome, e.proc, e.pid])).toEqual([
      ['link', 'https://www.prismlca.com/handbook/', 'shell.openExternal', 'refused', 'main', 4242],
      ['open', '/tmp/report.pdf', 'shell.openPath', 'refused', 'main', 4242],
      ['reveal', '/tmp/report.pdf', 'shell.showItemInFolder', 'refused', 'main', 4242]
    ])
  })
})

describe('sealDialogs', () => {
  it('cancels every dialog, with or without a parent window, and says which one it was', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const dialog = {} as Dialog
    const { log, entries } = freshLog()
    sealDialogs(dialog, log)
    const win = { webContents: {} } as never

    await expect(
      dialog.showOpenDialog(win, { title: 'Choose a folder', properties: ['openDirectory'] })
    ).resolves.toEqual({ canceled: true, filePaths: [] })
    expect(dialog.showOpenDialogSync({ properties: ['openFile'] })).toBeUndefined()
    await expect(dialog.showSaveDialog({ title: 'Export' })).resolves.toEqual({
      canceled: true,
      filePath: ''
    })
    expect(dialog.showSaveDialogSync(win, {})).toBe('')
    await expect(
      dialog.showMessageBox({ message: 'Download the model?', buttons: ['Download', 'Quit'], cancelId: 1 })
    ).resolves.toEqual({ response: 1, checkboxChecked: false })
    expect(dialog.showMessageBoxSync(win, { message: 'Sure?', buttons: ['Yes', 'No'] })).toBe(1)
    dialog.showErrorBox('Backend', 'it stopped')
    await expect(
      dialog.showCertificateTrustDialog({ certificate: {} as never, message: 'trust?' })
    ).resolves.toBe(undefined)

    expect(entries().map((e) => [e.target, e.via, e.outcome])).toEqual([
      ['open "Choose a folder" [openDirectory]', 'dialog.showOpenDialog', 'cancelled'],
      ['open [openFile]', 'dialog.showOpenDialogSync', 'cancelled'],
      ['save "Export"', 'dialog.showSaveDialog', 'cancelled'],
      ['save', 'dialog.showSaveDialogSync', 'cancelled'],
      ['message "Download the model?"', 'dialog.showMessageBox', 'cancelled'],
      ['message "Sure?"', 'dialog.showMessageBoxSync', 'cancelled'],
      ['error "Backend": it stopped', 'dialog.showErrorBox', 'cancelled'],
      ['certificate "trust?"', 'dialog.showCertificateTrustDialog', 'cancelled']
    ])
  })

  it('answers a message box as Esc would', () => {
    expect(cancelAnswer({ message: '', buttons: ['Retry', 'Quit'], cancelId: 1 })).toBe(1)
    expect(cancelAnswer({ message: '', buttons: ['Save', '&Cancel'] })).toBe(1)
    expect(cancelAnswer({ message: '', buttons: ['Yes', 'No', 'Cancel'] })).toBe(1)
    expect(cancelAnswer({ message: '', buttons: ['Download', 'Later'] })).toBe(0)
    expect(cancelAnswer({ message: '' })).toBe(0)
    expect(cancelAnswer(undefined)).toBe(0)
  })
})
