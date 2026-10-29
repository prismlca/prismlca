/**
 * The screen in front of the app while nothing is imported: a fresh workspace imports a background
 * first. Once one is there the app opens on its Overview, which offers New model itself.
 *
 * The dialogs and the confirm live with the caller and arrive as children, so the gate and the full chrome
 * render the very same instances.
 */
import type { ReactNode } from 'react'

export type BackgroundSource = 'ecoinvent' | 'bafu'

export interface SetupGateProps {
  project: string
  error: string | null
  /** Open the import wizard for one of the two background databases. */
  onImport: (source: BackgroundSource) => void
  /** Open Settings on a page. The gate hides the sidebar, and without this a first-time user could not
   *  reach About — licence, privacy notice and the update check — until an import had succeeded. */
  onOpenSettings?: (page: 'display' | 'about') => void
  /** The project dropdown + its action buttons — shared with the sidebar's project card. */
  projectPicker: ReactNode
  /** Dialogs (modals, setup overlay, confirm) rendered inside the gate. */
  children?: ReactNode
}

export default function SetupGate({
  project,
  error,
  onImport,
  onOpenSettings,
  projectPicker,
  children
}: SetupGateProps): JSX.Element {
  return (
    <div className="setup">
      <div className="card setup-gate">
        <h3>Bring your background data</h3>
        <p className="hint">
          PrismLCA ships without LCI data. Import the database you have into workspace{' '}
          <b>{project || 'default'}</b>; the other one can follow later under Background.
        </p>
        {/* The welcome tour rings this row on its "bring your own data" card. It is the only anchor
            that exists during a genuine first run — everything else is still behind this gate. The
            toolbar's Background button carries the same name, and the two never coexist. */}
        <div className="gate-choices" data-tour="background">
          <div className="gate-choice rec">
            <div className="gate-choice-h">
              <b>ecoinvent</b>
              <span className="gate-chip rec">Recommended</span>
            </div>
            <p>
              Your licensed release. Its flow list and impact methods become the reference for everything
              else.
            </p>
            <button
              className="btn primary"
              onClick={() => onImport('ecoinvent')}
              title="ecoSpold 2 datasets folder plus the LCIA implementation workbook of the same release"
            >
              Import ecoinvent
            </button>
          </div>
          <div className="gate-choice">
            <div className="gate-choice-h">
              <b>BAFU:20XY</b>
              <span className="gate-chip free">Free</span>
            </div>
            <p>The Swiss federal LCI database, downloaded from openLCA Nexus.</p>
            <button
              className="btn"
              onClick={() => onImport('bafu')}
              title="The 'ecoSpold files' folder of the BAFU:20XY download"
            >
              Import BAFU
            </button>
          </div>
        </div>
        <div
          className="row"
          style={{ marginTop: 14, display: 'flex', gap: 6, justifyContent: 'center', alignItems: 'center' }}
        >
          <span className="eyebrow" style={{ padding: 0 }}>
            Workspace
          </span>
          {projectPicker}
        </div>
        {error ? <p className="detail">{error}</p> : null}
        {onOpenSettings ? (
          <p className="gate-links">
            <button className="linklike" onClick={() => onOpenSettings('display')}>
              Settings
            </button>
            {' · '}
            <button className="linklike" onClick={() => onOpenSettings('about')}>
              About, licence and updates
            </button>
          </p>
        ) : null}
      </div>
      {children}
    </div>
  )
}
