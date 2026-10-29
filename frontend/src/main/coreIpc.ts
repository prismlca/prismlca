/**
 * The core IPC surface: app status, backend proxy, OS dialogs, external links.
 *
 * Registered through a function like `registerAi(deps)` rather than as import side effects — the
 * two conventions used to coexist in one process, and handlers registered at module top level are
 * the ones no test can construct.
 */
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { access, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { noticesSummary, openLicence, openNotices } from './licence'
import { openInBrowser } from './windowGuard'

import { attachGrants } from './attachGrants'
import { lastDialogDir, rememberDialogPick } from './dialogDirs'

export interface CoreDeps {
  apiRequest: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>
  /** Startup status is owned by the boot flow; read it live, never copy it. */
  getStatus: () => unknown
}

export function registerCore(deps: CoreDeps): void {
  ipcMain.handle('prism:status', () => deps.getStatus())
  ipcMain.handle('prism:info', async () => {
    const r = await deps.apiRequest('GET', '/api/v1/system/info')
    return r.body
  })
  ipcMain.handle('prism:api', async (_e, req: { method: string; path: string; body?: unknown }) =>
    deps.apiRequest(req.method, req.path, req.body)
  )
  // The regional format, not the display language: a spreadsheet parses a pasted "0,5" or "0.5" by the
  // former, and an English Windows with German formats is common. Local only; nothing leaves the computer.
  ipcMain.handle('prism:systemLocale', () => app.getSystemLocale())
  // Only real web links, in the OS browser — the one rule, shared with the window guard.
  ipcMain.handle('prism:openExternal', (_e, url: string) => openInBrowser(url))
  // The bundled licence text (AGPL-3.0), opened as a local file — see licence.ts.
  ipcMain.handle('prism:openLicence', () => openLicence())
  // The bundled third-party notices, opened the same way.
  ipcMain.handle('prism:openNotices', () => openNotices())
  // Their summary tables, for the in-app sheet (the file itself is 2 MB).
  ipcMain.handle('prism:noticesSummary', () => noticesSummary())
  // A file the user attached to a chat. The renderer knows only the attachment's id — the project
  // directory belongs to the backend — so the path is fetched here and handed straight to the OS.
  ipcMain.handle('prism:openSource', async (_e, id: string, reveal?: boolean) => {
    const r = await deps.apiRequest('GET', `/api/v1/files/attachments/${encodeURIComponent(String(id))}/path`)
    const path = (r.body as { path?: string } | null)?.path
    if (r.status !== 200 || !path) {
      const detail = (r.body as { detail?: string } | null)?.detail
      return { error: detail || `Could not locate the attachment (HTTP ${r.status}).` }
    }
    if (reveal) {
      shell.showItemInFolder(path)
      return { path }
    }
    // openPath resolves to '' on success and to the OS's reason otherwise — a machine with no
    // handler for the file type says so here rather than failing silently.
    const failure = await shell.openPath(path)
    return failure ? { error: failure, path } : { path }
  })
  ipcMain.handle('prism:pickDirectory', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const opts = { properties: ['openDirectory' as const], defaultPath: lastDialogDir() }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    rememberDialogPick(res.filePaths[0], 'directory')
    return res.filePaths[0]
  })
  // Several rendered files into ONE folder the user picks once. "Save charts" on the Results page
  // used to hand every PNG to the browser's downloads, and twelve charts meant twelve save dialogs
  // stacked on top of each other. A download cannot be pointed at a folder, so
  // the bytes come here and are written directly. Returns null when the user cancels.
  ipcMain.handle('prism:saveFilesTo', async (_e, files: unknown) => {
    const list = Array.isArray(files) ? files : []
    const win = BrowserWindow.getAllWindows()[0]
    // Test harness only (same switch as the download hook in index.ts): no native dialog, the
    // files land in that directory.
    let dir = process.env['PRISM_DOWNLOAD_DIR'] || null
    if (!dir) {
      const opts = {
        title: 'Save charts to folder',
        buttonLabel: 'Save here',
        properties: ['openDirectory' as const, 'createDirectory' as const],
        defaultPath: lastDialogDir()
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (res.canceled || res.filePaths.length === 0) return null
      dir = res.filePaths[0]
      rememberDialogPick(dir, 'directory')
    }
    const written: string[] = []
    const errors: string[] = []
    for (const f of list) {
      const name = basename(String((f as { name?: unknown })?.name ?? ''))
      const url = String((f as { dataUrl?: unknown })?.dataUrl ?? '')
      const m = /^data:[\w.+-]+\/[\w.+-]+;base64,(.*)$/s.exec(url)
      if (!name || !m) {
        errors.push(`${name || '(unnamed)'}: not a renderable image`)
        continue
      }
      try {
        // A folder is chosen, not a file, so nothing asks before overwriting — number the clash
        // instead, as the OS dialog would have made the user do.
        const path = await freePath(dir, name)
        await writeFile(path, Buffer.from(m[1], 'base64'))
        written.push(path)
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return { dir, written, errors }
  })
  ipcMain.handle('prism:pickFile', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const win = BrowserWindow.getAllWindows()[0]
    const opts = {
      properties: ['openFile' as const],
      defaultPath: lastDialogDir(),
      ...(filters ? { filters } : {})
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (!res.canceled) rememberDialogPick(res.filePaths[0], 'file')
    // No attachment grant here: the chat attaches through `pickFiles` only, and the callers of this
    // one (Setup, BackgroundData) must not wait on a `realpath` they do not need.
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })
  // Its own channel rather than a flag on the one above: every existing caller of `pickFile` wants
  // exactly one path and reads the result as `string | null`, and widening that return type would
  // change what five call sites mean in order to serve one new one.
  ipcMain.handle('prism:pickFiles', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const win = BrowserWindow.getAllWindows()[0]
    const opts = {
      properties: ['openFile' as const, 'multiSelections' as const],
      defaultPath: lastDialogDir(),
      ...(filters ? { filters } : {})
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled) return []
    rememberDialogPick(res.filePaths[0], 'file')
    // What the OS dialog returned is the user's choice, not the renderer's — the one kind of path
    // `ai:attach` trusts without question (attachGrants.ts). Granted before the paths go back, so
    // the attach that follows finds them.
    await attachGrants.grant(res.filePaths)
    return res.filePaths
  })
  // The drop half of the attachment binding. Only the preload calls this, with paths it resolved
  // itself from dropped `File` objects (webUtils.getPathForFile); the page cannot reach ipcRenderer.
  // That keeps a script in the page from granting arbitrary paths — it does not keep out code that
  // runs in the preload or a compromised renderer process (attachGrants.ts, docs/ARCHITEKTUR.md).
  ipcMain.handle('prism:grantDropped', async (_e, paths: unknown) => {
    if (Array.isArray(paths)) await attachGrants.grant(paths)
  })
}

/** `dir/name`, or `dir/name (2)`, `(3)`… when that file already exists. */
async function freePath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; ; i++) {
    const candidate = join(dir, i === 1 ? name : `${stem} (${i})${ext}`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
}
