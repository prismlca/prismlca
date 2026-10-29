/**
 * The topbar above every view: per-view controls on the left (Overview's project buttons, LCIA's
 * tabs, the model views' model picker + actions + Calculate), the shared dark-mode toggle and the
 * settings gear on the right. Extracted from Workbench.tsx (wave 4.1) — purely presentational.
 */
import type { DatabaseInfo } from '../lib/api'
import type { MethodEntry } from '../lib/methods'
import type { UndoState } from '../lib/api'
import {
  AddIcon,
  NewActivityIcon,
  NewModelIcon,
  CalculatorIcon,
  GearIcon,
  RedoIcon,
  RouteIcon,
  SaveIcon,
  TagIcon,
  UndoIcon,
  ImportIcon,
  ModelIcon
} from '../components/icons'
import type { ViewKey } from './AppSidebar'

export interface ModelToolbarProps {
  view: ViewKey
  /** null while the workspace has no model yet — then only the Overview's toolbar is shown. */
  activeDb: string | null
  databases: DatabaseInfo[]
  onPickModel: (name: string) => void
  undoState: UndoState
  /** A write is taking longer than a second: the model picker waits for it (V332). */
  busy?: boolean
  onUndo: () => void
  onRedo: () => void
  methods: MethodEntry[]
  chosen: string
  onChoose: (value: string) => void
  calcBusy: 'calc' | 'mc' | null
  selectedCount: number
  /** Unit of the one selected process — what "1" in the FU pill is one of; undefined = none/several. */
  fuUnit?: string | null
  /** Name of the one selected process, for the pill's tooltip. */
  fuName?: string | null
  onCalculate: () => void
  onNewModel: () => void
  onNewActivity: () => void
  onShowTagManager: () => void
  onShowModelInfo: () => void
  /** Write this model to a .prism file — the same sheet the Overview's model card opens. */
  onExportModel: () => void
  onShowBackground: () => void
  /** The Distances panel: road, sea, air and rail kilometres between two places, to copy into a model. */
  onShowDistances: () => void
  lciaTab: 'compare' | 'methods'
  onLciaTab: (tab: 'compare' | 'methods') => void
  dark: boolean
  onToggleDark: () => void
  onShowSettings: () => void
}

