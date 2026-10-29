import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useProjectModels } from './useProjectModels'
import { makePrism, type PrismFixture } from '../test/prism'
import { initAppSettings, setAS } from '../lib/appSettings'
import { resetQueryCache } from '../lib/server/useQuery'

/**
 * "Last models" is stamped by a USER's open only. The start-up restore of `prism.activeModel` and the
 * fallback after a refresh move `activeDb` too — and must leave the list alone, or the start page
 * would claim somebody opened a model they never touched.
 */
describe('recent-model tracking in the project hook', () => {
  let fixture: PrismFixture
  beforeEach(async () => {
    resetQueryCache()
    fixture = makePrism({
      'GET /api/v1/system/info': { current_project: { name: 'demo' } },
      'GET /api/v1/projects': [{ name: 'demo' }],
      'GET /api/v1/databases': [
        { name: 'a', node_count: 1, read_only: false, kind: 'foreground' },
        { name: 'b', node_count: 1, read_only: false, kind: 'foreground' }
      ],
      'GET /api/v1/model/audit': []
    })
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
    await initAppSettings()
    setAS({ recentModels: [] })
    localStorage.setItem('prism.activeModel', JSON.stringify('b'))
  })

  const hook = () =>
    renderHook(() =>
      useProjectModels({
        run: async (fn) => fn(),
        reloadAudit: async () => {},
        setConfirm: () => {},
        onProjectSwitched: () => {},
        renameCanvasRefs: () => false,
        openModelView: () => {}
      })
    )

  it('does not stamp the model restored at start-up, and stamps the one the user opens', async () => {
    const { result } = hook()
    await act(async () => {
      await result.current.loadProjectsAndDatabases()
    })
    expect(result.current.activeDb).toBe('b')
    expect(fixture.settings.recentModels).toEqual([])

    act(() => result.current.openModel('a'))
    expect(result.current.activeDb).toBe('a')
    await waitFor(() =>
      expect(fixture.settings.recentModels).toEqual([expect.objectContaining({ project: 'demo', db: 'a' })])
    )
  })

  it('moves the entry when the model is renamed', async () => {
    const { result } = hook()
    await act(async () => {
      await result.current.loadProjectsAndDatabases()
    })
    act(() => result.current.openModel('a'))
    act(() => result.current.renamedModel('a', 'a2'))
    await waitFor(() =>
      expect(fixture.settings.recentModels).toEqual([expect.objectContaining({ project: 'demo', db: 'a2' })])
    )
    localStorage.removeItem('prism.activeModel')
  })
})

/**
 * Two refreshes overlap and the older one answers last: it must not put the window back on a model
 * list from before. Seen with an agent: its open_model refreshed, showed the new
 * model, and a refresh started before the model existed then switched the window back to the old one.
 */
describe('overlapping database refreshes', () => {
  it('lets only the newest refresh set the list and the active model', async () => {
    resetQueryCache()
    const OLD = [{ name: 'old', node_count: 1, read_only: false, kind: 'foreground' }]
    const NEW = [...OLD, { name: 'new', node_count: 0, read_only: false, kind: 'foreground' }]
    let releaseFirst: (v: unknown) => void = () => {}
    let call = 0
    const fixture = makePrism({
      'GET /api/v1/system/info': { current_project: { name: 'demo' } },
      'GET /api/v1/projects': [{ name: 'demo' }],
      'GET /api/v1/model/audit': [],
      'GET /api/v1/databases': () =>
        ++call === 1 ? new Promise((resolve) => (releaseFirst = () => resolve(OLD))) : NEW
    })
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
    await initAppSettings()
    const { result } = renderHook(() =>
      useProjectModels({
        run: async (fn) => fn(),
        reloadAudit: async () => {},
        setConfirm: () => {},
        onProjectSwitched: () => {},
        renameCanvasRefs: () => false,
        openModelView: () => {}
      })
    )
    let first: Promise<unknown> = Promise.resolve()
    await act(async () => {
      first = result.current.refreshDatabases() // started before the model existed, answers last
      await result.current.refreshDatabases() // the agent's open: sees the new model
    })
    act(() => result.current.openModel('new'))
    await act(async () => {
      releaseFirst(undefined)
      await first
    })
    expect(result.current.databases.map((d) => d.name)).toEqual(['old', 'new'])
    expect(result.current.activeDb).toBe('new')
  })
})

