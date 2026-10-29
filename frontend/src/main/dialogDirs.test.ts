/**
 * Electron 43+ opens every file dialog in Downloads unless a `defaultPath` is given; dialogDirs keeps
 * the "last folder" memory the OS used to provide. Held here: a picked file remembers its folder, a
 * picked folder itself, the memory survives a fresh module (a restart), and a vanished folder is not
 * offered.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = { userData: '' }
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }))

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'prism-dialogdirs-'))
  vi.resetModules()
})
afterEach(() => rmSync(state.userData, { recursive: true, force: true }))

describe('the folder a file dialog opens in', () => {
  it('has nothing to offer before the first pick', async () => {
    const { lastDialogDir } = await import('./dialogDirs')
    expect(lastDialogDir()).toBeUndefined()
  })

  it('remembers the folder of a picked file, and a picked folder itself, across a restart', async () => {
    const data = join(state.userData, 'data')
    mkdirSync(join(data, 'sub'), { recursive: true })
    writeFileSync(join(data, 'a.xlsx'), '')
    let mod = await import('./dialogDirs')
    mod.rememberDialogPick(join(data, 'a.xlsx'), 'file')
    vi.resetModules()
    mod = await import('./dialogDirs')
    expect(mod.lastDialogDir()).toBe(data)
    mod.rememberDialogPick(join(data, 'sub'), 'directory')
    expect(mod.lastDialogDir()).toBe(join(data, 'sub'))
  })

  it('does not offer a folder that no longer exists', async () => {
    const gone = join(state.userData, 'gone')
    mkdirSync(gone)
    const mod = await import('./dialogDirs')
    mod.rememberDialogPick(gone, 'directory')
    rmSync(gone, { recursive: true })
    expect(mod.lastDialogDir()).toBeUndefined()
  })
})
