import type { DatabaseInfo } from '../lib/api'
import { fmtInt } from '../lib/format'
import { useIndexEta } from '../lib/indexEta'
import type { IndexBuildStatus } from '../workbench/useSearchIndexStatus'

/** The running search-index build, under the search panel's database list: its progress while it
 *  belongs to this workspace, and one line while a build of the workspace just left winds down.
 *
 *  That second case needs its own words because the name alone cannot tell the two apart: two
 *  workspaces with the same ecoinvent release hold databases of the same name, and the other
 *  workspace's progress bar read as this one's index being built. */
export default function IndexBuildProgress({
  status,
  databases
}: {
  status: IndexBuildStatus | null
  databases: DatabaseInfo[]
}): JSX.Element | null {
  const eta = useIndexEta(status)
  if (status?.state !== 'running') return null
  if (status.other_workspace) {
    return (
      <div className="idx-progress">
        <div className="idx-progress-num">
          Pausing the search index of workspace <b>{status.workspace}</b>: it stops after the current step and
          continues when you open that workspace again.
        </div>
      </div>
    )
  }
  // The biosphere holds elementary flows, not datasets; its build follows the background's.
  const unit = databases.find((d) => d.name === status.database)?.kind === 'biosphere' ? 'flows' : 'datasets'
  return (
    <div className="idx-progress" title={status.detail}>
      <div className="idx-progress-bar">
        <span
          style={{
            width: status.total > 0 ? `${Math.round((status.count / status.total) * 100)}%` : '100%'
          }}
        />
      </div>
      <div className="idx-progress-num idx-line">
        {status.total > 0 ? (
          <>
            <span>
              Indexing <b>{status.database}</b> · {fmtInt(status.count)} / {fmtInt(status.total)} {unit}
            </span>
            {eta ? <span>{eta}</span> : null}
          </>
        ) : (
          'Indexing… preparing'
        )}
      </div>
      {/* Said while it runs, because it runs long the first time: what it is for, that it is kept,
          and why the app may answer slower meanwhile (the embedding takes every core). */}
      <div className="idx-note">
        Preparing semantic search — the index is saved and reused on later starts. PrismLCA may respond more
        slowly until it finishes.
      </div>
    </div>
  )
}
