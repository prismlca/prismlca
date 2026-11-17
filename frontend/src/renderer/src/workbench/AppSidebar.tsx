/**
 * The app's left rail: brand, the study navigation with its sliding pill and the project card
 * (the "background read-only" chip that sat between them is gone: the padlock on each
 * background dataset already says it). Purely presentational; the pill
 * measurement lives here because only this component knows when its list mounts.
 *
 * The rail folds down to an icon strip. Folded, the page names live in the rows'
 * `title` — the platform's own hint, which is what every other icon button in this app uses — and
 * the project card is gone: a dropdown, a database name and a kind do not survive 56 px, and the
 * strip stays a strip. Below the navigation the empty panel is the way back, and a visible button at
 * its foot says so: a window narrower than 1400 px opens folded, so many people meet the strip before
 * they have ever folded it, and nobody thinks of clicking an empty panel they did not empty themselves.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  BranchIcon,
  ChartIcon,
  FlaskIcon,
  HomeIcon,
  ModelIcon,
  ReportIcon,
  SidebarIcon,
  SlidersIcon
} from '../components/icons'

export type ViewKey = 'overview' | 'model' | 'parameters' | 'scenarios' | 'lcia' | 'results' | 'report'

/** The rail, in order. Exported because the welcome tour shows the real thing on its "rail is the
 *  workflow" card — a second, hand-drawn copy would drift away from this one the first time a page
 *  is renamed or added. */
export const STUDY_NAV: { label: string; view?: ViewKey; icon: () => JSX.Element }[] = [
  { label: 'Overview', view: 'overview', icon: HomeIcon },
  { label: 'Model', view: 'model', icon: ModelIcon },
  { label: 'Parameters', view: 'parameters', icon: SlidersIcon },
  { label: 'Scenarios', view: 'scenarios', icon: BranchIcon },
  { label: 'LCIA', view: 'lcia', icon: FlaskIcon },
  { label: 'Results', view: 'results', icon: ChartIcon },
  { label: 'Report', view: 'report', icon: ReportIcon }
]

export interface AppSidebarProps {
  view: ViewKey
  /** Navigate — the caller owns any side effects (e.g. Results always lands on its first tab). */
  onNavigate: (view: ViewKey) => void
  /** null while the workspace has no model yet: only Overview and LCIA can be opened. */
  activeDb: string | null
  /** What the open database is. A library is writable like a model but is not one, and the line
   *  below the project name is the only place that says which of the two you are editing. */
  activeKind: string
  /** The project dropdown + its action buttons, shared with the setup gate. */
  projectSelect: ReactNode
  projectActions: ReactNode
  /** Folded to the icon strip? Owned by the caller, which also knows the window's width. */
  collapsed: boolean
  /** The fold follows the window's width right now rather than a click: no animation (useSidebarFold). */
  snap?: boolean
  onToggleCollapsed: (next: boolean) => void
}

