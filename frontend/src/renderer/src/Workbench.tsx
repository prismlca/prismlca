import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent
} from 'react'
import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  type Connection,
  type Edge
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { api, isSuperseded, type AuditEntry, type UndoState } from './lib/api'
import { fetchQuery, invalidate, useQuery } from './lib/server/useQuery'

import { getFolders, subscribeFolders } from './lib/modelFolders'
import {
  ARROW_COLOR,
  arrowMarker,
  collectShares,
  HAND_PAN_BUTTONS,
  highlightEdges,
  PAN_BUTTONS,
  splitId,
  type ShareTreeNode
} from './lib/canvas'
import { addTarget, drawnGroups, groupLabel, groupOf, nodeBoxes } from './lib/groups'
import { showMinimap } from './lib/minimap'
import { connectBody, edgeShareFor, shareFor, type CalcMeta } from './lib/occurrences'
import { NODE_COLORS } from './lib/palette'
import { type SearchHit, secondaryBackgrounds } from './lib/search'
import SearchPanel from './components/SearchPanel'
import NodeContextMenu, { type CtxMenuState } from './components/NodeContextMenu'
import { usePersisted } from './lib/persist'
import { useSettings } from './lib/settings'
import Parameters from './views/Parameters'
import Results from './views/Results'
import DetailedResults from './views/DetailedResults'
import Lcia from './views/Lcia'
import Scenarios from './views/Scenarios'
import ActivityEditor from './views/ActivityEditor'
import ProcessDetails from './views/ProcessDetails'
import Settings, { type SettingsCategory, type SettingsFocus } from './views/Settings'
import DistancesSheet from './views/DistancesSheet'
import ConfirmDialog, { type ConfirmSpec } from './views/ConfirmDialog'
import AuditLog from './components/AuditLog'
import { groupsOnCanvas } from './lib/tagHighlight'
import Setup from './views/Setup'
import BackgroundData from './views/BackgroundData'
import CanvasChat from './CanvasChat'
import CanvasGroups from './components/CanvasGroups'
import CanvasMinimap from './components/CanvasMinimap'
import GroupTools from './components/GroupTools'
import TintSwatches from './components/TintSwatches'
import { EDGE_TYPES, NODE_TYPES } from './components/canvasTypes'
import TagMenu from './components/TagMenu'
import TagManager from './components/TagManager'
import ModelInfo from './components/ModelInfo'
import Overview from './views/Overview'
import Report from './views/Report'
import { mutationRunner } from './lib/mutation'
import Overlay from './components/Overlay'
import AppSidebar, { type ViewKey } from './workbench/AppSidebar'
import ModelToolbar from './workbench/ModelToolbar'
import { ExportBundleSheet } from './views/BundleDialogs'
import SetupGate, { type BackgroundSource } from './workbench/SetupGate'
import WorkbenchModals, { type ModalState } from './workbench/WorkbenchModals'
import { exchangeFacts } from './workbench/exchangeFacts'
import { useProjectModels } from './workbench/useProjectModels'
import { useAiCanvasTools } from './workbench/useAiCanvasTools'
import { useTagging } from './workbench/useTagging'
import { useCanvasModel } from './workbench/useCanvasModel'
import { useSearchIndexStatus } from './workbench/useSearchIndexStatus'
import { usePendingAsks } from './workbench/usePendingAsks'
import ChatElsewhereBanner from './components/ChatElsewhereBanner'
import { useTurnFeed } from './chat/turnView'
import { invalidateModelCaches } from './lib/server/modelCaches'
import { useAiEditRefresh } from './workbench/useAiEditRefresh'
import { useHistorySteps } from './workbench/useHistorySteps'
import { usedFirst } from './lib/tagGroupsUsed'
import { useExternalAgents } from './workbench/useExternalAgents'
import { useMcpUiTools } from './workbench/useMcpUiTools'
import ExternalAgentsPanel from './workbench/ExternalAgentsPanel'
import { HighlightIcon, ImportIcon, PanIcon, PointerIcon, SaveIcon, TrashIcon } from './components/icons'
import { useBusy } from './lib/busy'

/**
 * The client names for the external-agents bar, one entry per client: several instances of the same
 * client (two Claude Code sessions, say) collapse to “Claude Code (2 instances)” instead of a
 * repeated name; the count is shown only above one.
 */