export default function ModelToolbar(p: ModelToolbarProps): JSX.Element {
  const modelPicker = (
    <span className="crumb">
      Model ·{' '}
      <select value={p.activeDb ?? ''} disabled={p.busy} onChange={(e) => p.onPickModel(e.target.value)}>
        {/* The library is not in here. It is writable, but it is not a study: opening it as one
            offered a Report tab for a dataset store. A library dataset is edited where you find
            it — the pencil on a search result. */}
        {p.databases
          .filter((d) => d.kind !== 'library')
          .map((d) => (
            <option key={d.name} value={d.name} disabled={d.read_only}>
              {d.name}
              {d.read_only ? ' (read-only)' : ''}
            </option>
          ))}
      </select>
    </span>
  )
  const undoRedo = (
    <>
      <button
        className="btn ico"
        onClick={p.onUndo}
        disabled={!p.undoState.can_undo}
        aria-label="Undo"
        title={
          p.undoState.next_undo
            ? `Undo: ${p.undoState.next_undo} (Ctrl+Z)`
            : p.undoState.undo_elsewhere
              ? `Undo here is held: a newer change in ‘${p.undoState.undo_elsewhere.model ?? 'another model'}’ (${p.undoState.undo_elsewhere.summary}) cannot be reached past. To change this model now, edit the value directly. Undoing in that model frees this one again — but takes back that newer change.`
              : 'Nothing to undo'
        }
      >
        <UndoIcon />
      </button>
      <button
        className="btn ico"
        onClick={p.onRedo}
        disabled={!p.undoState.can_redo}
        aria-label="Redo"
        title={
          p.undoState.next_redo
            ? `Redo: ${p.undoState.next_redo} (Ctrl+Shift+Z)`
            : p.undoState.redo_elsewhere
              ? `The next change to redo belongs to ‘${p.undoState.redo_elsewhere.model ?? 'another model'}’ (${p.undoState.redo_elsewhere.summary}) — it can be redone there.`
              : 'Nothing to redo'
        }
      >
        <RedoIcon />
      </button>
    </>
  )
  return (
    <div className="topbar">
      {p.view === 'overview' ? (
        /* Overview keeps only the essentials: read-only pill, new-model button, undo/redo
           (plus the shared dark-mode toggle and settings gear on the right). The background-data
           panel lives here — this is the page about the project as a whole. */
        <>
          <span className="spacer" />
          <button
            className="btn ico-label"
            onClick={p.onShowBackground}
            data-tour="background"
            title="Background data: import ecoinvent or BAFU, add impact methods, remove a database, or start over"
          >
            <ImportIcon /> <span className="btn-word">Background</span>
          </button>
          <button
            className="btn ico-label"
            onClick={p.onNewModel}
            title="Create another model, or duplicate an existing one"
          >
            <span className="ico-wide">
              <AddIcon />
            </span>
            <span className="ico-narrow">
              <NewModelIcon />
            </span>{' '}
            <span className="btn-word">Model</span>
          </button>
          {undoRedo}
        </>
      ) : p.view === 'lcia' ? (
        <>
          <div className="rtabs" role="tablist">
            <button
              role="tab"
              className={`rtab${p.lciaTab === 'compare' ? ' on' : ''}`}
              aria-selected={p.lciaTab === 'compare'}
              onClick={() => p.onLciaTab('compare')}
            >
              Compare factors
            </button>
            <button
              role="tab"
              className={`rtab${p.lciaTab === 'methods' ? ' on' : ''}`}
              aria-selected={p.lciaTab === 'methods'}
              onClick={() => p.onLciaTab('methods')}
            >
              Manage methods
            </button>
          </div>
          <span className="spacer" />
        </>
      ) : p.view !== 'results' ? (
        <>
          {modelPicker}
          {/* The model's own window, named after the model rather than after "info": the tree icon is
              the model's mark everywhere else (sidebar, start page), and the word says which window
              opens. The new-model buttons carry the plus instead. */}
          <button
            className="btn ico-label"
            onClick={p.onShowModelInfo}
            disabled={!p.activeDb}
            aria-label="Model info"
            title="Goal & scope and study metadata of this model"
          >
            <ModelIcon /> <span className="btn-word">Model</span>
          </button>
          {/* FU pill and the LCIA-method selector belong to the model calculation only. */}
          {/* What Calculate will compute, and only once that is decided: it said "FU: 1 unit" with nothing
              selected, which named a functional unit that did not exist. The amount is
              always one reference unit — a larger quantity is modelled, not typed in here. */}
          {p.view === 'model' ? (
            p.selectedCount === 1 ? (
              <span
                className="pill"
                title={`The calculation runs for 1 ${p.fuUnit || 'unit'} of ${p.fuName || 'the selected process'} — one reference unit, always. For more, model it: a process that takes the quantity you need as an input.`}
              >
                FU: 1 {p.fuUnit || 'unit'}
              </span>
            ) : (
              <span
                className="pill fu-unset"
                title="Select exactly one process on the canvas: the calculation runs for one reference unit of it."
              >
                FU: {p.selectedCount ? 'select one process' : 'select a process'}
              </span>
            )
          ) : null}
          {p.view === 'model' ? (
            <select
              className="search-sel"
              value={p.chosen}
              onChange={(e) => p.onChoose(e.target.value)}
              disabled={!p.methods.length}
              // The full name, because the box is narrower than most of them and the ellipsis
              // eats the indicator — which is the half that distinguishes two rows of the same
              // family. It said "LCIA method", which the reader can see for themselves.
              title={p.methods.length ? (p.methods[Number(p.chosen)]?.name ?? 'LCIA method') : 'LCIA method'}
            >
              {p.methods.length ? (
                p.methods.map((m, i) => (
                  <option key={i} value={String(i)}>
                    {m.recommended ? '★ ' : ''}
                    {m.name}
                  </option>
                ))
              ) : (
                <option>no methods</option>
              )}
            </select>
          ) : null}
          <span className="spacer" />
          {/* Three buttons that act on the CANVAS, so they belong to the canvas page. This branch
              serves every view except Overview, LCIA and Results, so they also stood on Parameters,
              Scenarios and Report — where "Process" adds a box to a graph you cannot see and
              "Tags" opens a manager for a page that shows none. Undo/Redo does
              NOT move with them: the audit log lives on Parameters and Scenarios and its two halves
              have to stay in step (see logPagesRefresh.dom.test). */}
          {p.view === 'model' ? (
            <>
              <button
                className="btn ico-label"
                onClick={p.onNewModel}
                title="Create another model, or duplicate an existing one"
              >
                <span className="ico-wide">
                  <AddIcon />
                </span>
                <span className="ico-narrow">
                  <NewModelIcon />
                </span>{' '}
                <span className="btn-word">Model</span>
              </button>
              <button
                className="btn ico-label"
                onClick={p.onNewActivity}
                title="Add a new process to the model"
              >
                <span className="ico-wide">
                  <AddIcon />
                </span>
                <span className="ico-narrow">
                  <NewActivityIcon />
                </span>{' '}
                <span className="btn-word">Process</span>
              </button>
              {/* No 'Import ecoinvent' button here: the canvas toolbar is about the model in front of
                  you. Background data lives on the Overview toolbar ('Background'), which is the page
                  about the project — and the first-run import screen still exposes it so a fresh
                  project can bootstrap. */}
              <button
                className="btn ico-label"
                onClick={p.onShowTagManager}
                title="Manage tag groups and values (assign tags via the tag button on a process box)"
              >
                <TagIcon /> <span className="btn-word">Tags</span>
              </button>
            </>
          ) : null}
          {/* Distances sits where a transport leg gets its kilometres: the canvas (an exchange amount),
              Parameters (a distance parameter) and Scenarios (the other routing). Not on Report. After Tags,
              so the canvas group stays a group. */}
          {p.view === 'model' || p.view === 'parameters' || p.view === 'scenarios' ? (
            <button
              className="btn ico-label"
              onClick={p.onShowDistances}
              title="Road, sea, air and rail distance between two places — copy the kilometres into a transport leg"
            >
              <RouteIcon /> <span className="btn-word">Distances</span>
            </button>
          ) : null}
          {undoRedo}
          {/* Exporting was reachable only from the Overview's model card, which meant leaving the
              model you were working on to save it. Same sheet, same icon —
              beside Undo/Redo, where the actions on the model as a whole already sit. */}
          {p.view === 'model' ? (
            <button
              className="btn ico"
              onClick={p.onExportModel}
              disabled={!p.activeDb}
              aria-label="Export model"
              title="Export this model as a .prism file"
            >
              <SaveIcon />
            </button>
          ) : null}
          <button
            className="btn primary"
            onClick={p.onCalculate}
            disabled={!!p.calcBusy || !p.methods.length || p.selectedCount !== 1}
            title={
              !p.methods.length
                ? 'No LCIA methods installed yet (import ecoinvent)'
                : p.selectedCount !== 1
                  ? 'Select one process as the functional unit'
                  : 'Compute LCIA'
            }
          >
            {p.calcBusy === 'calc' ? (
              <>
                <span className="spinner" /> <span className="btn-word">Calculating…</span>
              </>
            ) : (
              <>
                <CalculatorIcon /> <span className="btn-word">Calculate</span>
              </>
            )}
          </button>
        </>
      ) : (
        <>
          {modelPicker}
          {/* The two kinds of result are tabs in each view's own rail now, the way the Report page
              carries its own — the topbar says which model you are on, not which panel. */}
          <span className="spacer" />
        </>
      )}
      <span className="darkmode" title="Toggle dark mode">
        <span className="dm-ic">☀</span>
        <button
          className={`tog${p.dark ? ' on' : ''}`}
          aria-label="Dark mode"
          aria-pressed={p.dark}
          onClick={p.onToggleDark}
        />
        <span className="dm-ic">☾</span>
      </span>
      <button className="icon-btn" title="Settings" data-tour="settings" onClick={p.onShowSettings}>
        <GearIcon />
      </button>
    </div>
  )
}
