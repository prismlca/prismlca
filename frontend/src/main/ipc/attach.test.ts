/**
 * `ai:attach` reads only what the user handed over: a path from PrismLCA's own file
 * dialog or one the preload granted for a drop, once per pick or drop. Registered against a fake
 * ipcMain and called by channel, the way the preload calls it — the grant lives in main, so the
 * test has to go through the dialog handler, not around it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'prism-attach-ipc-'))
const picked = join(dir, 'datasheet.txt')
const dropped = join(dir, 'dropped.csv')
const secret = join(dir, 'credentials.json')
writeFileSync(picked, 'density 1.2 kg/l')
writeFileSync(dropped, 'a,b\n1,2')
writeFileSync(secret, '{"token":"s3cret"}')

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
let dialogAnswer: { canceled: boolean; filePaths: string[] } = { canceled: true, filePaths: [] }

vi.mock('electron', () => ({
  app: { getPath: () => dir, getAppPath: () => dir, isPackaged: false },
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn), on: () => undefined },
  shell: { openExternal: () => undefined, openPath: async () => '', showItemInFolder: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: async () => dialogAnswer }
}))
// The real file system, watched: which path is resolved, stat'ed and read is the point of three tests.
const fsSpy = vi.hoisted(() => ({ realpath: [] as string[], stat: [] as string[], readFile: [] as string[] }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  const watch =
    <K extends 'realpath' | 'stat' | 'readFile'>(k: K) =>
    (p: unknown, ...rest: unknown[]) => {
      fsSpy[k].push(String(p))
      return (orig[k] as (...a: unknown[]) => unknown)(p, ...rest)
    }
  return {
    ...orig,
    default: orig,
    realpath: watch('realpath'),
    stat: watch('stat'),
    readFile: watch('readFile')
  }
})
// The agent loop and the provider stack are not what this test is about.
vi.mock('../ai/agent', () => ({ runAgent: async () => undefined }))
vi.mock('../ai/client', () => ({ transcribeAudio: async () => '' }))

const { registerCore } = await import('../coreIpc')
const { registerChatIpc } = await import('./chat')
const { UiBridge } = await import('./uiBridge')
const { attachGrants } = await import('../attachGrants')
const { NOT_HANDED_OVER } = await import('../ai/attachments')

const stored: string[] = []
const contents: string[] = []
const apiRequest = async (method: string, path: string, body?: unknown) => {
  if (method === 'POST' && path === '/api/v1/files/attachments') {
    const { name, data_b64 } = body as { name: string; data_b64: string }
    stored.push(name)
    contents.push(Buffer.from(data_b64, 'base64').toString('utf-8'))
    return { status: 200, body: { id: `id-${name}`, name, kind: 'text', bytes: 1 } }
  }
  return { status: 200, body: {} }
}

type Meta = { id: string; name: string; error?: string }
const attach = (paths: unknown) => handlers.get('ai:attach')!(null, paths) as Promise<Meta[]>

beforeEach(() => {
  handlers.clear()
  stored.length = 0
  contents.length = 0
  fsSpy.realpath.length = 0
  fsSpy.stat.length = 0
  fsSpy.readFile.length = 0
  attachGrants.clear()
  registerCore({ apiRequest, getStatus: () => ({}) })
  registerChatIpc(
    { apiRequest, getWindow: () => null },
    new Map(),
    new UiBridge({ getWindow: () => null, emit: () => {} })
  )
})

describe('ai:attach only reads files the user handed over', () => {
  it('accepts a path from the file dialog, once', async () => {
    dialogAnswer = { canceled: false, filePaths: [picked] }
    expect(await handlers.get('prism:pickFiles')!(null)).toEqual([picked])

    const first = await attach([picked])
    expect(first).toEqual([expect.objectContaining({ id: 'id-datasheet.txt', name: 'datasheet.txt' })])
    expect(first[0].error).toBeUndefined()

    // The pick is used up: the same path again, without a new pick, is refused and never read.
    const again = await attach([picked])
    expect(again).toEqual([
      expect.objectContaining({ id: '', name: 'datasheet.txt', error: NOT_HANDED_OVER })
    ])
    expect(stored).toEqual(['datasheet.txt'])
  })

  it('the single-file dialog grants nothing — Setup and BackgroundData use it, the chat does not', async () => {
    dialogAnswer = { canceled: false, filePaths: [picked] }
    expect(await handlers.get('prism:pickFile')!(null)).toBe(picked)
    expect(fsSpy.realpath).toEqual([])
    expect((await attach([picked]))[0].error).toBe(NOT_HANDED_OVER)
  })

  it('refuses a path that was never picked or dropped, without reading it', async () => {
    const r = await attach([secret])
    expect(r).toEqual([expect.objectContaining({ id: '', name: 'credentials.json', error: NOT_HANDED_OVER })])
    expect(stored).toEqual([])
    // Refused on the lookup alone: not even resolved (an ungranted UNC path must not hit the network).
    expect([...fsSpy.realpath, ...fsSpy.stat, ...fsSpy.readFile]).not.toContain(secret)
  })

  it('accepts a dropped file once per drop, and keeps order beside refused paths', async () => {
    await handlers.get('prism:grantDropped')!(null, [dropped])
    const r = await attach([secret, dropped])
    expect(r.map((m) => [m.name, m.error ?? 'ok'])).toEqual([
      ['credentials.json', NOT_HANDED_OVER],
      ['dropped.csv', 'ok']
    ])
    expect((await attach([dropped]))[0].error).toBe(NOT_HANDED_OVER)
  })

  it('a cancelled dialog grants nothing', async () => {
    dialogAnswer = { canceled: true, filePaths: [picked] }
    expect(await handlers.get('prism:pickFiles')!(null)).toEqual([])
    expect((await attach([picked]))[0].error).toBe(NOT_HANDED_OVER)
  })

  it('refuses when a granted symlink is bent to another file before the read', async () => {
    const link = join(dir, 'bent-link.txt')
    rmSync(link, { force: true })
    symlinkSync(picked, link)
    dialogAnswer = { canceled: false, filePaths: [link] }
    await handlers.get('prism:pickFiles')!(null)
    // Between the pick and the attach, the link is re-pointed at a file the user never chose.
    unlinkSync(link)
    symlinkSync(secret, link)
    expect((await attach([link]))[0].error).toBe(NOT_HANDED_OVER)
    expect(contents).toEqual([])
  })

  it('stats and reads the resolved path, not the one the renderer named', async () => {
    const link = join(dir, 'straight-link.txt')
    rmSync(link, { force: true })
    symlinkSync(picked, link)
    dialogAnswer = { canceled: false, filePaths: [link] }
    await handlers.get('prism:pickFiles')!(null)
    const r = await attach([link])
    expect(r[0]).toEqual(expect.objectContaining({ name: 'straight-link.txt' }))
    expect(r[0].error).toBeUndefined()
    const target = realpathSync(picked)
    expect(fsSpy.stat).toEqual([target])
    expect(fsSpy.readFile).toEqual([target])
    expect(contents).toEqual(['density 1.2 kg/l'])
  })

  it('another name for a granted file is not a grant', async () => {
    const link = join(dir, 'other-name.txt')
    rmSync(link, { force: true })
    symlinkSync(picked, link)
    dialogAnswer = { canceled: false, filePaths: [picked] }
    await handlers.get('prism:pickFiles')!(null)
    expect((await attach([link]))[0].error).toBe(NOT_HANDED_OVER)
    // The grant itself is untouched and still works under the picked name.
    expect((await attach([picked]))[0].error).toBeUndefined()
  })

  it('a file picked under two names — target and symlink — can be attached under both', async () => {
    // Granting the link used to overwrite the target's grant under their shared real path, so taking
    // one consumed both and the second explicitly picked name was refused (residual review of 7645cca3).
    const link = join(dir, 'also-picked.txt')
    rmSync(link, { force: true })
    symlinkSync(picked, link)
    dialogAnswer = { canceled: false, filePaths: [picked, link] }
    await handlers.get('prism:pickFiles')!(null)
    expect((await attach([picked]))[0].error).toBeUndefined()
    expect((await attach([link]))[0].error).toBeUndefined()
    expect((await attach([picked]))[0].error).toBe(NOT_HANDED_OVER)
    expect(stored).toEqual(['datasheet.txt', 'also-picked.txt'])
  })

  it('refuses a granted path that no longer exists', async () => {
    const gone = join(dir, 'gone.txt')
    writeFileSync(gone, 'x')
    await handlers.get('prism:grantDropped')!(null, [gone])
    unlinkSync(gone)
    expect((await attach([gone]))[0].error).toBe(NOT_HANDED_OVER)
  })

  it('matches the same file spelled differently', async () => {
    dialogAnswer = { canceled: false, filePaths: [picked] }
    await handlers.get('prism:pickFiles')!(null)
    expect((await attach([join(dir, 'sub', '..', 'datasheet.txt')]))[0].error).toBeUndefined()
  })
})
