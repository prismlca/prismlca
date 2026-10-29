import { afterEach, describe, expect, it, vi } from 'vitest'
import { withOpened, withRenamed } from './recentModels'
import { RECENT_MODELS_CAP, type RecentModel } from '../../../shared/startPage'

const at = (d: number): Date => new Date(Date.UTC(2026, 8, d, 12))

describe('recent models', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('puts the model just opened first, once', () => {
    let list: RecentModel[] = []
    list = withOpened(list, 'p', 'a', at(1))
    list = withOpened(list, 'p', 'b', at(2))
    list = withOpened(list, 'p', 'a', at(3))
    expect(list.map((r) => r.db)).toEqual(['a', 'b'])
    expect(list[0].openedAt).toBe(at(3).toISOString())
  })

  it('keeps the same name in two projects apart', () => {
    let list = withOpened([], 'p', 'a', at(1))
    list = withOpened(list, 'q', 'a', at(2))
    expect(list).toHaveLength(2)
  })

  it('keeps at most the cap', () => {
    let list: RecentModel[] = []
    for (let i = 0; i < RECENT_MODELS_CAP + 5; i++) list = withOpened(list, 'p', `m${i}`, at(i + 1))
    expect(list).toHaveLength(RECENT_MODELS_CAP)
    expect(list[0].db).toBe(`m${RECENT_MODELS_CAP + 4}`)
  })

  it('moves an entry with a rename, in its own project only', () => {
    let list = withOpened([], 'p', 'old', at(1))
    list = withOpened(list, 'q', 'old', at(2))
    list = withRenamed(list, 'p', 'old', 'new')
    expect(list).toEqual([
      { project: 'q', db: 'old', openedAt: at(2).toISOString() },
      { project: 'p', db: 'new', openedAt: at(1).toISOString() }
    ])
  })

  it('writes the whole list through the settings store, filtered per project on read', async () => {
    const sets: Record<string, unknown>[] = []
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null },
      prism: {
        appSettings: {
          set: async (patch: Record<string, unknown>) => {
            sets.push(patch)
            return null
          }
        }
      }
    })
    const mod = await import('./recentModels')
    mod.rememberRecentModel('p', 'a')
    mod.rememberRecentModel('q', 'b')
    mod.renameRecentModel('p', 'a', 'a2')
    mod.renameRecentModel('p', 'missing', 'x') // nothing to move: no write
    expect(sets).toHaveLength(3)
    expect((sets[2].recentModels as RecentModel[]).map((r) => r.db)).toEqual(['b', 'a2'])
    expect(mod.recentModelsFor('p').map((r) => r.db)).toEqual(['a2'])
  })
})
