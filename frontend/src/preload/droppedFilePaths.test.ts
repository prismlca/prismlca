/**
 * The drop half of the attachment binding, in the preload.
 * `droppedFilePaths` is the only way a page gets a path granted, so it must trust nothing of the
 * object the page hands over except real `File`s, and only through `webUtils.getPathForFile`. A page
 * that passes an object with its own `map`, or fake elements, must get nothing granted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const realFiles = new Map<File, string>()
const invoke = vi.fn(async () => undefined)
let exposed: Record<string, unknown> = {}

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, unknown>) => {
      exposed = api
    }
  },
  ipcRenderer: { invoke, on: () => undefined, removeListener: () => undefined, send: () => undefined },
  webUtils: {
    // Like Electron's: a path only for a File backed by a file on disk, a throw for anything else.
    getPathForFile: (f: unknown) => {
      if (f instanceof File) return realFiles.get(f) ?? ''
      throw new TypeError('Expected a File')
    }
  }
}))

await import('./index')
const droppedFilePaths = exposed.droppedFilePaths as (
  files: unknown
) => Promise<{ paths: string[]; overflow: number }>

beforeEach(() => {
  invoke.mockClear()
  realFiles.clear()
})

describe('droppedFilePaths', () => {
  it('grants what real dropped files resolve to', async () => {
    const f = new File(['x'], 'a.pdf')
    realFiles.set(f, '/home/u/a.pdf')
    expect(await droppedFilePaths([f, new File(['y'], 'made-up.pdf')])).toEqual({
      paths: ['/home/u/a.pdf'],
      overflow: 0
    })
    expect(invoke).toHaveBeenCalledWith('prism:grantDropped', ['/home/u/a.pdf'])
  })

  it("never calls the page object's own methods", async () => {
    const forged = {
      length: 1,
      0: '/home/u/.ssh/id_ed25519',
      map: () => ({ filter: () => ['/home/u/.ssh/id_ed25519'] }),
      filter: () => ['/home/u/.ssh/id_ed25519'],
      [Symbol.iterator]: function* () {
        yield '/home/u/.ssh/id_ed25519'
      }
    }
    expect((await droppedFilePaths(forged)).paths).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('grants nothing for fake elements or a lying length', async () => {
    const fakeFile = { name: 'id_ed25519', path: '/home/u/.ssh/id_ed25519' }
    expect((await droppedFilePaths([fakeFile, 'plain string', null])).paths).toEqual([])
    expect((await droppedFilePaths({ length: 1e9 })).paths).toEqual([])
    expect(await droppedFilePaths(null)).toEqual({ paths: [], overflow: 0 })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('does not coerce the length: a throwing valueOf or getter is no length, not a failure', async () => {
    const hostile = {
      length: {
        valueOf() {
          throw new Error('page code ran in the preload')
        }
      }
    }
    expect(await droppedFilePaths(hostile)).toEqual({ paths: [], overflow: 0 })
    const throwingGetter = Object.defineProperty({}, 'length', {
      get() {
        throw new Error('page code ran in the preload')
      }
    })
    expect(await droppedFilePaths(throwingGetter)).toEqual({ paths: [], overflow: 0 })
    expect(await droppedFilePaths({ length: '3' })).toEqual({ paths: [], overflow: 0 })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports the files past the cap instead of losing them', async () => {
    const files = Array.from({ length: 51 }, (_, i) => {
      const f = new File(['x'], `f${i}.txt`)
      realFiles.set(f, `/home/u/f${i}.txt`)
      return f
    })
    const r = await droppedFilePaths(files)
    expect(r.paths).toHaveLength(50)
    expect(r.paths[49]).toBe('/home/u/f49.txt')
    expect(r.overflow).toBe(1)
    // The 51st was never resolved, so never granted.
    expect(invoke).toHaveBeenCalledWith('prism:grantDropped', r.paths)
  })
})