export default function AppSidebar({
  view,
  onNavigate,
  activeDb,
  activeKind,
  projectSelect,
  projectActions,
  collapsed,
  snap,
  onToggleCollapsed
}: AppSidebarProps): JSX.Element {
  // The green highlight behind the nav is one element that slides between rows instead of
  // seven backgrounds blinking on and off. Measured rather than computed so it survives a
  // font or zoom change; the very first placement skips the animation so nothing glides in
  // from the top on startup.
  const navListRef = useRef<HTMLDivElement | null>(null)
  const navPillPlaced = useRef(false)
  const [navPill, setNavPill] = useState<{ top: number; height: number; animate: boolean } | null>(null)
  const placeNavPill = useCallback((glide = true) => {
    const active = navListRef.current?.querySelector<HTMLElement>('.navitem.on')
    if (!active) return
    setNavPill({
      top: active.offsetTop,
      height: active.offsetHeight,
      animate: glide && navPillPlaced.current
    })
    navPillPlaced.current = true
  }, [])
  // The sidebar only exists once the setup gate clears, which is long after the Workbench first
  // renders — so the list is measured from a callback ref (fires the moment it attaches) on top of
  // the per-page effect. Dropping back to the gate resets the flag, so the return trip is silent too.
  const navListMount = useCallback(
    (el: HTMLDivElement | null) => {
      navListRef.current = el
      if (el) placeNavPill()
      else navPillPlaced.current = false
    },
    [placeNavPill]
  )
  // Folding changes the rows' width, and with it their height the moment a label wraps or stops
  // wrapping — so the pill is re-measured on the flag as well as on the page. A fold that follows the
  // window is not animated (see `snap`), so the pill jumps with it instead of gliding after it.
  const foldSeen = useRef(collapsed)
  useLayoutEffect(() => {
    const snapped = !!snap && foldSeen.current !== collapsed
    foldSeen.current = collapsed
    placeNavPill(!snapped)
  }, [view, collapsed, snap, placeNavPill])

  return (
    <aside className={`side${collapsed ? ' side-collapsed' : ''}${snap ? ' side-snap' : ''}`}>
      <div className="brand">
        <span className="prism" />
        <span className="brand-name">
          Prism<b>LCA</b>
        </span>
        {/* Folded, this button is not rendered here: the strip has no room beside the mark, and its
            counterpart sits at the foot of the strip instead (below). */}
        {collapsed ? null : (
          <button
            type="button"
            className="side-fold"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            aria-expanded
            onClick={() => onToggleCollapsed(true)}
          >
            <SidebarIcon />
          </button>
        )}
      </div>
      <div className="eyebrow">Navigation</div>
      <div className="navlist" ref={navListMount} data-tour="rail">
        <span
          className="nav-pill"
          aria-hidden
          style={
            navPill
              ? {
                  height: navPill.height,
                  transform: `translateY(${navPill.top}px)`,
                  transition: navPill.animate ? undefined : 'none'
                }
              : { opacity: 0 }
          }
        />
        {STUDY_NAV.map((it) => {
          const open = it.view && (activeDb || it.view === 'overview' || it.view === 'lcia') ? it.view : null
          return (
            <div
              key={it.label}
              className={`navitem${open ? '' : ' disabled'}${it.view === view ? ' on' : ''}`}
              title={collapsed ? it.label : open || !it.view ? undefined : 'Create a model first'}
              onClick={() => {
                if (open) onNavigate(open)
              }}
            >
              <span className="ic">
                <it.icon />
              </span>
              <span className="navitem-label">{it.label}</span>
              {/* Where you are, said twice: the sliding green pill and a chevron at the right edge of
                the row it has arrived at. The pill alone is a colour, and a colour is the first thing
                to go unnoticed once you stop looking for it. */}
              <span className="navitem-mark" aria-hidden="true">
                ›
              </span>
            </div>
          )
        })}
      </div>
      {/* Folded, everything under the navigation becomes one button back to the full rail; the
          project card is not rendered at all, so its dropdown cannot be reached by Tab from a strip
          that has no room to show it. At the foot of that button, where the project card stood, sits
          what makes it findable: the fold button's own glyph in a box of its own, with a hint of its
          own as the fold button has. It is part of the one button rather than a second one (a button
          cannot hold another), so the strip keeps a single stop for Tab and a single name for a screen
          reader. The rest of the panel carries no hint and no wash and stays the quiet ground it looks
          like; `e-resize` is the nearest thing the platform has to "this edge moves" — a drawn
          double-chevron would be a fixed-size bitmap that a scaled-up system cursor renders wrong. */}
      {collapsed ? (
        <button
          type="button"
          className="side-expand-zone"
          aria-label="Expand sidebar"
          onClick={() => onToggleCollapsed(false)}
        >
          <span className="side-expand" title="Expand sidebar">
            <SidebarIcon />
          </span>
        </button>
      ) : (
        <div className="proj-card">
          <div
            className="eyebrow"
            style={{
              padding: '0 0 6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between'
            }}
          >
            <span>Workspace</span>
            {projectActions}
          </div>
          <div className="row">
            <span className="dot-live" />
            {projectSelect}
          </div>
          <div className="row" style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>
            {activeDb
              ? `${activeDb} · ${activeKind === 'library' ? 'library' : 'foreground'}`
              : 'No model yet'}
          </div>
        </div>
      )}
    </aside>
  )
}