describe('a refresh still running when the workspace changes', () => {
  it('does not land in the workspace switched to', async () => {
    resetQueryCache()
    const A = [{ name: 'model-a', node_count: 1, read_only: false, kind: 'foreground' }]
    const B = [{ name: 'model-b', node_count: 1, read_only: false, kind: 'foreground' }]
    let releaseA: () => void = () => {}
    let active = 'A'
    const fixture = makePrism({
      'GET /api/v1/system/info': { current_project: { name: 'A' } },
      'GET /api/v1/projects': [{ name: 'A' }, { name: 'B' }],
      'GET /api/v1/model/audit': [],
      'POST /api/v1/projects/B/activate': () => {
        active = 'B'
        return { name: 'B' }
      },
      'GET /api/v1/databases': () =>
        active === 'A' ? new Promise((resolve) => (releaseA = () => resolve(A))) : B
    })
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
    await initAppSettings()
    const { result } = renderHook(() =>
      useProjectModels({
        run: async (fn) => fn(),
        reloadAudit: async () => {},
        setConfirm: () => {},
        onProjectSwitched: () => {},
        renameCanvasRefs: () => false,
        openModelView: () => {}
      })
    )
    let inA: Promise<unknown> = Promise.resolve()
    act(() => {
      inA = result.current.refreshDatabases() // a mutation in A, still waiting for its answer
    })
    await act(async () => {
      result.current.activateProject('B')
    })
    await waitFor(() => expect(result.current.activeDb).toBe('model-b'))
    await act(async () => {
      releaseA()
      await inA
    })
    expect(result.current.project).toBe('B')
    expect(result.current.databases.map((d) => d.name)).toEqual(['model-b'])
    expect(result.current.activeDb).toBe('model-b')
  })
})

describe('the view fence around a workspace switch', () => {
  it('saves the outgoing canvas into its own workspace first, and comes down even when a later step fails', async () => {
    resetQueryCache()
    const { viewSet, viewSync } = await import('../lib/modelView')
    const { useEffect } = await import('react')
    const fixture = makePrism({
      'GET /api/v1/system/info': { current_project: { name: 'A' } },
      'GET /api/v1/projects': [{ name: 'A' }, { name: 'B' }],
      'GET /api/v1/model/audit': [],
      'POST /api/v1/projects/B/activate': { name: 'B' },
      'GET /api/v1/databases': [{ name: 'm', node_count: 1, read_only: false, kind: 'foreground' }]
    })
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
    await initAppSettings()
    localStorage.setItem('prism.activeModel', JSON.stringify('m'))
    const { result } = renderHook(() => {
      const hook = useProjectModels({
        run: async (fn) => {
          try {
            await fn()
          } catch {
            /* the Workbench shows it; here it is the point of the test */
          }
        },
        reloadAudit: async () => {
          throw new Error('audit down')
        },
        setConfirm: () => {},
        onProjectSwitched: () => {},
        renameCanvasRefs: () => false,
        openModelView: () => {}
      })
      // The canvas in miniature: it writes its arrangement when its model goes away.
      const db = hook.activeDb
      useEffect(
        () => () => {
          if (db) viewSet(db, 'layout', { pos: { p: { x: 1, y: 2 } } })
        },
        [db]
      )
      return hook
    })
    await act(async () => {
      await result.current.loadProjectsAndDatabases()
    })
    expect(result.current.activeDb).toBe('m')
    await act(async () => {
      result.current.activateProject('B')
    })
    await waitFor(() => expect(result.current.project).toBe('B'))
    const order = fixture.calls.map((c) => `${c.method} ${c.path}`)
    const put = order.indexOf('PUT /api/v1/views/m')
    const activate = order.indexOf('POST /api/v1/projects/B/activate')
    expect(put).toBeGreaterThanOrEqual(0) // the departure save went out…
    expect(put).toBeLessThan(activate) // …while the backend still stood in A
    viewSet('after-switch', 'results', { ok: true })
    expect(viewSync('after-switch').results).toEqual({ ok: true }) // writes are not stuck behind it
  })
})

/** Created from the start page, the model used to be selected but the start page stayed on screen:
 *  the dialog's submit now ends on the new model's canvas, wherever it was opened. */
describe('the New-model dialog', () => {
  it('opens the created model on its canvas', async () => {
    resetQueryCache()
    const fixture = makePrism({
      'GET /api/v1/system/info': { current_project: { name: 'demo' } },
      'GET /api/v1/projects': [{ name: 'demo' }],
      'GET /api/v1/model/audit': [],
      'POST /api/v1/databases/foreground': { ok: true },
      'GET /api/v1/databases': [{ name: 'fresh', node_count: 0, read_only: false, kind: 'foreground' }]
    })
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
    await initAppSettings()
    let views = 0
    const { result } = renderHook(() =>
      useProjectModels({
        run: async (fn) => fn(),
        reloadAudit: async () => {},
        setConfirm: () => {},
        onProjectSwitched: () => {},
        renameCanvasRefs: () => false,
        openModelView: () => views++
      })
    )
    await act(async () => {
      await result.current.submitNewModel({ name: 'fresh' })
    })
    expect(result.current.activeDb).toBe('fresh')
    expect(views).toBe(1)
  })
})
