/**
 * The project/model lifecycle of the Workbench: which Brightway project is active, which databases
 * it holds, which model is open — and every mutation of that (switch, create, duplicate, delete,
 * rename follow-up, backup). Extracted from Workbench.tsx (wave 4.1).
 *
 * The canvas is a *consumer* of this state, never an owner: on a project switch the hook clears it
 * through `onProjectSwitched`, and a model rename moves the canvas's own refs first through
 * `renameCanvasRefs` (they must move BEFORE `activeDb` does — the model-switch effect saves the
 * outgoing model's canvas, and the outgoing name would write the arrangement back under a model
 * that no longer exists).
 */
import { resetThemePreviews } from '../views/ThemePreview'
import { useCallback, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { api, ApiError, type DatabaseInfo } from '../lib/api'
import { fetchQuery, invalidate } from '../lib/server/useQuery'
import { beginWorkspaceSwitch, cancelWorkspaceSwitch, endWorkspaceSwitch } from '../lib/modelView'
import { usePersisted } from '../lib/persist'
import { defaultSearchDbs } from '../lib/search'
import { assignFolder, reloadFolders } from '../lib/modelFolders'
import { forgetView } from '../lib/modelView'
import { rememberRecentModel, renameRecentModel } from '../lib/recentModels'
import type { ConfirmSpec } from '../views/ConfirmDialog'

export interface ProjectModelDeps {
  run: (fn: () => Promise<void>) => Promise<void>
  reloadAudit: () => Promise<void>
  setConfirm: (spec: ConfirmSpec | null) => void
  /** Clear canvas + selection — a project switch changes every server answer at once. */
  onProjectSwitched: () => void
  /** Move the canvas's activeDb/prevDb refs from the old to the new name; answer whether the
   *  renamed model is the open one (then the hook moves `activeDb` too). */
  renameCanvasRefs: (from: string, to: string) => boolean
  /** Jump to the model view (used when an import hands over a fresh model). */
  openModelView: () => void
}

export function useProjectModels(deps: ProjectModelDeps) {
  const { run, reloadAudit, setConfirm, onProjectSwitched, renameCanvasRefs, openModelView } = deps
  const [project, setProject] = useState('')
  const [projects, setProjects] = useState<string[]>([])
  const [databases, setDatabaseList] = useState<DatabaseInfo[]>([])
  /**
   * Which model is open — remembered across restarts, like every other "where was I" in this view.
   *
   * It was plain state, so a reload landed on the first writable database in the list. That is not
   * merely the wrong model: every page hanging off it goes with it, and the Report page then showed
   * an empty report list for a model that has none — which reads as "the report I just wrote is
   * gone" (V241, seen repeatedly). Validated against the list below, so
   * a name that was renamed or deleted between sessions falls back instead of blanking the app.
   */
  const [storedDb, setActiveDb] = usePersisted<string | null>('prism.activeModel', null)
  // The stored name is a guess from the last session until the first database list confirms it. A model
  // deleted meanwhile, or a data folder replaced under the same profile, was otherwise asked for by every
  // model-scoped request at start-up (graph, view, audit, history), and the first-run card showed their
  // "Database … not found". Until the list is in, no model is active; refreshDatabases keeps or replaces it.
  const [listed, setListed] = useState(false)
  const [startupDone, setStartupDone] = useState(false)
  const activeDb = listed ? storedDb : null
  // Every path that brings a fresh list (start-up, a refresh, a workspace switch, a new model) goes
  // through here, so none of them can leave the stored name unconfirmed.
  const setDatabases = useCallback((dbs: DatabaseInfo[]) => {
    setDatabaseList(dbs)
    setListed(true)
  }, [])
  /**
   * The user opens a model — the one door every deliberate open goes through (the Overview list and
   * its "Last models" card, the toolbar dropdown, "Go to chat", a new, duplicated or imported model).
   * It is `setActiveDb` plus a stamp in the start page's "Last models". Everything else that moves
   * `activeDb` stays on the bare setter on purpose: restoring the persisted `prism.activeModel` at
   * start-up, the fallback after a delete or a project switch — none of those is somebody picking
   * a model up, and stamping them would put models on the card that nobody opened.
   */
  const openModel = useCallback(
    (name: string): void => {
      setActiveDb(name)
      rememberRecentModel(project, name)
    },
    [setActiveDb, project]
  )
  // A set, not one: the search panel lets the user tick ecoinvent and the library together.
  const [searchDbs, setSearchDbs] = useState<string[]>([])
  const [showSetup, setShowSetup] = useState(false)

  /** The one way this hook reads the database list: invalidate-then-fetch through the shared
   *  cache, so every subscribed view sees the same list a mutation just changed. */
  /** Which refreshDatabases call is the newest — see there. */
  const refreshSeq = useRef(0)
  /** A workspace switch or creation in progress — the next one waits its turn by being refused. */
  const switchBusy = useRef(false)
  /** Close the open model and let the canvas save its arrangement before anything else happens:
   *  flushSync commits at once, and React runs the effect cleanups of a synchronous commit right
   *  away — the canvas's departure save among them. */
  const leaveModel = useCallback(() => {
    flushSync(() => setActiveDb(null))
  }, [setActiveDb])
  const freshDatabases = useCallback(async (): Promise<DatabaseInfo[]> => {
    invalidate('/api/v1/databases')
    // A background that arrived or went brings or takes its geography names along.
    invalidate('/api/v1/search/geography-names')
    return await fetchQuery('/api/v1/databases')
  }, [])

  /** Re-read the database list and point every piece of state at it. Returns the list it read, so a
   *  caller that has to decide something from it (does this model exist yet?) does not race the
   *  state update. */
  const refreshDatabases = useCallback(async (): Promise<DatabaseInfo[]> => {
    // Only the newest refresh may set state. They overlap (every mutation fires one without
    // waiting, and an external agent's open_model fires its own), and the network does not keep
    // their order: an older list arriving after open_model had shown the new model put the window
    // back on the old one while the session stayed on the new. A
    // superseded call still returns what it read, for a caller deciding from it.
    const mine = ++refreshSeq.current
    const dbs = await freshDatabases()
    if (mine !== refreshSeq.current) return dbs
    setDatabases(dbs)
    // `!read_only` is not the same as "a model" any more — the library is writable too. And the
    // KEEP branch matters as much as the fallback: `activeDb` is persisted, so a session that left
    // the library open came back to "No model yet" with fifty-one models in the project, because
    // the library passed `!read_only` and was kept.
    setActiveDb((prev) =>
      prev && dbs.some((d) => d.name === prev && d.kind === 'foreground')
        ? prev
        : (dbs.find((d) => d.kind === 'foreground')?.name ?? null)
    )
    // Keep what the user ticked, minus anything that no longer exists; fall back to the default.
    setSearchDbs((prev) => {
      const alive = prev.filter((n) => dbs.some((d) => d.name === n))
      return alive.length ? alive : defaultSearchDbs(dbs)
    })
    // The import wizard is left alone: a refresh is no reason to close it. It used to be closed here,
    // which took away the second wizard opened by "Also import" — and would have taken away a running
    // import's progress whenever anything else refreshed the list meanwhile.
    // Prune cached views of models that no longer exist. The project store cleans itself up (the
    // rename and delete commands move/remove the entry), so this is only local hygiene — plus the
    // legacy `prism.canvas.*` keys, which are still read once as a fallback.
    try {
      const alive = new Set(dbs.map((d) => d.name))
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        for (const prefix of ['prism.view.', 'prism.canvas.']) {
          if (k?.startsWith(prefix) && !alive.has(k.slice(prefix.length))) localStorage.removeItem(k)
        }
      }
    } catch {
      /* localStorage optional */
    }
    return dbs
  }, [setActiveDb, freshDatabases, setDatabases])

  /** Startup: who am I, which projects exist, which databases does the active one hold. */
  const loadProjectsAndDatabases = useCallback(async () => {
    try {
      const info = await api<{ current_project: { name: string } | null }>('GET', '/api/v1/system/info')
      setProject(info.current_project?.name ?? '')
      setProjects((await api<{ name: string }[]>('GET', '/api/v1/projects')).map((p) => p.name))
      await refreshDatabases()
    } finally {
      // Over, either way: a failed start must still reach the gate and its recovery controls.
      setStartupDone(true)
    }
  }, [refreshDatabases])

  const activateProject = useCallback(
    (name: string) => {
      if (!name || name === project) return
      void run(async () => {
        // Views are keyed by model name and written into whichever workspace is active. The
        // outgoing model is closed first — synchronously, so the canvas's own departure save runs
        // NOW, while the backend still stands in its workspace — then the fence goes up. One save
        // path, the one every model switch already takes; `finally` takes the fence down.
        // One switch at a time: a second one started while the first still loads would interleave
        // their fences and refreshes. The picker snaps back to the workspace shown.
        if (switchBusy.current) return
        switchBusy.current = true
        leaveModel()
        const fence = await beginWorkspaceSwitch()
        let switched = false
        try {
          await api('POST', `/api/v1/projects/${encodeURIComponent(name)}/activate`)
          switched = true
          // The same generation refreshDatabases counts: a refresh still running from the workspace
          // just left must not land in this one, and a newer one wins over this read.
          const mine = ++refreshSeq.current
          // A project switch changes every server answer at once — one prefix covers them all.
          invalidate('/api/v1/')
          resetThemePreviews()
          setProject(name)
          onProjectSwitched()
          setActiveDb(null)
          const dbs = await fetchQuery('/api/v1/databases')
          // The old canvas has torn down (into the fence) while that was out; the caches go before the
          // incoming model loads, or it would start from the old workspace's copy of its name.
          endWorkspaceSwitch(fence)
          if (mine === refreshSeq.current) {
            setDatabases(dbs)
            // Canvas is for foreground modelling only — never auto-load a huge read-only background
            // DB (e.g. 26k-activity ecoinvent) into the graph; leave null until a foreground DB exists.
            setActiveDb(dbs.find((d) => d.kind === 'foreground')?.name ?? null)
            // Search targets a background DB (that's what you search); fall back to the first DB.
            setSearchDbs(defaultSearchDbs(dbs))
            setShowSetup(false)
          }
          // (`methods` is a subscription; the invalidate above already refreshes it.)
          // The undo stacks are dropped server-side when a project is activated (they belonged to the
          // project we just left), and the audit log is a different project's now. Both are read back
          // here so the toolbar and the panel describe the project actually in front of you.
          await reloadAudit()
        } finally {
          if (switched) endWorkspaceSwitch(fence)
          else cancelWorkspaceSwitch(fence)
          switchBusy.current = false
        }
      })
    },
    [project, run, onProjectSwitched, reloadAudit, setActiveDb, leaveModel, setDatabases]
  )

  // Delete a Brightway project (and its data dir) after explicit confirmation. The backend
  // refuses the active project and 'default'; not undoable, hence the danger dialog.
  const deleteProject = useCallback(
    (name: string): void =>
      setConfirm({
        title: 'Delete workspace',
        message: `Delete workspace “${name}” and all its data (databases, methods, models)? This runs through Brightway and cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => {
          void run(async () => {
            const wasActive = name === project
            await api('DELETE', `/api/v1/projects/${encodeURIComponent(name)}`)
            setProjects((await api<{ name: string }[]>('GET', '/api/v1/projects')).map((p) => p.name))
            // The backend drops us into 'default' if we deleted the project we were standing in —
            // pull that project's (empty) state into the UI so it doesn't show stale data.
            if (wasActive) activateProject('default')
          })
        }
      }),
    [setConfirm, run, project, activateProject]
  )

  /** Write a full project backup, after saying what it contains. Path in, path out: an archive of
   *  gigabytes has no business travelling through the IPC bridge as base64. */
  const backupProject = useCallback(async () => {
    await run(async () => {
      const est = await api<{ bytes: number; warning: string; databases: string[] }>(
        'GET',
        '/api/v1/system/backup/estimate'
      )
      const gb = est.bytes / 1024 ** 3
      const size = gb >= 1 ? `${gb.toFixed(1)} GB` : `${(est.bytes / 1024 ** 2).toFixed(0)} MB`
      const dir = await window.prism.pickDirectory()
      if (!dir) return
      // The house dialog instead of window.confirm/alert — same look as every other confirmation.
      setConfirm({
        title: 'Write a workspace backup?',
        message: `${est.warning}\n\nAbout ${size} will be written to:\n${dir}`,
        confirmLabel: 'Write backup',
        onConfirm: () => {
          void run(async () => {
            const r = await api<{ path: string }>('POST', '/api/v1/system/backup', { directory: dir })
            setConfirm({ title: 'Backup written', message: r.path, notice: true, onConfirm: () => {} })
          })
        }
      })
    })
  }, [run, setConfirm])

  /**
   * Restore a workspace backup (the .tar.gz that "Back up this workspace" writes) as a workspace of its
   * own. Never over an existing one: a name clash comes back as `workspace_exists`, the caller asks for
   * another name (`onNameTaken`) and calls this again with it — the backend's overwrite stays unused here.
   */
  const restoreBackup = useCallback(
    async (onNameTaken: (path: string) => void, path?: string, name?: string): Promise<void> => {
      const file =
        path ?? (await window.prism.pickFile([{ name: 'Workspace backup', extensions: ['gz', 'tgz'] }]))
      if (!file) return
      const go = (): void => {
        void run(async () => {
          try {
            const r = await api<{ project_name: string }>('POST', '/api/v1/projects/restore', {
              path: file,
              ...(name ? { project_name: name } : {})
            })
            setProjects((await api<{ name: string }[]>('GET', '/api/v1/projects')).map((p) => p.name))
            setConfirm({
              title: 'Workspace restored',
              message: `The backup is now the workspace “${r.project_name}”. Switch to it now?`,
              confirmLabel: 'Switch to it',
              onConfirm: () => activateProject(r.project_name)
            })
          } catch (e) {
            if (e instanceof ApiError && e.code === 'workspace_exists') {
              onNameTaken(file)
              return
            }
            throw e
          }
        })
      }
      // The second round, with a new name, was confirmed already.
      if (name) return go()
      setConfirm({
        title: 'Restore a workspace backup?',
        message:
          `PrismLCA adds the workspace saved in:\n${file}\n\n` +
          'It becomes a workspace of its own; no existing workspace is replaced. A large backup takes a few minutes.',
        confirmLabel: 'Restore',
        onConfirm: go
      })
    },
    [run, setConfirm, activateProject]
  )

  // Delete a model after explicit confirmation (used by the Overview model list).
  // Database lifecycle is NOT undoable, hence the danger dialog.
  const deleteModel = useCallback(
    (name: string): void =>
      setConfirm({
        title: 'Delete model',
        message: `Delete “${name}” with all its processes? This cannot be undone.`,
        confirmLabel: 'Delete',
        danger: true,
        onConfirm: () => {
          void run(async () => {
            await api('POST', '/api/v1/databases/foreground/delete', { database: name })
            // Close it first when it is still the open one, as a workspace switch does: the
            // pages' effects are cleaned up before a late answer for the gone model can write to it.
            // Read through the updater, not the closure — the user may have opened another model
            // while the delete was out, and that one stays open.
            flushSync(() => setActiveDb((cur) => (cur === name ? null : cur)))
            forgetView(name) // a layout write still in its debounce must not resurrect the entry
            const dbs = await freshDatabases()
            setDatabases(dbs)
            const next = dbs.find((d) => d.kind === 'foreground' && !d.read_only)?.name ?? null
            if (activeDb === name) setActiveDb((cur) => (cur === null || cur === name ? next : cur))
            await reloadAudit()
          })
        }
      }),
    [setConfirm, run, freshDatabases, activeDb, setActiveDb, reloadAudit, setDatabases]
  )

  /**
   * A model that has just come into existence outside the create/duplicate dialogs — an import.
   *
   * The refresh is the whole point: `setActiveDb` alone pointed at a database the `databases` list did
   * not contain yet, so the Overview list and the model dropdown both stayed as they were and the
   * imported model looked lost until the app was restarted. Creating and duplicating always
   * re-fetched the list; the import path did not, and this is that same step.
   */
  const openFreshModel = useCallback(
    (name: string): void => {
      void run(async () => {
        const dbs = await freshDatabases()
        setDatabases(dbs)
        openModel(name)
        setSearchDbs((prev) => (prev.length ? prev : defaultSearchDbs(dbs)))
        openModelView()
        await reloadAudit()
      })
    },
    [run, reloadAudit, openModel, freshDatabases, openModelView, setDatabases]
  )

  /**
   * The model goes by another name now (renamed in its info sheet). Everything model-scoped followed
   * it in the project; what is left is this window — the model list, the search box's model, and, when
   * the renamed model is the open one, `activeDb`: canvas node ids carry the database name, so under
   * the old one nothing on screen is addressable any more.
   */
  const renamedModel = useCallback(
    (from: string, to: string): void => {
      void run(async () => {
        // The canvas refs move BEFORE `activeDb` does — see renameCanvasRefs in the deps.
        if (renameCanvasRefs(from, to)) setActiveDb(to)
        // "Last models" follows the model to its new name — a rename is not an open, so no new stamp.
        renameRecentModel(project, from, to)
        setSearchDbs((prev) => prev.map((n) => (n === from ? to : n)))
        await refreshDatabases()
        await reloadAudit()
      })
    },
    [run, refreshDatabases, reloadAudit, setActiveDb, renameCanvasRefs, project]
  )

  /** The "New model" dialog's submit: create (or copy), file, and open the model on its canvas —
   *  from the start page too, where it used to stay on the start page with the model only selected. */
  const submitNewModel = useCallback(
    async (values: Record<string, string>): Promise<void> => {
      const name = (values.name || '').trim()
      if (!name) return
      const from = (values.duplicateFrom || '').trim()
      if (from) {
        await api('POST', '/api/v1/databases/foreground/duplicate', { source: from, name })
      } else {
        await api('POST', '/api/v1/databases/foreground', { name })
      }
      // Optional goal & scope from the create dialog → the model's study metadata (the AI
      // assistant reads this as its brief; editable later via the Info button).
      const goal = (values.goal || '').trim()
      const scope = (values.scope || '').trim()
      if (goal || scope) {
        await api('POST', '/api/v1/study', {
          database: name,
          goal: goal || undefined,
          scope: scope || undefined
        })
      }
      // Filed straight away if a folder was picked. A duplicate already inherits its original's
      // folder, so this only overrides that when the dialog says something else.
      const folder = (values.folder || '').trim()
      if (folder) await assignFolder(name, folder)
      else if (from) await reloadFolders() // the copy inherited one; the list has to hear about it
      const dbs = await freshDatabases()
      setDatabases(dbs)
      openModel(name) // the new model becomes the active one to edit
      setSearchDbs((prev) => (prev.length ? prev : defaultSearchDbs(dbs)))
      setShowSetup(false)
      openModelView()
    },
    [freshDatabases, openModel, openModelView, setDatabases]
  )

  /** Create AND activate an (empty) workspace server-side, and point every piece of state at it.
   *  Shared by the "New workspace" dialog and the first-run import wizard, which proposes "Main"
   *  instead of leaving the user in Brightway's `default`. */
  const createWorkspace = useCallback(
    async (name: string): Promise<void> => {
      if (switchBusy.current) return // see activateProject
      switchBusy.current = true
      leaveModel() // see activateProject
      const fence = await beginWorkspaceSwitch()
      let switched = false
      try {
        await api('POST', '/api/v1/projects', { name })
        switched = true
        const mine = ++refreshSeq.current // see activateProject
        // The backend stands in the new workspace now: the old model goes BEFORE anything else is
        // awaited, so a failing refresh below cannot leave it on screen issuing requests against
        // the new one.
        setProject(name)
        onProjectSwitched()
        setActiveDb(null)
        invalidate('/api/v1/') // a fresh workspace: every cached answer belongs to the old one
        setProjects((await api<{ name: string }[]>('GET', '/api/v1/projects')).map((p) => p.name))
        const dbs = await fetchQuery('/api/v1/databases')
        endWorkspaceSwitch(fence)
        if (mine === refreshSeq.current) {
          setDatabases(dbs)
          setSearchDbs(defaultSearchDbs(dbs))
        }
      } finally {
        if (switched) endWorkspaceSwitch(fence)
        else cancelWorkspaceSwitch(fence)
        switchBusy.current = false
      }
    },
    [onProjectSwitched, setActiveDb, leaveModel, setDatabases]
  )

  /** The "New workspace" dialog's submit. The workspace has no databases yet, so the setup gate
   *  opens the import wizard — that's the "new workspace + import" path. */
  const submitNewProject = useCallback(
    async (values: Record<string, string>): Promise<void> => {
      const name = (values.name || '').trim()
      if (!name) return
      await createWorkspace(name)
      setShowSetup(false)
    },
    [createWorkspace]
  )

  /** The "Duplicate model" dialog's submit: the copy becomes the active model, like a new one. */
  const submitDuplicateModel = useCallback(
    async (source: string, values: Record<string, string>): Promise<void> => {
      const name = (values.name || '').trim()
      if (!name) return
      await api('POST', '/api/v1/databases/foreground/duplicate', { source, name })
      const dbs = await freshDatabases()
      setDatabases(dbs)
      openModel(name)
      await reloadAudit()
    },
    [freshDatabases, openModel, reloadAudit, setDatabases]
  )

  return {
    project,
    projects,
    databases,
    setDatabases,
    /** False until the start-up read has a list or has failed — nothing to decide the gate on before. */
    startupSettled: listed || startupDone,
    activeDb,
    setActiveDb,
    openModel,
    searchDbs,
    setSearchDbs,
    showSetup,
    setShowSetup,
    freshDatabases,
    refreshDatabases,
    loadProjectsAndDatabases,
    activateProject,
    deleteProject,
    backupProject,
    deleteModel,
    openFreshModel,
    renamedModel,
    submitNewModel,
    submitNewProject,
    restoreBackup,
    createWorkspace,
    submitDuplicateModel
  }
}