export function describeExternalClients(sessions: ReadonlyArray<{ clientName: string }>): string {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    const name = s.clientName || 'An external agent'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${name} (${n} instances)` : name)).join(', ')
}

export default function Workbench(): JSX.Element {
  // The folders the New-model dialog offers. Read from the shared store rather than fetched here,
  // so a folder made in the Overview list is pickable in the dialog without a reload.
  const folderState = useSyncExternalStore(subscribeFolders, getFolders)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  // What Undo/Redo would do, from `GET /model/history`. Read for the first time here: the endpoint
  // has always existed and nothing called it, so both buttons were permanently enabled and never
  // said what they would take back. That is also what made the project-switch fault invisible —
  // the stacks were cleared or not, and the toolbar looked identical either way.
  const [undoState, setUndoState] = useState<UndoState>({
    can_undo: false,
    can_redo: false,
    next_undo: null,
    next_redo: null
  })
  const [modelRev, setModelRev] = useState(0) // bumped on every model mutation → refreshes the inspector
  const [error, setError] = useState<string | null>(null)
  // The informational counterpart of `error`: something worked and there is one thing to say about it.
  // Its own banner rather than the red one — "three boxes drawn, one tag skipped" is not a failure.
  const [note, setNote] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const [showBackground, setShowBackground] = useState(false)
  const [showDistances, setShowDistances] = useState(false)
  // Which background the import wizard is opened for (ecoinvent is the recommended first one).
  const [setupSource, setSetupSource] = useState<BackgroundSource>('ecoinvent')
  // Which Settings page is open, or null for closed. A page rather than a flag because the chat's
  // "+" menu links straight into Skills; the toolbar gear opens the first page as before.
  const [showSettings, setShowSettings] = useState<{ page: SettingsCategory; focus?: SettingsFocus } | null>(
    null
  )
  const [showTagManager, setShowTagManager] = useState(false)
  const [showModelInfo, setShowModelInfo] = useState(false)
  //: The export sheet, opened from the toolbar — the same one the Overview's model card opens.
  const [exportModel, setExportModel] = useState(false)
  // Search-index build status, polled — drives the sidebar progress bar and the search-panel hints.
  const idxStatus = useSearchIndexStatus()
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const [brush, setBrush] = useState<string | null>(null) // active paint colour (brush mode)
  const [brushPalette, setBrushPalette] = useState(false)
  // Hand tool: a left-drag pans the canvas instead of drawing a selection box. The middle button and a
  // held Space (React Flow's `panActivationKeyCode`) pan without it; this is for a mouse or touchpad
  // without a middle button. The brush and the hand both own the left-drag, so turning one on turns the
  // other off.
  const [hand, setHand] = useState(false)
  // The process under the mouse. Its arrows and those of the selected processes are drawn in green
  // (see highlightEdges); the node itself lights up through `.pnode:hover` in CSS.
  const [hovered, setHovered] = useState<string | null>(null)
  const settings = useSettings()
  // Deliberately NOT a stored setting: every start begins with the full rail, so
  // the page names are on screen before the icons are asked to stand for them. Folding it is a thing
  // you do to get room for the task in front of you, not a preference to carry to the next session.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [detailsFor, setDetailsFor] = useState<{ database: string; code: string } | null>(null)
  /** A library dataset opened for editing. One dataset, not the whole library: the library is not a
   *  study, so it is not opened on the canvas like one. */
  const [editDataset, setEditDataset] = useState<{ database: string; code: string } | null>(null)
  const [dark, setDark] = useState<boolean>(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  // Subscription on the shared cache: the method catalog refreshes wherever it is invalidated
  // (project switch, ecoinvent import, the custom-method editor) — no per-site refetch code.
  const methods = useQuery('/api/v1/calc/methods').data ?? []
  // Known units (ecoinvent + models) for the unit autocomplete; strictness comes from Settings.
  // Loaded at startup AND healed whenever the new-activity dialog opens with an empty list
  // (e.g. the startup fetch predated an HMR update or failed).
  const [unitVocab, setUnitVocab] = useState<string[]>([])
  const [chosen, setChosen] = useState('')
  // The default indicator pick follows the catalog's arrival (it used to be set inline where the
  // catalog was fetched; the fetch sites are gone, the default is not).
  useEffect(() => {
    if (methods.length) setChosen((prev) => prev || '0')
  }, [methods.length])
  const [result, setResult] = useState<{
    total: number
    unit: string
    method: string
    fu: string
    seconds: number
    nodes: number
  } | null>(null)
  const [calcBusy, setCalcBusy] = useState<'calc' | 'mc' | null>(null)
  // The bar is one model's result. Switching models left it standing over the next canvas as if it were
  // that one's; the Sankey shares live on the nodes, which the switch rebuilds anyway.
  const resultDb = useRef<string | null>(null)
  const [view, setView] = useState<ViewKey>('overview') // every app start lands on the Overview
  // Questions the assistant is waiting on, and which of them the chat panel has on screen. Every other
  // one gets a banner under the toolbar with the way to its chat — the question would otherwise wait
  // unseen until main's timeout lets the run go on without an answer.
  const pendingAsks = usePendingAsks()
  // The chat's turns in flight keep being recorded while the chat panel is unmounted (other views).
  useTurnFeed()
  const [askShown, setAskShown] = useState<string | null>(null)
  const [focusChat, setFocusChat] = useState<{ chatId: string; nonce: number } | null>(null)
  // A question from an external session (MCP) has no chat: it is answered on a card in the
  // External-agents drawer, so the chat banner must not offer "Go to chat" for it.
  const mcpAsks = pendingAsks.filter((a) => a.origin === 'mcp')
  const unseenAsks = pendingAsks.filter((a) => a.origin !== 'mcp' && a.reqId !== askShown)
  const [xaOpen, setXaOpen] = useState(false)
  const viewRef = useRef<ViewKey>('overview')
  viewRef.current = view
  const run = useMemo(() => mutationRunner({ setError }), [])
  const busy = useBusy()

  // The model whose history the canvas column shows. A mutable link like `canvasLink` below: the open
  // model is only known after the project hook, and `reloadAudit` has to be stable before it.
  const auditModel = useRef<string | null>(null)
  const fetchAudit = useCallback(() => {
    const db = auditModel.current
    return api<AuditEntry[]>(
      'GET',
      db ? `/api/v1/model/audit?database=${encodeURIComponent(db)}` : '/api/v1/model/audit'
    )
  }, [])
  // Undo and Redo act on the open model only — the same link, so the toolbar asks about that model.
  const fetchHistory = useCallback(() => {
    const db = auditModel.current
    return api<UndoState>(
      'GET',
      db ? `/api/v1/model/history?database=${encodeURIComponent(db)}` : '/api/v1/model/history'
    ).then((h) => ({ ...h, model: db })) // which model the answer is about (useHistorySteps checks it)
  }, [])
  /**
   * What Undo and Redo would take back. Cheap on purpose — the endpoint reads two in-memory lists —
   * because it has to be re-read more often than the audit log itself.
   */
  const reloadHistory = useCallback(async () => {
    const asked = auditModel.current
    const history = await fetchHistory()
    // An answer for the model that was open when it was asked — not for the one open now.
    if (auditModel.current === asked) setUndoState(history)
  }, [fetchHistory])

  const reloadAudit = useCallback(async () => {
    // The open model's entries, like Parameters and Scenarios. It used to be the whole workspace's newest
    // 200 here, unlabelled — on "Mould remover R7" that was 137 lines of another model and none of its
    // own, read as that model's history. Workspace-wide actions still appear, marked.
    const asked = auditModel.current
    try {
      const [entries, history] = await Promise.all([fetchAudit(), fetchHistory()])
      // A reload started before a model switch must not paint the old model's log and Undo over the new
      // one's. The caches below go stale either way.
      if (auditModel.current === asked) {
        setAudit(entries)
        setUndoState(history)
      }
      setModelRev((r) => r + 1) // any op that reloads the audit also refreshes the inspector
    } finally {
      // The same truth feeds the cache: every model mutation lands here (undo/redo included), so the
      // model-scoped keys go stale exactly when the inspector refreshes. The onChanged chains stay —
      // this step ADDS the cache to the bus, it does not replace the bus. The edit happened whether or
      // not its log could be read, so a failed read must not leave the caches marked current.
      invalidateModelCaches()
    }
  }, [fetchAudit, fetchHistory])

  const openModelView = useCallback(() => setView('model'), [])

  // The two lifecycle callbacks below run against the canvas hook, which is constructed AFTER the
  // project hook (it needs `activeDb`). A mutable link breaks the cycle: the callbacks are stable,
  // the link is re-pointed every render.
  const canvasLink = useRef<{ clear: () => void; rename: (from: string, to: string) => boolean }>({
    clear: () => {},
    rename: () => false
  })
  const onProjectSwitched = useCallback(() => canvasLink.current.clear(), [])
  const renameCanvasRefs = useCallback((from: string, to: string) => canvasLink.current.rename(from, to), [])

  const {
    project,
    projects,
    databases,
    setDatabases,
    startupSettled,
    freshDatabases,
    activeDb,
    setActiveDb,
    openModel,
    searchDbs,
    setSearchDbs,
    showSetup,
    setShowSetup,
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
  } = useProjectModels({
    run,
    reloadAudit,
    setConfirm,
    onProjectSwitched,
    renameCanvasRefs,
    openModelView
  })
  auditModel.current = activeDb
  // Model, view, chat — in that order; the chat panel consumes the focus request once the model's chats
  // are loaded (see CanvasChat's focusChat). Without a model the chat is one of the open model's.
  const goToChat = useCallback(
    (database: string | null | undefined, chatId: string): void => {
      if (database) openModel(database)
      setView('model')
      setFocusChat({ chatId, nonce: Date.now() })
    },
    [openModel]
  )
  // A new model, a new history. Only the log — not `reloadAudit`, which would also drop the model's
  // cached graph and activities that the switch is loading at this very moment. A late answer for the
  // previous model is dropped.
  useEffect(() => {
    let alive = true
    // Nothing of the previous model in the meantime: an empty log, and Undo/Redo off until this
    // model's answer is in — a click before it would describe one model's step and send another.
    setAudit([])
    setUndoState({ can_undo: false, can_redo: false, next_undo: null, next_redo: null })
    void Promise.all([fetchAudit(), fetchHistory()])
      .then(([entries, history]) => {
        if (!alive) return
        setAudit(entries)
        setUndoState(history)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [activeDb, fetchAudit, fetchHistory])
  // Which kind of database a dataset lives in — the inspector and the details window name its source with it.
  const dbKind = (name: string): string | undefined => databases.find((d) => d.name === name)?.kind

  const canvas = useCanvasModel({
    run,
    activeDb,
    setConfirm,
    setError,
    reloadAudit,
    edgeDigits: settings.round.edges
  })
  const {
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    selected,
    setSelected,
    selectOnly,
    posRef,
    selectedRef,
    lastSelRef,
    rfRef,
    activeDbRef,
    nodeColors,
    resetColors,
    paintNodes,
    groups,
    groupsRef,
    selGroup,
    setSelGroup,
    editGroup,
    setEditGroup,
    groupPicker,
    setGroupPicker,
    groupSelection,
    ungroup,
    addSelectionToGroup,
    renameGroupTo,
    restackGroup,
    selectGroup,
    paintGroup,
    moveGroup,
    moveGroupEnd,
    reloadGraph,
    autoLayout,
    history,
    expandNode,
    collapse,
    deleteSelected,
    deleteNode,
    addReference,
    localize,
    toLibrary,
    noteConnected
  } = canvas
  // What React Flow draws: the canvas truth with the hovered/selected processes' arrows marked green.
  // Derived, not stored — the underlying `edges` stay untouched, so undo, Sankey widths and reloads
  // never have to know about the highlight.
  const shownEdges = useMemo(() => {
    const hot = new Set(selected)
    if (hovered) hot.add(hovered)
    return highlightEdges(edges, hot)
  }, [edges, selected, hovered])
  // Point the project hook's lifecycle callbacks at the live canvas (see canvasLink above).
  canvasLink.current = {
    clear: () => {
      setSelected([])
      setNodes([])
      setEdges([])
      // Its model belonged to the workspace just left; the next model's load must not save the old
      // canvas under that name into this one.
      canvas.prevDbRef.current = null
    },
    rename: (from: string, to: string): boolean => {
      if (canvas.prevDbRef.current === from) canvas.prevDbRef.current = to
      const wasActive = activeDbRef.current === from
      if (wasActive) activeDbRef.current = to
      return wasActive
    }
  }

  const tagging = useTagging({
    run,
    activeDb,
    modelRev,
    reloadAudit,
    setError,
    setNote,
    onGrouped: () => setShowTagManager(false),
    canvas
  })
  const {
    tagGroups,
    reloadTagGroups,
    tagMenu,
    setTagMenu,
    setNodeTag,
    createTagGroup,
    addTagValue,
    deleteTagGroup,
    removeTagValue,
    mergeTagValue,
    mergeTagGroup,
    groupByTagGroup,
    hlTag,
    setHlTag,
    hlMenu,
    setHlMenu,
    inspTags
  } = tagging
  // The highlight menu offers what this canvas carries, not every group of the workspace.
  const hlGroups = useMemo(() => groupsOnCanvas(tagGroups, nodes), [tagGroups, nodes])

  const [resultsTab, setResultsTab] = usePersisted<'overview' | 'detail'>('prism.resultsTab', 'overview')
  // Results views stay mounted (hidden) once visited, so a hop to the model page and back does not
  // throw computed results away. Reset per model — that is the cleanup: nothing outlives its model,
  // and at most one result set per tab is ever held.
  const [seenResults, setSeenResults] = useState<Set<'overview' | 'detail'>>(new Set())
  useEffect(() => {
    setSeenResults(new Set())
  }, [activeDb])
  // The report page keeps itself for the same reason and one that costs money: a chapter is written
  // by a call in the main process while "a run is in progress" lives in this view's own state. Unmount
  // it mid-run — one hop to Parameters and back — and the Write button came back enabled with the run
  // still going, so a second *paid* call was one click away and its answer overwrote the first (V150;
  // observed once: ~5 calls for one chapter). Staying mounted also keeps
  // the staleness answer, which otherwise recomputed for 24–31 s on every return. Reset per model.
  // Without a model (backgrounds imported, nothing built yet) only the workspace's own pages make sense.
  useEffect(() => {
    if (!activeDb && view !== 'overview' && view !== 'lcia') setView('overview')
  }, [activeDb, view])
  const [seenReport, setSeenReport] = useState(false)
  useEffect(() => {
    setSeenReport(false)
  }, [activeDb])
  useEffect(() => {
    if (view === 'report') setSeenReport(true)
    // `activeDb` for the same reason as the results tabs: the reset above runs first, and without
    // re-arming the page you are looking at, switching models on the Report page blanks it.
  }, [view, activeDb])
  useEffect(() => {
    if (view === 'results') {
      setSeenResults((s) => (s.has(resultsTab) ? s : new Set(s).add(resultsTab)))
    }
    // `activeDb` is a dependency ON PURPOSE: the reset above empties the set on a model switch, and
    // without re-adding the tab you are LOOKING AT, switching models while on the Results page
    // unmounted the view and never brought it back — a blank main area until some navigation
    // changed `view`. Declared after the reset, so its update lands second.
  }, [view, resultsTab, activeDb])
  const [lciaTab, setLciaTab] = usePersisted<'compare' | 'methods'>('prism.lcia.tab', 'compare')
  const [mc, setMc] = useState<{
    mean: number
    std: number
    p5: number
    p95: number
    unit: string
    iterations: number
  } | null>(null)
  useEffect(() => {
    if (resultDb.current === activeDb) return
    resultDb.current = activeDb
    setResult(null)
    setMc(null)
  }, [activeDb])

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null)
  // Right-click on empty canvas: offer to create a foreground activity exactly there.
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number; flow: { x: number; y: number } } | null>(
    null
  )
  // Right-click on a group's grab strip.
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; id: string } | null>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  }, [dark])

  /**
   * Re-read on every navigation and model switch, because the toolbar outlives the page: the pair sits
   * in the topbar of Overview and of every other view, and the buttons are *disabled* when nothing is
   * undoable — a stale answer there is not a stale tooltip, it is a button that refuses work it could
   * do or offers work it cannot.
   *
   * This effect alone was not enough, and the first version of this comment said why wrongly: it
   * claimed the buttons live on two pages and that mutations made on Parameters and Scenarios refresh
   * this themselves. Neither held. Those two pages sit under the same toolbar, they write through
   * their own `api()` call, and they never touched this state — so after setting a parameter, Undo
   * read “Nothing to undo” while the line was already in the audit list beside it, and Redo stayed
   * enabled on a stack the write had just cleared (measured: clicking it produced the
   * “Nothing to redo.” banner). Both pages now report an undoable write through `onChanged`, and
   * `modelRev` carries the other direction — an Undo from the toolbar reloads the page under it.
   */
  useEffect(() => {
    void reloadHistory()
  }, [view, activeDb, reloadHistory])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Every canvas popover goes on Escape — the node and pane menus and the group menus closed only
        // on a click inside the stage before. The setters are no-ops when
        // nothing is open, so this needs no state in its dependencies.
        setCtxMenu(null)
        setPaneMenu(null)
        setGroupMenu(null)
        setGroupPicker(null)
        setHlMenu(false)
        setHand(false)
        if (brush || brushPalette) {
          setBrush(null)
          setBrushPalette(false)
        }
        return
      }
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      // The selection survives a view switch, but the key must not act on processes nobody can see —
      // Delete on a button in the Report view opened the confirm for a canvas node.
      // Same for a dialog on top: its own keys are its own.
      if (viewRef.current !== 'model') return
      if (document.querySelector('.modal-backdrop, .overlay')) return
      if (selected.length > 1) {
        e.preventDefault()
        deleteSelected()
      } else if (selected.length === 1) {
        e.preventDefault()
        deleteNode(selected[0])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, deleteNode, deleteSelected, brush, brushPalette, setGroupPicker, setHlMenu])

  useEffect(() => {
    void run(async () => {
      await loadProjectsAndDatabases()
      await reloadTagGroups()
      await fetchQuery('/api/v1/calc/methods') // warm the cache; `methods` below subscribes
      setUnitVocab((await fetchQuery('/api/v1/model/unit-vocabulary')).units)
      await reloadAudit()
    })
  }, [run, loadProjectsAndDatabases, reloadTagGroups, reloadAudit])

  const newProject = (): void => setModal({ kind: 'newProject' })

  // Switch / create / delete projects. Split so the sidebar can right-align the actions in the
  // title row (the dropdown row is too narrow), while the wider setup gate keeps them inline.
  // Shared with the gate so an empty project (which hides the sidebar) is still deletable.
  const projectSelect = (
    <select
      className="proj-sel"
      value={project}
      onChange={(e) => activateProject(e.target.value)}
      title="Switch workspace — one background database and the models built on it (a Brightway project on disk)"
    >
      {(projects.length ? projects : [project || 'default']).map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
    </select>
  )
  const projectActions = (
    <div className="scen-card-actions">
      <button
        className="act-icon"
        onClick={newProject}
        aria-label="New workspace"
        title="Create a new (empty) workspace — then import ecoinvent into it"
        style={{ fontSize: 14, lineHeight: 1 }}
      >
        ＋
      </button>
      {/* A backup is the third thing people mean by "export" and the one that must not be sent to
          anyone: it holds the ecoinvent copy. So it asks first, with the licence sentence the backend
          supplies — one string, three places. */}
      <button
        className="act-icon"
        onClick={() => void backupProject()}
        aria-label="Back up this workspace"
        title="Write a full backup of this workspace to disk (for yourself — it contains licensed data)"
      >
        <SaveIcon />
      </button>
      <button
        className="act-icon"
        onClick={() => void restoreBackup((path) => setModal({ kind: 'restoreAs', path }))}
        aria-label="Restore a workspace backup"
        title="Restore a workspace backup (.tar.gz) as a workspace of its own — nothing existing is replaced"
      >
        <ImportIcon />
      </button>
      <button
        className="act-icon danger"
        onClick={() => deleteProject(project || 'default')}
        disabled={(project || 'default') === 'default'}
        aria-label="Delete workspace"
        title="Delete the selected workspace and all its data (via Brightway)"
      >
        <TrashIcon />
      </button>
    </div>
  )

  const newModel = () => setModal({ kind: 'newModel' })

  const duplicateModel = (name: string): void => setModal({ kind: 'duplicateModel', source: name })

  // Self-heal: whenever the new-activity dialog opens without a unit vocabulary, fetch it now.
  useEffect(() => {
    if (modal?.kind === 'newActivity' && unitVocab.length === 0) {
      void fetchQuery('/api/v1/model/unit-vocabulary')
        .then((r) => setUnitVocab(r.units))
        .catch(() => {})
    }
  }, [modal, unitVocab.length])

  const duplicateActivity = (id: string): void => {
    const [db, code] = splitId(id)
    void run(async () => {
      await api('POST', '/api/v1/model/activities/duplicate', { database: db, code })
      if (activeDb) await reloadGraph(activeDb)
      await reloadAudit()
    })
  }

  const onConnect = (c: Connection) => {
    if (c.source && c.target)
      setModal({
        kind: 'connect',
        source: c.source,
        target: c.target,
        exchange: exchangeFacts(nodes, c.source, c.target)
      })
  }
  const onEdgeClick = (_: unknown, edge: Edge) => {
    const d = edge.data as { uid: string; amount: number } | undefined
    if (d?.uid)
      setModal({
        kind: 'editAmount',
        target: edge.target,
        uid: d.uid,
        amount: d.amount,
        exchange: exchangeFacts(nodes, edge.source, edge.target)
      })
  }

  const submitModal = (values: Record<string, string>) =>
    run(async () => {
      const m = modal
      setModal(null)
      if (!m) return
      if (m.kind === 'newModel') {
        await submitNewModel(values)
        return
      }
      if (m.kind === 'newProject') {
        await submitNewProject(values)
        return
      }
      if (m.kind === 'restoreAs') {
        const name = (values.name || '').trim()
        if (name) await restoreBackup((path) => setModal({ kind: 'restoreAs', path }), m.path, name)
        return
      }
      if (m.kind === 'duplicateModel') {
        await submitDuplicateModel(m.source, values)
        return
      }
      if (!activeDb) return
      let created: string | null = null
      if (m.kind === 'newActivity') {
        const r = await api<{ activity: { code: string } }>('POST', '/api/v1/model/activities', {
          database: activeDb,
          name: values.name,
          product: values.product || null,
          unit: values.unit || null,
          location: values.location || null
        })
        created = `${activeDb}/${r.activity.code}`
        // Created from the pane context menu: the new node lands exactly where the user clicked.
        if (m.pos) posRef.current[created] = m.pos
      } else if (m.kind === 'connect') {
        // A reference→foreground link comes back from the reload as a bg_edge (keyed on the exchange
        // uid), so no need to seed it here — buildGraph draws it against its box. A box hands its tags
        // on, and a copy the user placed keeps the new input as its own (lib/occurrences.ts).
        const made = await api<{ exchange?: { uid?: string } }>(
          'POST',
          '/api/v1/model/exchanges',
          connectBody(m.source, m.target, Number(values.amount) || 0, nodes)
        )
        noteConnected(m.source, made?.exchange?.uid)
      } else if (m.kind === 'editAmount') {
        const [adb, acode] = splitId(m.target)
        await api('POST', '/api/v1/model/exchanges/amount', {
          activity_database: adb,
          activity_code: acode,
          uid: m.uid,
          amount: Number(values.amount) || 0
        })
      }
      const built = await reloadGraph(activeDb)
      // Selected once its box is on the canvas, so the inspector opens on it for the description and flows.
      if (created && built) selectOnly(created)
      await reloadAudit()
    })

  const { undo, redo, shownUndoState } = useHistorySteps({
    run,
    activeDb,
    undoState,
    history,
    freshDatabases,
    setDatabases,
    setActiveDb,
    reloadGraph,
    reloadAudit,
    setError,
    setConfirm
  })

  const calculate = (methodOverride?: string[], codeOverride?: string) => {
    // Normally computes the single selected process with the chosen method; the assistant can pass
    // an explicit method + process code to trigger the same canvas calculation + Sankey overlay.
    if (calcBusy || !activeDb || !methods.length) return
    if (!codeOverride && selected.length !== 1) return
    setCalcBusy('calc')
    void run(async () => {
      try {
        const [db, code] = codeOverride ? [activeDb, codeOverride] : splitId(selected[0])
        const method = methodOverride ?? methods[Number(chosen) || 0].method
        const t0 = Date.now()
        const c = await api<{ meta: CalcMeta; tree: unknown }>('POST', '/api/v1/calc/contribution', {
          database: db,
          code,
          method,
          amount: 1
        })
        const seconds = (Date.now() - t0) / 1000
        // Shares keyed by the full `db/code` canvas id — codes alone can collide between the
        // foreground model and a background database.
        const shares = collectShares(c.tree as ShareTreeNode, db)
        // The bar names the functional unit by its process name; the code was what it printed, an id nobody reads.
        const fuNode = nodes.find((n) => n.id === `${db}/${code}`)
        const fuLabel = (fuNode?.data as { label?: string } | undefined)?.label
        setResult({
          total: c.meta.total,
          unit: c.meta.unit,
          method: c.meta.method.join(' · '),
          fu: fuLabel || code,
          seconds,
          nodes: c.meta.n_nodes
        })
        // A box's share is its own inputs' exact impact, not its dataset's flow through the whole tree.
        setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, share: shareFor(n, shares, c.meta) } })))
        setEdges((es) =>
          es.map((e) => {
            const s = edgeShareFor(e, shares, c.meta)
            const w = s ? 1 + 12 * Math.min(1, s) : 1.6
            return {
              ...e,
              style: { stroke: ARROW_COLOR, strokeWidth: w },
              markerEnd: arrowMarker(w) // keep the arrowhead constant despite the thicker flow
            }
          })
        )
      } catch (e) {
        if (!isSuperseded(e)) throw e // let `run` surface real errors; ignore superseded ones
      } finally {
        setCalcBusy(null)
      }
    })
  }

  const clearResult = () => {
    setResult(null)
    // Drop the Sankey overlay: reset every edge to uniform thickness and clear node shares.
    setEdges((es) =>
      es.map((e) => ({ ...e, style: { stroke: ARROW_COLOR, strokeWidth: 1.6 }, markerEnd: arrowMarker(1.6) }))
    )
    setNodes((ns) =>
      ns.map((n) =>
        (n.data as { share?: number }).share === undefined
          ? n
          : { ...n, data: { ...n.data, share: undefined } }
      )
    )
  }

  const { chatUi, jumpFromAnyPage } = useAiCanvasTools({
    activeDb,
    methods,
    chosen,
    setChosen,
    calcBusy,
    calculate,
    view,
    setView,
    setResultsTab,
    reloadAudit,
    refreshDatabases,
    reloadTagGroups,
    canvas
  })
  // The canvas, the audit log and the caches follow the assistant's edits on every view, not only where
  // its chat panel is.
  useAiEditRefresh(activeDb, chatUi.refresh)
  // External agents (MCP): their sessions for the drawer, their edits reloading the canvas exactly
  // like the chat's, and the window-side answers to what they ask of the app.
  const external = useExternalAgents((database) =>
    chatUi.refresh({ canvas: !database || database === activeDb })
  )
  useMcpUiTools({
    activeDb,
    databases,
    view,
    setView,
    openModel,
    refreshDatabases,
    selected,
    resultsTab,
    chatUi
  })
  const xaSessions = external?.sessions ?? []
  // A card nobody sees is a session waiting fifteen minutes for nothing: open the drawer on arrival.
  const mcpAskCount = mcpAsks.length
  useEffect(() => {
    if (mcpAskCount) setXaOpen(true)
  }, [mcpAskCount])

  // Kept although the toolbar MC button is currently removed — it is planned to return with a
  // proper entry point; the mc result bar below still renders it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const runMc = () => {
    if (calcBusy || !activeDb || selected.length !== 1 || !methods.length) return
    setCalcBusy('mc')
    void run(async () => {
      try {
        const [db, code] = splitId(selected[0])
        const method = methods[Number(chosen) || 0].method
        setMc(await api('POST', '/api/v1/calc/montecarlo', { database: db, code, method, iterations: 1000 }))
      } finally {
        setCalcBusy(null)
      }
    })
  }

  /** The dataset this drag carries, or null when it carries something else (a file, some text). */
  const draggedHit = (e: DragEvent): SearchHit | null => {
    const raw = e.dataTransfer.getData('application/prism-hit')
    return raw ? (JSON.parse(raw) as SearchHit) : null
  }

  const onCanvasDrop = (e: DragEvent): void => {
    e.preventDefault()
    const hit = draggedHit(e)
    if (!hit) return
    addReference(hit, rfRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
  }

  /**
   * A drop on the minimap. The map hands over the point in the MODEL it was pointing at, which is
   * where the process goes — see the reasoning at `onDrop` in CanvasMinimap. No `screenToFlowPosition`
   * here on purpose: that would answer a different question (which canvas pixel is under the cursor)
   * and bury the new process under the map that took the drop.
   */
  const onMinimapDrop = (e: DragEvent, flow: { x: number; y: number }): void => {
    const hit = draggedHit(e)
    if (!hit) return
    addReference(hit, flow)
  }

  // The import wizard, the same in the gate and in the app. After an import the app opens on the
  // Overview; "Also import" starts the wizard afresh for the other database.
  const afterImport = (): Promise<void> =>
    run(async () => {
      await refreshDatabases()
      invalidate('/api/v1/calc/methods')
    })
  const setupSheet = showSetup ? (
    <Overlay onClose={() => setShowSetup(false)}>
      <Setup
        key={setupSource}
        source={setupSource}
        project={project}
        workspaceEmpty={databases.length === 0}
        onCreateWorkspace={createWorkspace}
        onClose={() => setShowSetup(false)}
        onAlsoImport={(source) => {
          setSetupSource(source)
          void afterImport()
        }}
        onDone={() => {
          setShowSetup(false)
          setView('overview')
          void afterImport()
        }}
      />
    </Overlay>
  ) : null

  // Before the start-up read has settled there is nothing to decide on: a blank frame, not the gate
  // flashing past a user whose models are about to load. Settled includes failed, so a failed start
  // keeps the gate and its recovery controls even after its error line is cleared.
  if (!startupSettled) return <div className="app-shell" />

  // ---- setup gate: nothing imported yet ----
  if (!activeDb && databases.length === 0) {
    return (
      <SetupGate
        project={project}
        error={error}
        onImport={(source) => {
          setSetupSource(source)
          setShowSetup(true)
        }}
        onOpenSettings={(page) => setShowSettings({ page })}
        projectPicker={
          <>
            {projectSelect}
            {projectActions}
          </>
        }
      >
        <WorkbenchModals
          modal={modal}
          databases={databases}
          folders={folderState.folders}
          unitVocab={unitVocab}
          restrictUnits={!settings.modelling.freeUnits}
          onClose={() => setModal(null)}
          onSubmit={submitModal}
        />
        {setupSheet}
        {confirm ? <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} /> : null}
        {showSettings ? (
          <Settings
            initialCategory={showSettings.page}
            focus={showSettings.focus}
            onClose={() => setShowSettings(null)}
          />
        ) : null}
      </SetupGate>
    )
  }

  const refreshSelected = () => {
    if (activeDb)
      void run(async () => {
        await reloadGraph(activeDb)
        await reloadAudit()
      })
  }

  const modalNode = (
    <WorkbenchModals
      modal={modal}
      databases={databases}
      folders={folderState.folders}
      unitVocab={unitVocab}
      restrictUnits={!settings.modelling.freeUnits}
      onClose={() => setModal(null)}
      onSubmit={submitModal}
    />
  )

  return (
    <div className="app-shell">
      <AppSidebar
        view={view}
        onNavigate={(v) => {
          // Clicking "Results" in the nav always lands on Overview results, not whatever
          // sub-tab was last open (the tab itself is still remembered while inside Results).
          if (v === 'results') setResultsTab('overview')
          setView(v)
        }}
        activeDb={activeDb}
        activeKind={databases.find((d) => d.name === activeDb)?.kind ?? 'foreground'}
        projectSelect={projectSelect}
        projectActions={projectActions}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={setSidebarCollapsed}
      />

      <div className="main">
        <ModelToolbar
          busy={busy}
          view={view}
          activeDb={activeDb}
          databases={databases}
          onPickModel={openModel}
          undoState={shownUndoState}
          onUndo={undo}
          onRedo={redo}
          methods={methods}
          chosen={chosen}
          onChoose={setChosen}
          calcBusy={calcBusy}
          selectedCount={selected.length}
          fuUnit={
            selected.length === 1
              ? ((nodes.find((n) => n.id === selected[0])?.data as { unit?: string | null } | undefined)
                  ?.unit ?? null)
              : null
          }
          fuName={
            selected.length === 1
              ? ((nodes.find((n) => n.id === selected[0])?.data as { label?: string } | undefined)?.label ??
                null)
              : null
          }
          onCalculate={() => calculate()}
          onNewModel={newModel}
          onNewActivity={() => setModal({ kind: 'newActivity' })}
          onShowTagManager={() => setShowTagManager(true)}
          onShowModelInfo={() => setShowModelInfo(true)}
          onExportModel={() => setExportModel(true)}
          onShowBackground={() => setShowBackground(true)}
          onShowDistances={() => setShowDistances(true)}
          lciaTab={lciaTab}
          onLciaTab={setLciaTab}
          dark={dark}
          onToggleDark={() => setDark((v) => !v)}
          onShowSettings={() => setShowSettings({ page: 'display' })}
        />

        {showSettings ? (
          <Settings
            initialCategory={showSettings.page}
            focus={showSettings.focus}
            onClose={() => setShowSettings(null)}
          />
        ) : null}
        {showDistances ? (
          <DistancesSheet
            onClose={() => setShowDistances(false)}
            onOpenSettings={() => {
              setShowDistances(false)
              setShowSettings({ page: 'transport-keys' })
            }}
          />
        ) : null}
        {showTagManager ? (
          <TagManager
            groups={usedFirst(tagGroups, activeDb)}
            onGroupByTags={groupByTagGroup}
            onClose={() => setShowTagManager(false)}
            onCreateGroup={createTagGroup}
            onDeleteGroup={deleteTagGroup}
            onAddValue={addTagValue}
            onRemoveValue={removeTagValue}
            onMergeValue={mergeTagValue}
            onMergeGroup={mergeTagGroup}
            confirm={setConfirm}
          />
        ) : null}
        {showModelInfo && activeDb ? (
          <ModelInfo
            database={activeDb}
            onRenamed={(next) => renamedModel(activeDb, next)}
            onClose={() => {
              setShowModelInfo(false)
              void reloadAudit()
            }}
          />
        ) : null}
        {exportModel && activeDb ? (
          <ExportBundleSheet database={activeDb} onClose={() => setExportModel(false)} />
        ) : null}
        {confirm ? <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} /> : null}

        {error ? (
          <div className="wb-error" onClick={() => setError(null)}>
            {error}
          </div>
        ) : null}
        {busy ? (
          <div className="wb-busy" role="status" aria-live="polite">
            <span className="spinner" /> Working…
          </div>
        ) : null}
        {note ? (
          <div className="wb-note" onClick={() => setNote(null)}>
            {note}
          </div>
        ) : null}
        {unseenAsks.map((a) => (
          <div key={a.reqId} className="wb-ask" role="status" aria-live="polite">
            <span>
              {a.kind === 'approval'
                ? `The assistant${a.database ? ` in “${a.database}”` : ''} wants to do something that cannot be undone and is waiting for your go-ahead.`
                : `The assistant${a.database ? ` in “${a.database}”` : ''} has a question for you and is waiting for the answer.`}
            </span>
            <button className="btn sm" onClick={() => goToChat(a.database, a.chatId)}>
              Go to chat
            </button>
          </div>
        ))}
        <ChatElsewhereBanner onOpen={(n) => goToChat(n.database, n.chatId)} />
        {xaSessions.length || mcpAsks.length ? (
          <div className="wb-xa" role="status" aria-live="polite">
            <span>
              {mcpAsks.length
                ? `${mcpAsks[0].clientName || 'An external agent'} is waiting for your answer${mcpAsks.length > 1 ? ` (${mcpAsks.length} open)` : ''}.`
                : `${describeExternalClients(xaSessions)} ${xaSessions.length === 1 ? 'is' : 'are'} connected as external agent${xaSessions.length === 1 ? '' : 's'}.`}
            </span>
            <button className="btn sm" onClick={() => setXaOpen(true)}>
              {mcpAsks.length ? 'Answer' : 'Show'}
            </button>
          </div>
        ) : null}
        {xaOpen ? (
          <ExternalAgentsPanel
            sessions={xaSessions}
            asks={mcpAsks}
            running={external?.running === true}
            onClose={() => setXaOpen(false)}
          />
        ) : null}

        {/* The calc result / Monte-Carlo bars belong to the canvas — only show them on the Model view. */}
        {view === 'model' && result ? (
          <div className="result-bar">
            <b>
              {result.total} {result.unit}
            </b>
            {' · '}
            {result.method} · FU: {result.fu}
            <span className="rb-meta">
              {result.nodes} nodes · {result.seconds.toFixed(1)} s
            </span>
            <span className="rb-clear" onClick={clearResult}>
              clear
            </span>
          </div>
        ) : null}

        {view === 'model' && mc ? (
          <div className="result-bar">
            <b>
              {mc.mean.toPrecision(4)} ± {mc.std.toPrecision(2)} {mc.unit}
            </b>
            {' · P5–P95 '}
            {mc.p5.toPrecision(3)}–{mc.p95.toPrecision(3)} · {mc.iterations} runs (Monte Carlo)
            <span className="rb-clear" onClick={() => setMc(null)}>
              clear
            </span>
          </div>
        ) : null}

        {view === 'model' ? (
          <div className="work">
            <SearchPanel
              databases={databases}
              searchDbs={searchDbs}
              onSearchDbs={setSearchDbs}
              onAddReference={addReference}
              onShowDetails={setDetailsFor}
              onEditDataset={setEditDataset}
              onError={setError}
              confirm={setConfirm}
              buildStatus={idxStatus}
            />

            {/* The provider, not just <ReactFlow>, so the minimap can read the viewport from OUTSIDE
                  the canvas element: it lives in the chat dock at the bottom right (see CanvasChat's
                  `aboveBar`), and the store is the only thing it needs from out here. Scoped to the
                  canvas column and mounted with the Model view, exactly as the canvas always was. */}
            <ReactFlowProvider>
              <div
                className="stage"
                onClick={() => {
                  setCtxMenu(null)
                  setPaneMenu(null)
                  setGroupMenu(null)
                  setGroupPicker(null)
                  setHlMenu(false)
                }}
              >
                <ReactFlow
                  // The library is MIT, and hiding its badge is a documented option — xyflow *asks* for
                  // a Pro subscription in return rather than requiring one. Removed because the canvas is
                  // the product's own surface and a third-party mark sits oddly on a client's screen; the
                  // library stays credited where credit belongs, in the licences we ship and in the
                  // handbook's technology section.
                  proOptions={{ hideAttribution: true }}
                  nodes={nodes}
                  edges={shownEdges}
                  onNodesChange={onNodesChange}
                  onNodeMouseEnter={(_, node) => setHovered(node.id)}
                  onNodeMouseLeave={() => setHovered(null)}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onEdgeClick={onEdgeClick}
                  onInit={(inst) => (rfRef.current = inst)}
                  onDrop={onCanvasDrop}
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                  }}
                  onPaneClick={() => selectGroup(null)}
                  onPaneContextMenu={(e) => {
                    e.preventDefault()
                    const flow = rfRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY })
                    if (flow) {
                      setCtxMenu(null)
                      setPaneMenu({ x: e.clientX, y: e.clientY, flow })
                    }
                  }}
                  onNodeContextMenu={(e, node) => {
                    e.preventDefault()
                    setPaneMenu(null)
                    const sel = selectedRef.current
                    setCtxMenu({
                      x: e.clientX,
                      y: e.clientY,
                      id: node.id,
                      upstream: (node.data as { upstream?: number }).upstream ?? 0,
                      readOnly: (node.data as { readOnly?: boolean }).readOnly ?? false,
                      expanded: (node.data as { expanded?: boolean }).expanded ?? false,
                      // Same rule as colours and tags: a right-click inside a multi-selection acts on
                      // the selection, a right-click outside it acts on the one node.
                      selCount: sel.includes(node.id) && sel.length > 1 ? sel.length : 1,
                      groupId: groupOf(groupsRef.current, node.id)?.id ?? null,
                      addTo: (() => {
                        // Read off the node selection alone — a selected box clears it, so "a box and
                        // some processes are selected" is not a state that can exist (see `addTarget`).
                        const target =
                          sel.includes(node.id) && sel.length > 1 ? addTarget(groupsRef.current, sel) : null
                        if (!target) return null
                        return {
                          id: target.id,
                          label: groupLabel(target),
                          count: sel.filter((id) => !target.members.includes(id)).length
                        }
                      })()
                    })
                  }}
                  onNodeDragStart={() => history.begin()}
                  onNodeDragStop={(_, node, dragged) => {
                    posRef.current[node.id] = node.position
                    // One step of the canvas's undo history for the whole drag, if it moved anything.
                    history.end(dragged.length > 1 ? 'Move processes' : 'Move process', node)
                  }}
                  // The frame around a rubber-band selection drags all of it: the same one step.
                  onSelectionDragStart={() => history.begin()}
                  onSelectionDragStop={(_, moved) => history.end('Move processes', moved[0])}
                  onSelectionChange={({ nodes: sel }) => {
                    const ids = sel.map((n) => n.id)
                    lastSelRef.current = ids
                    setSelected(ids)
                    // A rubber band across a group selects the PROCESSES it touched, never the box:
                    // boxes are not React Flow nodes, and the box has its own affordance (the strip).
                    if (ids.length) setSelGroup(null)
                  }}
                  onSelectionEnd={() => {
                    if (!brush) return
                    // Read the current selection straight from the instance (reliable regardless of
                    // whether onSelectionChange has flushed yet), then paint and clear it.
                    const inst = rfRef.current
                    const ids = inst?.getNodes
                      ? inst
                          .getNodes()
                          .filter((n) => n.selected)
                          .map((n) => n.id)
                      : lastSelRef.current
                    paintNodes(ids, brush)
                    setNodes((ns) => ns.map((n) => (n.selected ? { ...n, selected: false } : n)))
                    setSelected([])
                    lastSelRef.current = []
                  }}
                  selectionOnDrag={!hand}
                  /* left-drag draws the selection box; the middle button pans — the right one is the
                     context menu and nothing else (see PAN_BUTTONS). The hand tool hands the left
                     button to panning, on process cards too (hence nodesDraggable). */
                  panOnDrag={hand ? HAND_PAN_BUTTONS : PAN_BUTTONS}
                  nodesDraggable={!hand}
                  /* Shift is reserved for additive click (multiSelectionKeyCode) — the box already works
                 via selectionOnDrag, so binding Shift to selection too would make Shift+click start a
                 box instead of adding the clicked node. */
                  selectionKeyCode={null}
                  multiSelectionKeyCode={[
                    'Shift',
                    'Control',
                    'Meta'
                  ]} /* Shift/Ctrl-click adds to the selection */
                  selectionMode={brush ? SelectionMode.Partial : SelectionMode.Full}
                  nodeTypes={NODE_TYPES}
                  edgeTypes={EDGE_TYPES}
                  deleteKeyCode={null}
                  minZoom={0.28}
                  fitView
                  className={brush ? 'brush-active' : hand ? 'hand-active' : undefined}
                >
                  <Panel position="top-right" className="canvas-tools">
                    {/* Leftmost on purpose: it belongs to the selection, not to the canvas. */}
                    <GroupTools
                      selectedCount={selected.length}
                      groupSelected={!!selGroup}
                      addTo={(() => {
                        const target = addTarget(groups, selected)
                        if (!target) return null
                        return {
                          label: groupLabel(target),
                          count: selected.filter((id) => !target.members.includes(id)).length
                        }
                      })()}
                      onGroup={() => groupSelection()}
                      onAddTo={() => {
                        const target = addTarget(groupsRef.current, selectedRef.current)
                        if (target) addSelectionToGroup(target.id)
                      }}
                      onUngroup={() => selGroup && ungroup(selGroup)}
                    />
                    <button
                      className={`btn sm hand-btn${hand ? ' on' : ''}`}
                      onClick={() => {
                        setHand((v) => !v)
                        setBrush(null)
                        setBrushPalette(false)
                      }}
                      title={
                        hand
                          ? 'Back to the pointer: drag selects again (Esc)'
                          : 'Pan the canvas with a left-drag (or hold Space, or use the middle button)'
                      }
                      aria-pressed={hand}
                    >
                      {hand ? <PointerIcon /> : <PanIcon />}
                    </button>
                    <button
                      className="btn sm"
                      onClick={() => autoLayout()}
                      title="Arrange with automatic layout"
                    >
                      Auto-layout
                    </button>
                    <div className="hl-tool">
                      <button
                        className={`btn sm${hlTag ? ' on' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setHlMenu((v) => !v)
                        }}
                        title="Highlight all processes carrying a tag"
                      >
                        <HighlightIcon /> Tag
                      </button>
                      {hlMenu ? (
                        <div className="hl-menu" onClick={(e) => e.stopPropagation()}>
                          {/* First, not after the list: with a few groups open it sat below the fold,
                              and it is the one entry somebody reopening the menu is most likely after. */}
                          {hlTag ? (
                            <button
                              className="hl-clear"
                              onClick={() => {
                                setHlTag(null)
                                setHlMenu(false)
                              }}
                            >
                              ✕ Clear highlight
                            </button>
                          ) : null}
                          {hlGroups.length === 0 ? (
                            <div className="hl-empty">
                              {tagGroups.length ? 'No process on this canvas carries a tag.' : 'No tags yet.'}
                            </div>
                          ) : null}
                          {hlGroups.map((g) => (
                            <div className="hl-group" key={g.name}>
                              <div className="hl-group-name">{g.name}</div>
                              {g.values.map((v) => (
                                <button
                                  key={v}
                                  className={`hl-val${hlTag && hlTag.dimension === g.name && hlTag.value === v ? ' on' : ''}`}
                                  onClick={() => {
                                    setHlTag({ dimension: g.name, value: v })
                                    setHlMenu(false)
                                  }}
                                >
                                  <span className="hl-dot" style={{ background: g.color }} />
                                  {v}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="brush-tool">
                      <button
                        className={`btn sm brush-btn${brush ? ' on' : ''}`}
                        style={
                          brush
                            ? { background: `color-mix(in srgb, ${brush} 28%, var(--surface))` }
                            : undefined
                        }
                        onClick={() => setBrushPalette((v) => !v)}
                        title="Paint a colour over a box of processes"
                      >
                        🖌
                      </button>
                      {brushPalette ? (
                        <div className="brush-palette">
                          {NODE_COLORS.map((c) => (
                            <button
                              key={c}
                              className={`pnode-swatch${brush === c ? ' on' : ''}`}
                              style={{ background: c }}
                              title={c}
                              onClick={() => {
                                setBrush(c)
                                setBrushPalette(false)
                                setHand(false)
                              }}
                            />
                          ))}
                          <button
                            className="brush-off"
                            title="Turn the brush off"
                            onClick={() => {
                              setBrush(null)
                              setBrushPalette(false)
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <button
                      className="btn sm"
                      onClick={resetColors}
                      disabled={Object.keys(nodeColors).length === 0}
                      title="Clear all node colours"
                    >
                      Reset colors
                    </button>
                  </Panel>
                  <CanvasGroups
                    groups={groups}
                    nodes={nodes}
                    selected={selGroup}
                    editing={editGroup}
                    dark={dark}
                    onSelect={selectGroup}
                    onMove={moveGroup}
                    onMoveEnd={moveGroupEnd}
                    onContextMenu={(e, id) => {
                      setCtxMenu(null)
                      setPaneMenu(null)
                      setGroupPicker(null)
                      setGroupMenu({ x: e.clientX, y: e.clientY, id })
                    }}
                    onPickColor={(at, id) => {
                      setCtxMenu(null)
                      setPaneMenu(null)
                      setGroupMenu(null)
                      // Anchored by its RIGHT edge to the dot's right edge, so the row grows leftwards
                      // and a box sitting against the right edge of the window still shows all of it.
                      // The row is ~34 px tall; a box near the bottom of the window would otherwise open
                      // its picker off the screen.
                      setGroupPicker({
                        right: window.innerWidth - at.right,
                        top: Math.min(at.bottom + 6, window.innerHeight - 44),
                        id
                      })
                    }}
                    onEdit={setEditGroup}
                    onRename={renameGroupTo}
                  />
                  <Background />
                  <Controls />
                </ReactFlow>
                {ctxMenu ? (
                  <NodeContextMenu
                    menu={ctxMenu}
                    onExpand={expandNode}
                    onCollapse={collapse}
                    onGroup={() => groupSelection()}
                    onAddTo={addSelectionToGroup}
                    onUngroup={ungroup}
                    onLocalize={localize}
                    onDuplicate={duplicateActivity}
                    onToLibrary={toLibrary}
                    onDelete={deleteNode}
                    onClose={() => setCtxMenu(null)}
                  />
                ) : null}
                {paneMenu ? (
                  <div
                    className="node-menu"
                    style={{ left: paneMenu.x, top: paneMenu.y }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => {
                        setModal({ kind: 'newActivity', pos: paneMenu.flow })
                        setPaneMenu(null)
                      }}
                    >
                      ＋ New process here
                    </button>
                  </div>
                ) : null}
                {groupMenu
                  ? (() => {
                      // Where this box sits in the stack right now, so the two ends of it can say so
                      // instead of offering a step that does nothing (see `restack`).
                      const order = drawnGroups(groups, nodeBoxes(nodes)).map((e) => e.group.id)
                      const at = order.indexOf(groupMenu.id)
                      return (
                        <div
                          className="node-menu"
                          style={{ left: groupMenu.x, top: groupMenu.y }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            onClick={() => {
                              setEditGroup(groupMenu.id)
                              setGroupMenu(null)
                            }}
                            title="Give this group a name (or clear it to go back to “Group of N”)"
                          >
                            Rename…
                          </button>
                          <button
                            disabled={at < 0 || at === order.length - 1}
                            onClick={() => {
                              restackGroup(groupMenu.id, 1)
                              setGroupMenu(null)
                            }}
                            title="Draw this box over the ones it overlaps — never over a process or an arrow"
                          >
                            Bring forward
                          </button>
                          <button
                            disabled={at <= 0}
                            onClick={() => {
                              restackGroup(groupMenu.id, -1)
                              setGroupMenu(null)
                            }}
                            title="Draw this box under the ones it overlaps"
                          >
                            Send backward
                          </button>
                          <button
                            onClick={() => {
                              ungroup(groupMenu.id)
                              setGroupMenu(null)
                            }}
                            title="Remove this box — the processes stay"
                          >
                            Ungroup
                          </button>
                        </div>
                      )
                    })()
                  : null}
                {groupPicker ? (
                  <div
                    className="group-palette"
                    style={{ right: groupPicker.right, top: groupPicker.top }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <TintSwatches
                      dark={dark}
                      current={groups.find((g) => g.id === groupPicker.id)?.color}
                      onPick={(c) => {
                        paintGroup(groupPicker.id, c)
                        setGroupPicker(null)
                      }}
                    />
                  </div>
                ) : null}
                {tagMenu ? (
                  <TagMenu
                    pos={{ x: tagMenu.x, y: tagMenu.y }}
                    groups={usedFirst(tagGroups, activeDb)}
                    current={tagMenu.current}
                    inherited={tagMenu.inherited}
                    onSet={setNodeTag}
                    onClose={() => setTagMenu(null)}
                    onNewGroup={createTagGroup}
                    onNewValue={addTagValue}
                  />
                ) : null}
                {activeDb ? (
                  <CanvasChat
                    activeDb={activeDb}
                    backgroundDbs={databases.filter((d) => d.kind === 'background').map((d) => d.name)}
                    secondaryBackgroundDbs={secondaryBackgrounds(databases)}
                    libraryDbs={databases.filter((d) => d.kind === 'library').map((d) => d.name)}
                    ui={chatUi}
                    aboveBar={
                      showMinimap(nodes.length) ? <CanvasMinimap onDropDataset={onMinimapDrop} /> : null
                    }
                    onDatasetDrop={onCanvasDrop}
                    onOpenSettings={(page, focus) => setShowSettings({ page, focus })}
                    focusChat={focusChat}
                    onGoToChat={goToChat}
                    onAskShown={setAskShown}
                  />
                ) : null}
              </div>
            </ReactFlowProvider>

            <aside className="panel right">
              {selected.length === 1 ? (
                <>
                  <ActivityEditor
                    key={selected[0]}
                    database={splitId(selected[0])[0]}
                    code={splitId(selected[0])[1]}
                    kind={dbKind(splitId(selected[0])[0])}
                    refresh={modelRev}
                    onChanged={refreshSelected}
                    onShowDetails={setDetailsFor}
                  />
                  <div className="insp">
                    <div className="field">
                      <label>Tags</label>
                      <div className="tagrow">
                        {inspTags.length ? (
                          inspTags.map((t) => (
                            <span
                              className={t.inherited ? 'tag inherited' : 'tag'}
                              title={t.inherited ? 'Inherited, not set on this input' : undefined}
                              key={`${t.dimension}/${t.value}`}
                            >
                              {t.dimension}: {t.value}
                            </span>
                          ))
                        ) : (
                          <span style={{ color: 'var(--faint)', fontSize: 12 }}>none</span>
                        )}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="insp">
                  <div className="eyebrow">
                    {selected.length > 1 ? 'Selection' : selGroup ? 'Selected · group' : 'Selected · node'}
                  </div>
                  <p className="empty">
                    {selected.length > 1
                      ? `${selected.length} processes selected — colours, tags and Delete apply to all of them.`
                      : selGroup
                        ? /* The panel used to say "select a node" while a box was plainly selected, which
                             made the box look like nothing had happened (seen on the first screenshot). */
                          `A group of ${groups.find((g) => g.id === selGroup)?.members.length ?? 0} processes. Drag its top strip to move them together; Ungroup removes the box and keeps every process.`
                        : 'Select a node to edit it. Tag a process via the tag button on its box. Drag on empty canvas to select several.'}
                  </p>
                </div>
              )}
              <AuditLog entries={audit} />
            </aside>
          </div>
        ) : view === 'overview' ? (
          <Overview
            databases={databases}
            methodsCount={methods.length}
            project={project}
            onOpenModel={(name) => {
              openModel(name)
              setView('model')
            }}
            onImportedModel={openFreshModel}
            onImportedDatabase={() => void refreshDatabases()}
            onRenamedModel={renamedModel}
            onNewModel={newModel}
            onDuplicateModel={duplicateModel}
            onDeleteModel={deleteModel}
            onCheckUpdates={() => setShowSettings({ page: 'about' })}
          />
        ) : view === 'parameters' ? (
          <Parameters
            activeDb={activeDb}
            rev={modelRev}
            onChanged={() => {
              if (activeDb) void reloadGraph(activeDb)
              void reloadHistory()
            }}
            onJumpToProcess={jumpFromAnyPage}
          />
        ) : view === 'scenarios' ? (
          <Scenarios activeDb={activeDb} rev={modelRev} onChanged={() => void reloadHistory()} />
        ) : view === 'lcia' ? (
          <Lcia methods={methods} tab={lciaTab} />
        ) : null}
        {/* Report is outside the chain too, and for a stronger reason than the results views: a write
            run it forgets is a run the user pays for twice (see seenReport). */}
        {seenReport ? (
          <div style={view === 'report' ? { display: 'contents' } : { display: 'none' }}>
            <Report activeDb={activeDb} methods={methods} active={view === 'report'} />
          </div>
        ) : null}
        {/* The results views live OUTSIDE the view chain: once visited they stay mounted and merely
            hide, so computed results survive a hop to the model page and back. `display: contents`
            keeps the wrapper out of the layout when visible. Reset per model (see seenResults). */}
        {seenResults.has('overview') ? (
          <div
            style={
              view === 'results' && resultsTab === 'overview' ? { display: 'contents' } : { display: 'none' }
            }
          >
            <Results
              activeDb={activeDb}
              methods={methods}
              databases={databases}
              rev={modelRev}
              onTab={setResultsTab}
              searchDbs={searchDbs}
              onSearchDbs={setSearchDbs}
            />
          </div>
        ) : null}
        {seenResults.has('detail') ? (
          <div
            style={
              view === 'results' && resultsTab === 'detail' ? { display: 'contents' } : { display: 'none' }
            }
          >
            <DetailedResults
              activeDb={activeDb}
              methods={methods}
              databases={databases}
              rev={modelRev}
              onShowDetails={setDetailsFor}
              onTab={setResultsTab}
              searchDbs={searchDbs}
              onSearchDbs={setSearchDbs}
            />
          </div>
        ) : null}
      </div>

      {modalNode}

      {editDataset ? (
        <Overlay onClose={() => setEditDataset(null)} className="modal sheet library-edit">
          {/* The X at the top, next to the title, the way every other sheet in the app closes; the head
              stays put and only the editor below it scrolls, so the X is never a long scroll away. */}
          <div className="sheet-head">
            <div className="sheet-head-grow">
              <h3>Edit dataset</h3>
              <p>
                In <b>{editDataset.database}</b>. Every model drawing on this dataset uses the version you
                leave behind — that is what a shared library is for, and what to weigh before changing a
                number a finished study rests on.
              </p>
            </div>
            <button className="sheet-x" aria-label="Close" onClick={() => setEditDataset(null)}>
              ✕
            </button>
          </div>
          <div className="sheet-body">
            <ActivityEditor
              database={editDataset.database}
              code={editDataset.code}
              kind={dbKind(editDataset.database)}
              onChanged={() => setModelRev((r) => r + 1)}
              onShowDetails={setDetailsFor}
            />
          </div>
        </Overlay>
      ) : null}

      {detailsFor ? (
        <ProcessDetails
          database={detailsFor.database}
          code={detailsFor.code}
          methods={methods}
          kind={dbKind(detailsFor.database)}
          onClose={() => setDetailsFor(null)}
        />
      ) : null}

      {setupSheet}
      {showBackground ? (
        <BackgroundData
          onClose={() => setShowBackground(false)}
          onImport={(source) => {
            setShowBackground(false)
            setSetupSource(source)
            setShowSetup(true)
          }}
          onChanged={() => {
            // The database list and the method selector both follow from what was just imported
            // or removed, so neither may keep showing the state from before.
            void run(async () => {
              await refreshDatabases()
              invalidate('/api/v1/calc/methods')
            })
          }}
        />
      ) : null}
    </div>
  )
}
