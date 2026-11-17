import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPrism } from '../test/render'
import type { RouteReply } from '../test/prism'

const ROUTE = 'GET /api/v1/databases/folders'
const PACKAGING = { folders: [{ id: 'f1', name: 'Packaging' }], of: { 'PET bottle': 'f1' } }
const DOWN = { status: 503, body: { detail: 'busy' } }

/** A fresh copy of the store per test: its snapshot is module state, and "never read yet" is the
 *  state under test. */
async function freshStore(replies: RouteReply[]): Promise<typeof import('./modelFolders')> {
  vi.resetModules()
  const queue = [...replies]
  installPrism({ [ROUTE]: () => queue.shift() ?? DOWN })
  return import('./modelFolders')
}

describe('model folder store', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('says "loading" until the first read is back — empty lists are not "no folders" yet', async () => {
    const store = await freshStore([PACKAGING])
    expect(store.getFolders().status).toBe('loading')
    await store.reloadFolders()
    expect(store.getFolders()).toEqual({ ...PACKAGING, status: 'ready' })
  })

  it('tries a failed read once more after a pause', async () => {
    const store = await freshStore([DOWN, PACKAGING])
    const read = store.reloadFolders()
    await vi.advanceTimersByTimeAsync(store.FOLDER_RETRY_MS)
    await read
    expect(store.getFolders()).toEqual({ ...PACKAGING, status: 'ready' })
  })

  it('keeps the last good state when a later read fails twice', async () => {
    const store = await freshStore([PACKAGING, DOWN, DOWN])
    await store.reloadFolders()
    const seen = vi.fn()
    store.subscribeFolders(seen)
    const read = store.reloadFolders()
    await vi.advanceTimersByTimeAsync(store.FOLDER_RETRY_MS)
    await read
    expect(store.getFolders()).toEqual({ ...PACKAGING, status: 'ready' })
    expect(seen).not.toHaveBeenCalled() // nothing moved, so nobody redraws
  })

  it('gives up as "failed" when the folders were never read, and loads on the next attempt', async () => {
    const store = await freshStore([DOWN, DOWN, PACKAGING])
    const read = store.reloadFolders()
    await vi.advanceTimersByTimeAsync(store.FOLDER_RETRY_MS)
    await read
    expect(store.getFolders()).toEqual({ folders: [], of: {}, status: 'failed' })

    const again = store.reloadFolders()
    expect(store.getFolders().status).toBe('loading') // asked again: on its way, not failed
    await again
    expect(store.getFolders()).toEqual({ ...PACKAGING, status: 'ready' })
  })
})

describe('model folder store across a workspace switch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const BOTTLES = { folders: [{ id: 'g1', name: 'Bottles' }], of: { 'Glass jar': 'g1' } }

  /** Two workspaces behind one route; `A` answers only when released, to stand for a slow read. */
  async function twoWorkspaces(b: () => RouteReply): Promise<{
    store: typeof import('./modelFolders')
    switchTo: () => void
    releaseA: () => void
  }> {
    vi.resetModules()
    let active = 'A'
    let slowA = false
    let release: () => void = () => {}
    installPrism({
      [ROUTE]: () => {
        if (active === 'B') return b()
        if (!slowA) return PACKAGING
        return new Promise<RouteReply>((done) => (release = () => done(PACKAGING)))
      }
    })
    const store = await import('./modelFolders')
    await store.reloadFolders() // A, read and shown
    slowA = true
    return { store, switchTo: () => (active = 'B'), releaseA: () => release() }
  }

  it('forgets the folders of the workspace left, and drops a read still out for it', async () => {
    const { store, switchTo, releaseA } = await twoWorkspaces(() => BOTTLES)
    const stillInA = store.reloadFolders()
    switchTo()
    const inB = store.resetFolders()
    expect(store.getFolders()).toEqual({ folders: [], of: {}, status: 'loading' })
    await inB
    releaseA()
    await stillInA
    expect(store.getFolders()).toEqual({ ...BOTTLES, status: 'ready' })
  })

  it('does not keep the old workspace’s folders when the new one’s cannot be read', async () => {
    const { store, switchTo } = await twoWorkspaces(() => DOWN)
    switchTo()
    const inB = store.resetFolders()
    await vi.advanceTimersByTimeAsync(store.FOLDER_RETRY_MS)
    await inB
    expect(store.getFolders()).toEqual({ folders: [], of: {}, status: 'failed' })
  })
})
