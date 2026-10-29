/**
 * The folder a file dialog opens in.
 *
 * Up to Electron 42 a dialog without `defaultPath` opened wherever the OS remembered the user had
 * last been. Since Electron 43 it opens in Downloads every time ("Dialog methods default to Downloads
 * directory", Electron breaking changes). PrismLCA passed no `defaultPath` anywhere, so importing three
 * files from one folder would have meant navigating there three times. This keeps that memory
 * ourselves: the folder of the last pick, in `userData`, so it also survives a restart. Local state
 * only — a path on this machine, never sent anywhere.
 */
import { app } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const FILE = 'dialog-last-dir.json'

const storePath = (): string => join(app.getPath('userData'), FILE)

/** The folder of the last pick, if it still exists; otherwise undefined (Electron's default then). */
export function lastDialogDir(): string | undefined {
  try {
    const dir = (JSON.parse(readFileSync(storePath(), 'utf-8')) as { dir?: unknown }).dir
    return typeof dir === 'string' && existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined
  } catch {
    return undefined
  }
}

/** Remember where the user just picked: the folder itself, or the folder of a picked file. */
export function rememberDialogPick(path: string | undefined, kind: 'file' | 'directory'): void {
  if (!path) return
  try {
    writeFileSync(storePath(), JSON.stringify({ dir: kind === 'file' ? dirname(path) : path }))
  } catch (err) {
    // A folder that is not remembered only costs a click; it must never fail the pick itself.
    console.error('[dialogDirs] could not remember the folder', err)
  }
}
