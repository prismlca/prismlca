import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { errMsg } from '../lib/errors'
import ImportProgress, { type ImportStatus } from '../components/ImportProgress'
import { fmtInt } from '../lib/format'
import { SetupHelp, SetupStep } from './SetupParts'

/** The registry entry the backend keeps per imported background (subset the result panel shows). */
interface ImportedEntry {
  name: string
  activities: number
  provider: string | null
  label: string
  version: string
  citation?: string
  flow_mapping?: {
    exchanges_resolved?: number
    exchanges_new_flow?: number
    new_flows?: number
    with_ecoinvent?: boolean
    rungs?: Record<string, number>
    new_flows_top?: { name: string; compartment: string; unit: string; exchanges: number }[]
  }
}

export type BackgroundSource = 'ecoinvent' | 'bafu'

/**
 * Background import wizard for one of the two supported databases: ecoinvent (local ecoSpold-2
 * folder plus the release's LCIA workbook) or BAFU:20XY (the download's ecoSpold-1 folder). Kicks off
 * POST /setup/background and polls /setup/status for live progress. No background data is ever
 * shipped — each user imports from their own copy (ADR: ecoinvent distribution; BAFU is free).
 */
/** Brightway's own throwaway workspace — where a fresh installation stands before anything is imported. */
const BRIGHTWAY_DEFAULT = 'default'
/** The name the first import proposes for the user's workspace; editable in the wizard. */
export const PROPOSED_WORKSPACE = 'Main'

