/**
 * "Last models" — the start page's way back into what somebody was working on.
 *
 * Reads the opens recorded by the Workbench's `openModel` (lib/recentModels.ts) for the current
 * project, and shows only models that still exist: a deleted model simply drops out here, a renamed
 * one was moved to its new name when it was renamed. No "View all" — the sidebar beside it is the
 * full list.
 */
import { useSyncExternalStore } from 'react'
import type { DatabaseInfo } from '../../lib/api'
import { useAppSettings } from '../../lib/appSettings'
import { recentModelsFor } from '../../lib/recentModels'
import { getFolders, subscribeFolders } from '../../lib/modelFolders'
import { fmtDay, fmtInt } from '../../lib/format'
import { ModelIcon } from '../../components/icons'

/** Rows the card shows; the settings file keeps a few more, across projects. */
export const LAST_MODELS_SHOWN = 5

export default function LastModelsCard({
  project,
  databases,
  onOpenModel
}: {
  project: string
  databases: DatabaseInfo[]
  onOpenModel: (name: string) => void
}): JSX.Element {
  const { recentModels } = useAppSettings()
  const { folders, of } = useSyncExternalStore(subscribeFolders, getFolders)
  const models = new Map(databases.filter((d) => d.kind === 'foreground').map((d) => [d.name, d]))
  const rows = recentModelsFor(project, recentModels)
    .filter((r) => models.has(r.db))
    .slice(0, LAST_MODELS_SHOWN)
  const folderName = (db: string): string => folders.find((f) => f.id === of[db])?.name ?? 'Unsorted'

  return (
    <section className="ov-card" aria-label="Last models">
      <div className="ov-card-h">
        <div className="ov-box-icon">
          <ModelIcon />
        </div>
        <div className="ov-card-title">
          <h2>Last models</h2>
          <p>Pick up where you left off.</p>
        </div>
      </div>
      <div className="ov-recent">
        {rows.length === 0 ? <div className="ov-card-empty">Models you open will appear here.</div> : null}
        {rows.map((r) => {
          const m = models.get(r.db) as DatabaseInfo
          return (
            <div
              key={r.db}
              className="ov-model ov-recent-row"
              role="button"
              tabIndex={0}
              title="Open this model on the canvas"
              onClick={() => onOpenModel(r.db)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onOpenModel(r.db)
              }}
            >
              <div className="ov-recent-main">
                <div className="ov-model-name">{r.db}</div>
                <div className="ov-recent-meta">
                  {folderName(r.db)} · {fmtInt(m.node_count)} {m.node_count === 1 ? 'process' : 'processes'}
                </div>
              </div>
              <div className="ov-recent-when">Opened {fmtDay(r.openedAt)}</div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
