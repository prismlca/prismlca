import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, type DatabaseInfo } from '../lib/api'
import { fetchQuery } from '../lib/server/useQuery'
import { studyRoute } from '../lib/server/routes'
import {
  AddIcon,
  ChevronIcon,
  CompassIcon,
  CopyIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FlaskIcon,
  FlowIcon,
  FolderIcon,
  FolderPlusIcon,
  ImportIcon,
  InfoIcon,
  ModelIcon,
  PackageIcon,
  PencilIcon,
  SaveIcon,
  SearchIcon,
  TrashIcon,
  UserIcon
} from '../components/icons'
import {
  assignFolder,
  createFolder,
  deleteFolder,
  getFolders,
  reloadFolders,
  renameFolder,
  subscribeFolders,
  type ModelFolder
} from '../lib/modelFolders'
import ModelInfo from '../components/ModelInfo'
import { ExportBundleSheet, ImportBundleSheet } from './BundleDialogs'
import ImportWizard from './ImportWizard'
import whatsNew from '../assets/whats-new.json'
import githubLogo from '../assets/logos/github.svg'
import linkedinLogo from '../assets/logos/linkedin.svg'
import { GITHUB_URL, HANDBOOK_URL, LINKEDIN_URL, openLink } from '../lib/links'
import LicenceLink from './overview/LicenceLink'
import PrivacyLink from './overview/PrivacyLink'
import UpdatesLink from './overview/UpdatesLink'
import { restartWelcomeTour } from '../welcome/restartTour'
import { errMsg } from '../lib/errors'
import ConfirmDialog, { type ConfirmSpec } from './ConfirmDialog'
import { fmtInt } from '../lib/format'
import LastModelsCard from './overview/LastModelsCard'
import NewsCard from './overview/NewsCard'

/** Entries of assets/whats-new.json — newest first. Every shipped FEATURE (not bugfixes) gets a
 * new entry there; the sidebar shows the FULL history (the list grows forever, panel scrolls) —
 * `NEWS_STEP` at a time, the next ones added as the reader scrolls near the end. */
const NEWS_STEP = 30
interface FeatureEntry {
  date: string
  title: string
  details?: string
}

/** Word-wise fuzzy match: every query token must appear in the name as a substring or,
 * failing that, as a character subsequence ("ptbtl" still finds "pet-bottle-2025"). */
function fuzzyMatch(name: string, query: string): boolean {
  const hay = name.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => {
      if (hay.includes(token)) return true
      let i = 0
      for (const ch of hay) if (ch === token[i]) i++
      return i >= token.length
    })
}

/**
 * Which folders the person has opened **in this run of the app**.
 *
 * Deliberately not persisted. Every folder starts shut, and once
 * that is the rule, remembering the last session's state is the opposite of it. Shut is the resting
 * state; opening one is a thing you do while you are looking for something — and since the list
 * became an accordion the set holds at most one id.
 *
 * Module scope rather than component state, because the Overview unmounts whenever you go to the
 * canvas and back — losing it there would mean the folder you just opened closes behind you every
 * time you look at a model.
 */
const openedThisSession = new Set<string>()

/** The accordion id of the Unsorted group. Not a folder id — no folder can ever carry it, because
 *  folder ids come from the backend — so it can share the one open-folder slot without collision. */
const UNSORTED_ID = '__unsorted'

/**
 * The Overview page: model list (left, fixed width), a splash-styled dashboard card with the
 * project's key numbers (centre), and the latest features (right).
 */