export default function Setup({
  onDone,
  onAlsoImport,
  onClose,
  source = 'ecoinvent',
  project,
  workspaceEmpty,
  onCreateWorkspace
}: {
  /** "Start" after a finished import: on to the app. */
  onDone: () => void
  /** Offered after a finished import when the other supported database is not there yet. */
  onAlsoImport?: (source: BackgroundSource) => void
  /** The X in the title row; absent = no X (the gate keeps its own way out). */
  onClose?: () => void
  source?: BackgroundSource
  /** The active workspace. While it is Brightway's `default` AND still empty, the wizard asks for
   *  a name (proposing "Main") and creates that workspace before importing, so the data never lands
   *  in `default` and a second release can later live in a workspace beside it. A populated
   *  `default` (installations from before the proposal) is left alone: a second background must
   *  join the first, not start a workspace of its own. */
  project?: string
  workspaceEmpty?: boolean
  onCreateWorkspace?: (name: string) => Promise<void>
}): JSX.Element {
  const [dir, setDir] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState(PROPOSED_WORKSPACE)
  const askWorkspace = project === BRIGHTWAY_DEFAULT && workspaceEmpty === true && !!onCreateWorkspace
  // Set before the first await of `start`: a second click while the workspace is being created
  // would otherwise create a second one and send the import to whichever is active by then.
  const [starting, setStarting] = useState(false)
  const [lcia, setLcia] = useState<string | null>(null)
  const [status, setStatus] = useState<ImportStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  // What was imported, read from the registry once the job is done — the wizard stays open and
  // shows it; before, it closed itself on "done" and the summary was never seen.
  const [result, setResult] = useState<ImportedEntry | null>(null)
  // Whether the other provider's database is already in the workspace — then there is nothing to offer.
  const other: BackgroundSource = source === 'ecoinvent' ? 'bafu' : 'ecoinvent'
  const [otherPresent, setOtherPresent] = useState(true)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => clearTimeout(timer.current), [])

  const poll = useCallback(async () => {
    const st = await api<ImportStatus>('GET', '/api/v1/setup/status')
    setStatus(st)
    if (st.state === 'running') {
      timer.current = setTimeout(() => void poll(), 1500)
    } else if (st.state === 'done') {
      try {
        const overview = await api<{ background: ImportedEntry[] }>('GET', '/api/v1/setup/background')
        setResult(overview.background.find((b) => b.name === st.database) ?? null)
        setOtherPresent(overview.background.some((b) => b.provider === other))
      } catch {
        setResult(null)
      }
    }
  }, [other])

  const pick = useCallback(async () => {
    const chosen = await window.prism.pickDirectory()
    if (chosen) setDir(chosen)
  }, [])

  const pickLcia = useCallback(async () => {
    const chosen = await window.prism.pickFile([{ name: 'Excel workbook', extensions: ['xlsx'] }])
    if (chosen) setLcia(chosen)
  }, [])

  const start = useCallback(async () => {
    if (!dir || starting) return
    setStarting(true)
    setError(null)
    try {
      const name = workspace.trim()
      if (askWorkspace && name && name !== BRIGHTWAY_DEFAULT) await onCreateWorkspace!(name)
      await api('POST', '/api/v1/setup/background', {
        source,
        path: dir,
        lcia_xlsx: source === 'ecoinvent' ? lcia : null
      })
      void poll()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setStarting(false)
    }
  }, [dir, lcia, poll, source, workspace, askWorkspace, onCreateWorkspace, starting])

  const cancel = useCallback(async () => {
    await api('POST', '/api/v1/setup/cancel')
  }, [])

  const running = status?.state === 'running' || starting
  const done = status?.state === 'done'
  const bafu = source === 'bafu'

  return (
    <div className="modal sheet setup-sheet" onClick={(e) => e.stopPropagation()}>
      <div className="sheet-head">
        <div className="sheet-head-grow">
          <h3>{bafu ? 'Import BAFU:20XY' : 'Import ecoinvent'}</h3>
          <p>
            {bafu
              ? 'The free Swiss LCI database — imported once, kept on this computer.'
              : 'Your licensed release — imported once, kept on this computer.'}
          </p>
        </div>
        {onClose ? (
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        ) : null}
      </div>
      <div className="sheet-body">
        <ol className="setup-steps">
          {askWorkspace ? (
            <SetupStep
              label="Workspace"
              hint={!running && !done ? 'Holds this background and the models you build on it.' : null}
            >
              <input
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                disabled={running || done}
                aria-label="Workspace name"
                spellCheck={false}
              />
            </SetupStep>
          ) : null}
          <SetupStep
            label={bafu ? 'Download folder' : 'Release folder'}
            hint={
              bafu ? (
                <>
                  The{' '}
                  <mark className="setup-key">
                    <code>ecoSpold files</code> folder
                  </mark>{' '}
                  of the unzipped download.
                </>
              ) : (
                <>
                  Extract the <code>.7z</code> first, then choose{' '}
                  <mark className="setup-key">
                    the folder that holds <code>datasets</code> and <code>MasterData</code>
                  </mark>
                  .
                </>
              )
            }
          >
            <button className="btn" onClick={pick} disabled={running}>
              Choose folder…
            </button>
            <span className="setup-path">{dir ?? 'No folder selected'}</span>
          </SetupStep>
          {bafu ? null : (
            <SetupStep
              label="Impact methods"
              hint={
                <>
                  The <mark className="setup-key">LCIA Implementation workbook (.xlsx)</mark> of the same
                  release. Without it nothing can be calculated.
                </>
              }
            >
              <button className="btn" onClick={pickLcia} disabled={running}>
                Choose workbook…
              </button>
              <span className="setup-path">{lcia ?? 'No workbook selected'}</span>
            </SetupStep>
          )}
        </ol>
        {!running && !done ? <SetupHelp source={source} /> : null}

        {status ? <ImportProgress status={status} onCancel={cancel} /> : null}
        {done && result ? (
          <div className="setup-result">
            <div className="eyebrow">Imported</div>
            <p>
              <b>{result.label || result.name}</b>
              {result.label && result.label !== result.name ? (
                <span className="muted"> · {result.name}</span>
              ) : null}{' '}
              — {fmtInt(result.activities)} datasets.
              {result.citation ? <span className="muted"> Cite as: {result.citation}</span> : null}
            </p>
            {result.flow_mapping ? (
              <>
                <p>
                  Elementary flows: {fmtInt(result.flow_mapping.exchanges_resolved ?? 0)} exchanges mapped
                  onto{' '}
                  {result.flow_mapping.with_ecoinvent
                    ? "ecoinvent's flow list"
                    : 'the bundled flow list (ecoinvent 3.9)'}
                  , {fmtInt(result.flow_mapping.exchanges_new_flow ?? 0)} on{' '}
                  {fmtInt(result.flow_mapping.new_flows ?? 0)} new flows without characterisation factors.
                </p>
                {result.flow_mapping.new_flows_top?.length ? (
                  <table>
                    <thead>
                      <tr>
                        <th>New flow (no factor)</th>
                        <th>Compartment</th>
                        <th>Exchanges</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.flow_mapping.new_flows_top.slice(0, 12).map((f) => (
                        <tr key={`${f.name}|${f.compartment}|${f.unit}`}>
                          <td>{f.name}</td>
                          <td>
                            {f.compartment} · {f.unit}
                          </td>
                          <td>{fmtInt(f.exchanges)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </>
            ) : null}
            <p className="muted">
              The search index is being built in the background now — the search panel shows its progress.
            </p>
          </div>
        ) : null}
        {error ? <div className="setup-status error">{error}</div> : null}
      </div>
      {/* The one action the sheet exists for, where every other sheet keeps it: bottom right. */}
      <div className="sheet-foot">
        <div className="acts">
          {done ? (
            <>
              {onAlsoImport && !otherPresent ? (
                <button className="btn" onClick={() => onAlsoImport(other)}>
                  {other === 'bafu' ? 'Also import BAFU…' : 'Also import ecoinvent…'}
                </button>
              ) : null}
              <button className="btn primary" onClick={onDone}>
                Start
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={start} disabled={!dir || running}>
              {running ? 'Importing…' : 'Start import'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
