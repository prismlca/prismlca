import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useProjectModels } from './useProjectModels'
import { makePrism, type PrismFixture } from '../test/prism'
import { initAppSettings, setAS } from '../lib/appSettings'
import { resetQueryCache } from '../lib/server/useQuery'
import { getFolders, reloadFolders } from '../lib/modelFolders'

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

describe('the model folders across a workspace switch', () => {
  it('reads the folders of the workspace switched to instead of keeping the old ones', async () => {
    resetQueryCache()
    let active = 'A'
    const fixture = makePrism({
      'GET /api/v1/system/info': { current_project: { name: 'A' } },
      'GET /api/v1/projects': [{ name: 'A' }, { name: 'B' }],
      'GET /api/v1/model/audit': [],
      'GET /api/v1/databases': [],
      'POST /api/v1/projects/B/activate': () => {
        active = 'B'
        return { name: 'B' }
      },
      'GET /api/v1/databases/folders': () =>
        active === 'A'
          ? { folders: [{ id: 'a1', name: 'Packaging' }], of: { 'PET bottle': 'a1' } }
          : { folders: [{ id: 'b1', name: 'Buildings' }], of: {} }
    })
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
    await initAppSettings()
    await reloadFolders()
    expect(getFolders().folders.map((f) => f.name)).toEqual(['Packaging'])
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
    await act(async () => {
      result.current.activateProject('B')
    })
    await waitFor(() => expect(getFolders().folders.map((f) => f.name)).toEqual(['Buildings']))
    expect(getFolders()).toMatchObject({ of: {}, status: 'ready' })
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

/** Deleting the workspace you stand in opens another: the one the backend names, which picks one with data.
 *  It is a workspace switch, so the open model saves itself before the DELETE — into the workspace about to
 *  go, never into the one opened, where a model of the same name would take its arrangement. */
describe('deleting the active workspace', () => {
  async function standingInA(deleteReply: unknown, afterRefusal = 'A') {
    resetQueryCache()
    const { viewSet } = await import('../lib/modelView')
    const { useEffect } = await import('react')
    let active = 'A'
    const fixture = makePrism({
      'GET /api/v1/system/info': () => ({ current_project: { name: active } }),
      'GET /api/v1/projects': () =>
        active === 'Main' ? [{ name: 'Main' }] : [{ name: 'A' }, { name: 'Main' }],
      'GET /api/v1/model/audit': [],
      'DELETE /api/v1/projects/A': () => {
        if (typeof deleteReply === 'object' && deleteReply && 'status' in deleteReply) {
          active = afterRefusal
          return deleteReply
        }
        active = 'Main'
        return deleteReply
      },
      'GET /api/v1/databases': () =>
        active === 'A'
          ? [{ name: 'm', node_count: 1, read_only: false, kind: 'foreground' }]
          : active === 'Main'
            ? [{ name: 'study', node_count: 3, read_only: false, kind: 'foreground' }]
            : []
    })
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
    await initAppSettings()
    localStorage.setItem('prism.activeModel', JSON.stringify('m'))
    let confirm: { onConfirm: () => void } | null = null
    const { result } = renderHook(() => {
      const hook = useProjectModels({
        run: async (fn) => {
          try {
            await fn()
          } catch {
            /* the Workbench shows it */
          }
        },
        reloadAudit: async () => {},
        setConfirm: (spec) => {
          confirm = spec
        },
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
    act(() => result.current.deleteProject('A'))
    await act(async () => {
      confirm!.onConfirm()
    })
    return { result, fixture }
  }

  it('saves the open model first and lands in the workspace the backend opened', async () => {
    const { result, fixture } = await standingInA({ deleted: 'A', current: 'Main' })
    await waitFor(() => expect(result.current.project).toBe('Main'))
    await waitFor(() => expect(result.current.activeDb).toBe('study'))
    expect(result.current.projects).toEqual(['Main'])
    const order = fixture.calls.map((c) => `${c.method} ${c.path}`)
    const put = order.indexOf('PUT /api/v1/views/m')
    expect(put).toBeGreaterThanOrEqual(0)
    expect(put).toBeLessThan(order.indexOf('DELETE /api/v1/projects/A'))
    expect(order).not.toContain('POST /api/v1/projects/default/activate')
  })

  const refused = { status: 409, body: { error: { code: 'workspace_in_use', message: 'in use' } } }

  it('opens the model again when the deletion is refused', async () => {
    const { result } = await standingInA(refused)
    await waitFor(() => expect(result.current.activeDb).toBe('m'))
    expect(result.current.project).toBe('A')
  })

  it("follows the backend when a refused deletion left it in 'default'", async () => {
    // The row could not be deleted and the folder not put back: the workspace stays listed, the
    // backend stays out of it. Reopening its model here would show it over another workspace's data.
    const { result } = await standingInA(refused, 'default')
    await waitFor(() => expect(result.current.project).toBe('default'))
    expect(result.current.activeDb).toBeNull()
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

/** A dialog closes only once its model or workspace exists: `created` marks that moment, and a refused
 *  name throws before it, for the dialog to show with what was typed. */
describe('dialog submits report when the thing exists', () => {
  const rig = (routes: Record<string, unknown>) => {
    resetQueryCache()
    const fixture = makePrism({
      'GET /api/v1/system/info': { current_project: { name: 'demo' } },
      'GET /api/v1/projects': [{ name: 'demo' }],
      'GET /api/v1/model/audit': [],
      'GET /api/v1/databases': [{ name: 'bottle', node_count: 0, read_only: false, kind: 'foreground' }],
      ...routes
    })
    ;(window as unknown as { prism: unknown }).prism = fixture.prism
    return renderHook(() =>
      useProjectModels({
        run: async (fn) => fn(),
        reloadAudit: async () => {},
        setConfirm: () => {},
        onProjectSwitched: () => {},
        renameCanvasRefs: () => false,
        openModelView: () => {}
      })
    )
  }
  const exists = (code: string, message: string) => ({ status: 409, body: { error: { code, message } } })

  it('a taken model name throws before `created`, and nothing is written after it', async () => {
    const { result } = rig({
      'POST /api/v1/databases/foreground': exists('database_exists', "Database 'bottle' already exists.")
    })
    await initAppSettings()
    const created = vi.fn()
    await act(async () => {
      await expect(
        result.current.submitNewModel({ name: 'bottle', goal: 'Compare two bottles' }, created)
      ).rejects.toThrow("Database 'bottle' already exists.")
    })
    expect(created).not.toHaveBeenCalled()
  })

  it('a new model calls `created` once it exists, before its goal is stored', async () => {
    const order: string[] = []
    const { result } = rig({
      'POST /api/v1/databases/foreground': () => (order.push('create'), { ok: true }),
      'POST /api/v1/study': () => (order.push('study'), { ok: true })
    })
    await initAppSettings()
    await act(async () => {
      await result.current.submitNewModel({ name: 'fresh', goal: 'g' }, () => order.push('created'))
    })
    expect(order).toEqual(['create', 'created', 'study'])
  })

  it('a duplicate under a taken name throws before `created`', async () => {
    const { result } = rig({
      'POST /api/v1/databases/foreground/duplicate': exists(
        'database_exists',
        "Database 'bottle' already exists."
      )
    })
    await initAppSettings()
    const created = vi.fn()
    await act(async () => {
      await expect(
        result.current.submitDuplicateModel('bottle', { name: 'bottle' }, created)
      ).rejects.toThrow('already exists')
    })
    expect(created).not.toHaveBeenCalled()
  })

  it('a taken workspace name throws before `created` and gives the open model back', async () => {
    const { result } = rig({
      'POST /api/v1/projects': exists('project_exists', "Workspace 'demo' already exists.")
    })
    await initAppSettings()
    await act(async () => {
      await result.current.loadProjectsAndDatabases()
    })
    act(() => result.current.openModel('bottle'))
    const created = vi.fn()
    await act(async () => {
      await expect(result.current.submitNewProject({ name: 'demo' }, created)).rejects.toThrow(
        'already exists'
      )
    })
    expect(created).not.toHaveBeenCalled()
    expect(result.current.project).toBe('demo')
    expect(result.current.activeDb).toBe('bottle')
  })

  it('a restore under a typed name that is taken hands back that name and the reason', async () => {
    const { result } = rig({
      'POST /api/v1/projects/restore': exists('workspace_exists', "A workspace named 'demo' already exists.")
    })
    await initAppSettings()
    const taken = vi.fn()
    await act(async () => {
      await result.current.restoreBackup(taken, '/backups/demo.tar.gz', 'demo')
    })
    await waitFor(() => expect(taken).toHaveBeenCalled())
    expect(taken).toHaveBeenCalledWith('/backups/demo.tar.gz', {
      name: 'demo',
      error: expect.stringContaining("A workspace named 'demo' already exists.")
    })
  })
})