export default function Overview({
  project,
  databases,
  methodsCount,
  onOpenModel,
  onImportedModel,
  onImportedDatabase,
  onRenamedModel,
  onNewModel,
  onDuplicateModel,
  onDeleteModel,
  onCheckUpdates
}: {
  /** The active Brightway project — "Last models" is kept per project. */
  project: string
  databases: DatabaseInfo[]
  methodsCount: number
  onOpenModel: (name: string) => void
  /** A model that did not exist a moment ago: the list has to be re-fetched before opening it, or the
   *  model dropdown and this list both still describe the world from before the import. */
  onImportedModel: (name: string) => void
  /** An import landed in the library. The list has to be re-fetched (the search panel offers the
   *  library as a target), but the user stays here: the library is not a study to open. */
  onImportedDatabase: () => void
  /** Renamed in its info sheet: the list, the model dropdown and the open model all still say the old
   *  name, and every request under it would 404. */
  onRenamedModel: (from: string, to: string) => void
  onNewModel: () => void
  onDuplicateModel: (name: string) => void
  onDeleteModel: (name: string) => void
  /** Opens Settings → About, where the update check runs. */
  onCheckUpdates: () => void
}): JSX.Element {
  const models = databases.filter((d) => d.kind === 'foreground')
  const backgrounds = databases.filter((d) => d.kind === 'background')
  // The user's own library. One number on the overview, because "did my import land?" should not
  // need the model page to answer.
  const libraryCount = databases.filter((d) => d.kind === 'library').reduce((sum, d) => sum + d.node_count, 0)
  const elementaryFlows = databases
    .filter((d) => d.kind === 'biosphere')
    .reduce((sum, d) => sum + d.node_count, 0)

  const [query, setQuery] = useState('')
  const [snippets, setSnippets] = useState<Record<string, string>>({})
  const [version, setVersion] = useState<string | null>(null)
  const [infoFor, setInfoFor] = useState<string | null>(null) // Model-info dialog target
  const [exportFor, setExportFor] = useState<string | null>(null) // model whose bundle to write
  const [importingDatabase, setImportingDatabase] = useState(false)
  const [importing, setImporting] = useState(false)
  const [snippetRev, setSnippetRev] = useState(0) // bumped after edits so snippets reload

  // Goal & scope snippet per model (the study store is one small JSON per model).
  // JSON round-trip, NOT join/split on a separator — model names may contain any character.
  const modelKey = JSON.stringify(models.map((m) => m.name))
  useEffect(() => {
    let alive = true
    const names = JSON.parse(modelKey) as string[]
    void Promise.all(
      names.map(async (name) => {
        const meta = (await fetchQuery(studyRoute(name)).catch(() => ({}))) as Record<string, string>
        const text = [meta.goal, meta.scope].filter(Boolean).join(' — ')
        return [name, text] as const
      })
    ).then((pairs) => {
      if (alive) setSnippets(Object.fromEntries(pairs))
    })
    return () => {
      alive = false
    }
  }, [modelKey, snippetRev])

  useEffect(() => {
    let alive = true
    void api<{ app_version: string }>('GET', '/api/v1/system/info')
      .then((info) => {
        if (alive) setVersion(info.app_version)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const shown = query ? models.filter((m) => fuzzyMatch(m.name, query)) : models
  const news = whatsNew as FeatureEntry[]
  // The whole list was laid out on every visit to this page: 241 entries, 964 nodes, 61 ms — four
  // frames — for a panel whose top few entries are what anybody reads (measured). Thirty
  // first; a sentinel below them asks for thirty more when it scrolls into view. The observer is the
  // browser's own notification, not a poll, and it is re-made per step so a panel tall enough to show
  // the sentinel again keeps filling. Without IntersectionObserver (tests) everything is shown.
  const [newsShown, setNewsShown] = useState(() =>
    typeof IntersectionObserver === 'undefined' ? Infinity : NEWS_STEP
  )
  const newsMore = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = newsMore.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (seen) => {
        if (seen.some((e) => e.isIntersecting)) setNewsShown((n) => n + NEWS_STEP)
      },
      { root: el.parentElement, rootMargin: '300px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [newsShown])

  // --- folders -------------------------------------------------------------------------------
  const { folders, of } = useSyncExternalStore(subscribeFolders, getFolders)
  useEffect(() => {
    void reloadFolders()
  }, [modelKey])
  const [open, setOpen] = useState<string[]>(() => [...openedThisSession])
  // An accordion, like the Report rail's groups: opening a folder closes the others, and clicking
  // the open one closes it, so all-shut stays reachable. The array shape stays —
  // a search still expands every folder at once via `expanded` below.
  const toggleFolder = (id: string): void =>
    setOpen((prev) => {
      const next = prev.includes(id) ? [] : [id]
      openedThisSession.clear()
      for (const x of next) openedThisSession.add(x)
      return next
    })
  const [newFolder, setNewFolder] = useState<string | null>(null) // null = the field is not open
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  /** The text being typed. Controlled, so a re-render of the list cannot put the old name back
   *  underneath what has been typed — which an uncontrolled `defaultValue` field can. */
  const [renameText, setRenameText] = useState('')
  const [folderErr, setFolderErr] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  /** The model under the cursor, and the folder it is over — `''` is the unfiled zone. */
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)

  // --- scrolling while dragging ---------------------------------------------------------------
  /**
   * A drag cannot reach a folder that is scrolled out of sight: the list has no scrollbar under the
   * cursor while a card is in the air, and the wheel does nothing during an HTML5 drag. So the list
   * scrolls itself when the pointer nears an edge.
   *
   * It has to be a loop, not a reaction to `dragover`: that event only fires while the pointer
   * MOVES, and the whole point is to keep scrolling while it is held still at the edge. `dragover`
   * therefore only sets a speed, and an animation frame does the moving until the speed goes back
   * to zero — which happens when the pointer leaves the edge, when the card is dropped, and when
   * the drag is abandoned.
   */
  const listRef = useRef<HTMLDivElement | null>(null)
  const speedRef = useRef(0)
  const frameRef = useRef<number | null>(null)

  const stopEdgeScroll = (): void => {
    speedRef.current = 0
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
  }
  useEffect(() => stopEdgeScroll, [])

  const edgeScroll = (e: React.DragEvent): void => {
    const el = listRef.current
    if (!el || !dragging) return
    const box = el.getBoundingClientRect()
    // Deep enough to hit without aiming, shallow enough that the list is not permanently scrolling
    // while you cross it on the way to a folder near the top.
    const EDGE = 64
    // Pixels per SECOND, not per frame. Per frame ties the speed to the display: the first measured
    // version used 12 px/frame and crossed a 958-pixel list in well under a second here, because
    // this screen does not run at 60 Hz. The loop below multiplies by the real elapsed time, so it
    // behaves the same on every machine.
    const MAX = 620
    const fromTop = e.clientY - box.top
    const fromBottom = box.bottom - e.clientY
    // Squared, not linear: entering the zone nudges, pressing into it hurries. Floored at 60 px/s so
    // the far edge of the zone still creeps rather than doing nothing at all.
    const ramp = (d: number): number => Math.max(60, ((EDGE - d) / EDGE) ** 2 * MAX)
    if (fromTop < EDGE) speedRef.current = -ramp(fromTop)
    else if (fromBottom < EDGE) speedRef.current = ramp(fromBottom)
    else speedRef.current = 0

    if (!speedRef.current || frameRef.current != null) return
    let last = performance.now()
    const step = (now: number): void => {
      const node = listRef.current
      if (!node || !speedRef.current) {
        frameRef.current = null
        return
      }
      // Clamped: a frame the browser skipped (a background tab, a slow paint) must not arrive as
      // one enormous jump that scrolls past everything.
      const dt = Math.min(now - last, 50) / 1000
      last = now
      node.scrollTop += speedRef.current * dt
      frameRef.current = requestAnimationFrame(step)
    }
    frameRef.current = requestAnimationFrame(step)
  }

  const drop = (folderId: string | null): void => {
    stopEdgeScroll()
    const name = dragging
    setDragging(null)
    setOver(null)
    if (!name) return
    if ((of[name] ?? '') === (folderId ?? '')) return // already there; do not write for nothing
    void assignFolder(name, folderId).catch((e) => setFolderErr(errMsg(e)))
  }

  const dropProps = (folderId: string | null): Record<string, unknown> => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragging) return
      e.preventDefault() // without this the drop never fires — the default is "reject"
      setOver(folderId ?? '')
    },
    onDragLeave: () => setOver((cur) => (cur === (folderId ?? '') ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      drop(folderId)
    }
  })

  // Clicking away from the field discards, the same as ✕. Deliberately NOT the
  // silent blur this replaced: back then the field threw the typed name away wherever you clicked,
  // including on a button you thought would save it, and nothing said so. Now ✓ and ✕ stand beside
  // the field, and "somewhere else" means somewhere that is neither of them — `pointerdown` on the
  // way in, so the decision is made before the click can land anywhere it should not.
  useEffect(() => {
    if (!renamingFolder) return
    const away = (e: PointerEvent): void => {
      if (!(e.target as HTMLElement | null)?.closest?.('.ov-folder-renaming')) setRenamingFolder(null)
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [renamingFolder])

  const commitFolderName = (folder: ModelFolder): void => {
    const next = renameText.trim()
    if (!next || next === folder.name) return setRenamingFolder(null)
    setFolderErr(null)
    void renameFolder(folder.id, next)
      .then(() => setRenamingFolder(null))
      .catch((err) => setFolderErr(errMsg(err)))
  }

  const submitFolder = (): void => {
    const name = (newFolder || '').trim()
    if (!name) return setNewFolder(null)
    setFolderErr(null)
    void createFolder(name)
      .then(() => setNewFolder(null))
      .catch((e) => setFolderErr(errMsg(e)))
  }

  // What each group holds, in display order: the folders as they are ordered, then Unsorted, which
  // is always last and holds whatever is in no folder at all. Searching filters the models but keeps
  // the grouping — a flat result list would answer "which model" and lose "where it lives", and the
  // second is half the reason to look.
  const groups: Array<{ folder: ModelFolder | null; models: DatabaseInfo[] }> = [
    ...folders.map((f) => ({ folder: f, models: shown.filter((m) => of[m.name] === f.id) })),
    { folder: null, models: shown.filter((m) => !of[m.name]) }
  ]

  return (
    <div className="work">
      <aside className="panel">
        <div className="panel-h eyebrow">Models</div>
        <div className="ov-toolrow">
          <div className="search ov-search">
            <SearchIcon />
            <input placeholder="Find a model…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {/* One a row, then two sharing one: the order is how often each is pressed, and the
              widths say so without a word. */}
          <button
            className="btn ico-label ov-wide"
            onClick={onNewModel}
            title="Create another model, or duplicate an existing one"
          >
            <AddIcon /> Model
          </button>
          {/* Two ways of taking something in, side by side because that is the choice being made:
              a PrismLCA model of your own, or processes from other software. Neither label says
              "import" — the import glyph on both says it once, and the label is then free to say
              what arrives. */}
          <button
            className="btn ico-label"
            onClick={() => setImporting(true)}
            title="Import a model from a .prism file or from the spreadsheet PrismLCA exports"
          >
            <ImportIcon /> Model
          </button>
          <button
            className="btn ico-label"
            onClick={() => setImportingDatabase(true)}
            title="Import processes from SimaPro, openLCA, GaBi, EcoSpold or ILCD into your library"
          >
            <ImportIcon /> Processes
          </button>
        </div>
        <div
          className="panel-b"
          ref={listRef}
          onDragOver={edgeScroll}
          onDragLeave={stopEdgeScroll}
          onDrop={stopEdgeScroll}
        >
          {models.length === 0 ? <div className="ov-empty">No models yet.</div> : null}
          {models.length > 0 && shown.length === 0 ? (
            <div className="ov-empty">No model matches “{query}”.</div>
          ) : null}
          {groups.map(({ folder, models: inFolder }) => {
            // An empty group still shows — it is a place to drop something, and hiding it would
            // make the folder you just made look like it failed. That now goes for Unsorted too:
            // when every model was filed it used to disappear, taking with it the only target you
            // could drag a model onto to get it OUT of its folder again.
            if (query && inFolder.length === 0) return null // a search shows what it found
            const id = folder?.id ?? UNSORTED_ID
            const expanded = open.includes(id) || !!query
            return (
              <div
                className={`ov-folder${over === id ? ' over' : ''}${folder ? '' : ' loose'}`}
                key={id}
                {...dropProps(folder?.id ?? null)}
              >
                {folder ? (
                  // The whole band toggles, the same way a parameter group's does — a header with
                  // buttons inside it cannot itself be a button, so the chevron stays the real
                  // control for the keyboard and everything else stops the click travelling.
                  <div className="ov-folder-h" onClick={() => toggleFolder(folder.id)}>
                    <button
                      className={`ov-folder-toggle${expanded ? ' open' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleFolder(folder.id)
                      }}
                      title={expanded ? 'Collapse' : 'Expand'}
                      aria-expanded={expanded}
                    >
                      <ChevronIcon />
                    </button>
                    <FolderIcon />
                    {renamingFolder === folder.id ? (
                      <span className="ov-folder-renaming">
                        <input
                          className="ov-folder-rename"
                          autoFocus
                          value={renameText}
                          onChange={(e) => {
                            setRenameText(e.target.value)
                            setFolderErr(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              commitFolderName(folder)
                            }
                            if (e.key === 'Escape') setRenamingFolder(null)
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                        {/* Discard first, confirm second — the same order and the same two buttons as
                            renaming a model in its info sheet. Deliberately NO commit or discard on
                            blur: the field used to throw the typed name away the moment you clicked
                            anywhere else, and the old name snapped back with nothing said. */}
                        <button
                          className="ov-model-act"
                          title="Discard (Esc)"
                          aria-label="Discard the new name"
                          onClick={(e) => {
                            e.stopPropagation()
                            setRenamingFolder(null)
                          }}
                        >
                          ✕
                        </button>
                        <button
                          className="ov-model-act ok"
                          title="Rename (Enter)"
                          aria-label="Rename the folder"
                          onClick={(e) => {
                            e.stopPropagation()
                            commitFolderName(folder)
                          }}
                        >
                          ✓
                        </button>
                      </span>
                    ) : (
                      <span
                        className="ov-folder-name"
                        onDoubleClick={(e) => {
                          e.stopPropagation()
                          setRenameText(folder.name)
                          setRenamingFolder(folder.id)
                        }}
                      >
                        {folder.name}
                      </span>
                    )}
                    <span className="ov-folder-count">{inFolder.length}</span>
                    <span className="ov-folder-acts">
                      <button
                        className="ov-model-act"
                        title="Rename this folder"
                        aria-label="Rename folder"
                        onClick={(e) => {
                          e.stopPropagation()
                          setRenameText(folder.name)
                          setRenamingFolder(folder.id)
                        }}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        className="ov-model-act danger"
                        title="Delete this folder — the models in it are kept"
                        aria-label="Delete folder"
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirm({
                            title: 'Delete this folder?',
                            message:
                              inFolder.length === 0
                                ? `Delete the empty folder “${folder.name}”?`
                                : `Delete the folder “${folder.name}”?\n\nThe ${inFolder.length === 1 ? 'model' : `${inFolder.length} models`} in it ${inFolder.length === 1 ? 'is' : 'are'} kept — back to Unsorted.`,
                            confirmLabel: 'Delete folder',
                            danger: true,
                            onConfirm: () =>
                              void deleteFolder(folder.id).catch((err) => setFolderErr(errMsg(err)))
                          })
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </span>
                  </div>
                ) : (
                  // The same band as a folder's, and it behaves like one — it opens and shuts with
                  // the others. What it does not get is the rename and delete pair: it is where a
                  // model is when it is nowhere, not a thing you can name or remove.
                  <div className="ov-folder-h loose" onClick={() => toggleFolder(UNSORTED_ID)}>
                    <button
                      className={`ov-folder-toggle${expanded ? ' open' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleFolder(UNSORTED_ID)
                      }}
                      title={expanded ? 'Collapse' : 'Expand'}
                      aria-expanded={expanded}
                    >
                      <ChevronIcon />
                    </button>
                    <FolderIcon />
                    <span className="ov-folder-name">Unsorted</span>
                    <span className="ov-folder-count">{inFolder.length}</span>
                    {/* The rename/delete pair a folder carries, kept as empty space so this count
                        lines up with theirs instead of sitting 54px further right. */}
                    <span className="ov-folder-acts placeholder" aria-hidden="true">
                      <button className="ov-model-act" tabIndex={-1}>
                        <PencilIcon />
                      </button>
                      <button className="ov-model-act" tabIndex={-1}>
                        <TrashIcon />
                      </button>
                    </span>
                  </div>
                )}
                {expanded ? (
                  <div className="ov-folder-b">
                    {inFolder.length === 0 ? <div className="ov-folder-empty">Drag a model here.</div> : null}
                    {inFolder.map((m) => (
                      <div
                        key={m.name}
                        className={`ov-model${dragging === m.name ? ' dragging' : ''}`}
                        role="button"
                        tabIndex={0}
                        draggable
                        onDragStart={(e) => {
                          setDragging(m.name)
                          e.dataTransfer.effectAllowed = 'move'
                          // Some platforms refuse a drag with no payload at all.
                          e.dataTransfer.setData('text/plain', m.name)
                        }}
                        onDragEnd={() => {
                          setDragging(null)
                          setOver(null)
                        }}
                        title="Open this model on the canvas"
                        onClick={() => onOpenModel(m.name)}
                        onKeyDown={(e) => e.key === 'Enter' && onOpenModel(m.name)}
                      >
                        <div className="ov-model-top">
                          <div className="ov-model-name">{m.name}</div>
                          <span className="ov-model-actions">
                            <button
                              className="ov-model-act"
                              title="Goal & scope and study metadata of this model"
                              aria-label="Model info"
                              onClick={(e) => {
                                e.stopPropagation()
                                setInfoFor(m.name)
                              }}
                            >
                              <InfoIcon />
                            </button>
                            <button
                              className="ov-model-act"
                              title="Duplicate this model under a new name"
                              aria-label="Duplicate model"
                              onClick={(e) => {
                                e.stopPropagation()
                                onDuplicateModel(m.name)
                              }}
                            >
                              <CopyIcon />
                            </button>
                            <button
                              className="ov-model-act"
                              title="Export this model as a .prism file"
                              aria-label="Export model"
                              onClick={(e) => {
                                e.stopPropagation()
                                setExportFor(m.name)
                              }}
                            >
                              <SaveIcon />
                            </button>
                            <button
                              className="ov-model-act danger"
                              title="Delete this model"
                              aria-label="Delete model"
                              onClick={(e) => {
                                e.stopPropagation()
                                onDeleteModel(m.name)
                              }}
                            >
                              <TrashIcon />
                            </button>
                          </span>
                        </div>
                        {snippets[m.name] ? <div className="ov-model-snippet">{snippets[m.name]}</div> : null}
                        <div className="ov-model-meta">
                          {fmtInt(m.node_count)} foreground {m.node_count === 1 ? 'process' : 'processes'}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
          {/* Under the folders, not above them: a new folder appears at the end of this list, and
              the button that makes one belongs where the thing it makes will be. */}
          {newFolder !== null ? (
            <div className="ov-folder-new">
              <input
                autoFocus
                placeholder="Folder name…"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitFolder()
                  if (e.key === 'Escape') setNewFolder(null)
                }}
              />
              <button className="btn sm primary" onClick={submitFolder} disabled={!newFolder.trim()}>
                Create
              </button>
              <button className="btn sm" onClick={() => setNewFolder(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <button
              className="btn ico-label ov-newfolder"
              onClick={() => setNewFolder('')}
              title="New folder — group the models by what they are for"
            >
              <FolderPlusIcon /> Folder
            </button>
          )}
          {/* Beneath the field it belongs to. It used to sit at the top of the list, which was
              where the field was — a message about a name you typed has to be where you typed it. */}
          {folderErr ? <div className="ov-folder-err">{folderErr}</div> : null}
        </div>
      </aside>

      <div className="stage ov-stage">
        <div className="ov-home">
          {/* The greeting, the two doors out of the app, and the way back into the tour. No card
              around it: the stage carries the prism facets itself (assets/overview-bg.webp), and a
              bordered panel on top of a picture only fights it (design decision). */}
          <header className="ov-hero">
            <div className="ov-prism" />
            <h1>
              Prism<b>LCA</b>
            </h1>
            <div className="ov-tagline">
              Life Cycle Assessment, <b>Simplified.</b>
            </div>
            <p className="ov-lede">
              Build, explore and communicate credible life cycle assessments, with an assistant that knows
              your model.
            </p>
            <div className="ov-cta">
              {/* Both of these leave PrismLCA, and the same arrow-out-of-a-pane says so on both. The
                  handbook is the green one because it is the answer to nearly every first question;
                  GitHub is where the code and the issue tracker are. */}
              <button
                className="btn primary ico-label"
                onClick={() => openLink(HANDBOOK_URL)}
                title="Open the handbook in your browser"
              >
                <ExternalLinkIcon /> Handbook
              </button>
              <button
                className="btn ico-label"
                onClick={() => openLink(GITHUB_URL)}
                title="Open the source repository on GitHub"
              >
                <img className="ov-cta-logo" src={githubLogo} alt="" /> GitHub
              </button>
              {/* The tour is shown once and never again — this is the only way back to it. Clearing
                  the flag is all it takes; the tour's own gate does the rest. It used to be a link in
                  the footer, where nobody looking for it would think to look. */}
              <button
                className="btn ico-label ov-cta-quiet"
                onClick={restartWelcomeTour}
                title="Run the first-start tour again"
              >
                <CompassIcon /> Take the tour again
              </button>
            </div>
          </header>

          {/* What this installation holds, in one line. The background databases keep their names
              underneath the number: "2" alone answers a question nobody asks. */}
          <div className="ov-stats">
            <div className="ov-stat">
              <ModelIcon />
              <div className="ov-stat-num">{fmtInt(models.length)}</div>
              <div className="ov-stat-label">Models</div>
            </div>
            {/* Which ones, and how big, on hover: the column is a hundred-odd pixels wide and a
                database name is longer than that, so a visible list only wrapped into rubble. */}
            <div
              className="ov-stat"
              title={backgrounds.map((d) => `${d.name} · ${fmtInt(d.node_count)} datasets`).join('\n')}
            >
              <DatabaseIcon />
              <div className="ov-stat-num">{fmtInt(backgrounds.length)}</div>
              <div className="ov-stat-label">Background databases</div>
            </div>
            <div className="ov-stat">
              <FolderIcon />
              <div className="ov-stat-num">{fmtInt(libraryCount)}</div>
              <div className="ov-stat-label">My processes</div>
            </div>
            <div className="ov-stat">
              <FlowIcon />
              <div className="ov-stat-num">{fmtInt(elementaryFlows)}</div>
              <div className="ov-stat-label">Elementary flows</div>
            </div>
            <div className="ov-stat">
              <FlaskIcon />
              <div className="ov-stat-num">{fmtInt(methodsCount)}</div>
              <div className="ov-stat-label">LCIA indicators</div>
            </div>
          </div>

          {/* Under the numbers: the way back into recent work, and what is new around the project. */}
          <div className="ov-cards">
            <LastModelsCard project={project} databases={databases} onOpenModel={onOpenModel} />
            <NewsCard />
          </div>

          {/* All at the right edge, a middle dot apart. */}
          <div className="ov-meta">
            <span>
              <PackageIcon /> Version {version ?? '—'}
            </span>
            <span className="ov-meta-sep" aria-hidden="true" />
            <UpdatesLink onOpen={onCheckUpdates} />
            <span className="ov-meta-sep" aria-hidden="true" />
            <LicenceLink />
            <span className="ov-meta-sep" aria-hidden="true" />
            <PrivacyLink />
            <span className="ov-meta-sep" aria-hidden="true" />
            <span className="ov-meta-dev">
              <UserIcon /> Lead developer:
              <button
                className="ov-meta-link"
                onClick={() => openLink(LINKEDIN_URL)}
                title="Jonas Harth on LinkedIn"
              >
                Jonas Harth
                <img src={linkedinLogo} alt="" />
              </button>
            </span>
          </div>
        </div>
      </div>

      <aside className="panel right">
        <div className="panel-h eyebrow">What&rsquo;s new</div>
        <div className="panel-b ov-news">
          {news.slice(0, newsShown).map((n) => (
            <div key={`${n.date}:${n.title}`} className="ov-news-item">
              <div className="ov-news-date">{n.date}</div>
              <div className="ov-news-title">{n.title}</div>
              {n.details ? <div className="ov-news-details">{n.details}</div> : null}
            </div>
          ))}
          {newsShown < news.length ? (
            <div ref={newsMore} className="ov-news-more" aria-hidden="true" />
          ) : null}
        </div>
      </aside>

      {infoFor ? (
        <ModelInfo
          database={infoFor}
          onRenamed={(next) => {
            onRenamedModel(infoFor, next)
            setInfoFor(next) // the sheet stays open on the same model, under its new name
          }}
          onClose={() => {
            setInfoFor(null)
            setSnippetRev((r) => r + 1) // an edited goal/scope should show in the list right away
          }}
        />
      ) : null}
      {confirm ? <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} /> : null}
      {exportFor ? <ExportBundleSheet database={exportFor} onClose={() => setExportFor(null)} /> : null}
      {importingDatabase ? (
        <ImportWizard onClose={() => setImportingDatabase(false)} onDone={() => onImportedDatabase()} />
      ) : null}
      {importing ? (
        <ImportBundleSheet
          onClose={() => setImporting(false)}
          onImported={(name, renamed) => {
            setImporting(false)
            // A rename has to be said out loud, not just done: without this the import of a model you
            // already have looks like it did nothing, or worse, like it overwrote the original. The
            // model opens on OK — opening first could unmount this view and swallow the notice.
            if (renamed) {
              // Two truths, two sentences: a name PrismLCA chose over the one asked for, and a stand-in the
              // user accepted because the bundle's own name was taken. A name the user typed needs no
              // notice at all (V340).
              setConfirm({
                title:
                  renamed === 'deviated' ? 'Imported under a new name' : 'Imported beside the existing model',
                message:
                  renamed === 'deviated'
                    ? `Imported as "${name}" — the name you asked for was not available.`
                    : `Imported as "${name}".\n\nA model of the bundle's original name already existed and was left ` +
                      `untouched — the two are separate models.`,
                notice: true,
                onConfirm: () => onImportedModel(name)
              })
              return
            }
            // Straight into it — through the path that refreshes the database list first. Calling
            // `onOpenModel` here left the list and the dropdown describing the world from before the
            // import, so the model only showed up after restarting the app.
            onImportedModel(name)
          }}
        />
      ) : null}
    </div>
  )
}
