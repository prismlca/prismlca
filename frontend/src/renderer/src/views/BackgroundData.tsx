import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../lib/api'
import { errMsg } from '../lib/errors'
import ImportProgress, { type ImportStatus } from '../components/ImportProgress'
import { fmtInt } from '../lib/format'
import EscapeCloser from '../components/EscapeCloser'

type BackgroundSource = 'ecoinvent' | 'bafu'

/** The registry entry the backend keeps per background database (`prism_background`). */
interface BackgroundEntry {
  name: string
  activities: number
  complete: boolean
  provider: BackgroundSource | null
  label: string
  version: string
  system_model?: string
  citation?: string
  imported_at?: string
  flow_mapping?: {
    exchanges_resolved?: number
    exchanges_new_flow?: number
    new_flows?: number
    with_ecoinvent?: boolean
    target?: string
    remap?: { moved?: number; new_flows?: number }
  }
}

interface BackgroundOverview {
  project: string
  biosphere: { name: string; flows: number; revision: string | null; source: string | null } | null
  background: BackgroundEntry[]
  /** Providers that may still be imported — both, the missing one, or none. */
  offered: BackgroundSource[]
  methods: { total: number; custom: number }
  models: { name: string; activities: number; dangling_exchanges: number; kind: string }[]
}

const PROVIDER_LABEL: Record<BackgroundSource, string> = { ecoinvent: 'ecoinvent', bafu: 'BAFU:20XY' }
const PROVIDER_HINT: Record<BackgroundSource, string> = {
  ecoinvent: 'Datasets folder plus the LCIA workbook of the same release.',
  bafu: 'The "ecoSpold files" folder of the BAFU download; its flows are mapped onto the workspace\'s flow list.'
}

/** One import that landed in the library. Removable as a unit — that is what the batch id is for. */
interface Batch {
  batch: string
  label: string
  source: string
  format: string
  date: string
  datasets: number
}

/**
 * What background data this project holds, and the three things one can do about it: import a
 * release, add the impact methods to an inventory that came without them, or start over.
 *
 * The reset is destructive and says so with numbers rather than adjectives — the code it demands
 * is issued by the backend, so this dialog cannot wave it through.
 */
export default function BackgroundData({
  onClose,
  onImport,
  onChanged
}: {
  onClose: () => void
  onImport: (source: BackgroundSource) => void
  onChanged: () => void
}): JSX.Element {
  const [overview, setOverview] = useState<BackgroundOverview | null>(null)
  const [status, setStatus] = useState<ImportStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [batches, setBatches] = useState<Batch[]>([])
  const [library, setLibrary] = useState<{ name: string; own: number } | null>(null)
  // Which import a second click would delete despite the models that draw on it. Naming it here
  // rather than in a dialog keeps the warning and the button in one place.
  const [forcing, setForcing] = useState<string | null>(null)
  // Which background database a second click would remove — the first click only asks.
  const [removing, setRemoving] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  // The scrolling column, and which of its sections is being read — so the rail can mark it.
  const bodyRef = useRef<HTMLDivElement>(null)
  const [current, setCurrent] = useState('overview')

  useEffect(() => () => clearTimeout(timer.current), [])

  const load = useCallback(async () => {
    try {
      setOverview(await api<BackgroundOverview>('GET', '/api/v1/setup/background'))
      const imports = await api<{ batches: Batch[]; own: number; library: string }>(
        'GET',
        '/api/v1/import/batches'
      )
      setBatches(imports.batches)
      setLibrary({ name: imports.library, own: imports.own })
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  const removeImport = useCallback(
    async (b: Batch, force: boolean) => {
      setError(null)
      setDone(null)
      try {
        const r = await api<{ datasets: number }>('POST', '/api/v1/import/batches/delete', {
          batch: b.batch,
          force
        })
        setDone(`Removed ${r.datasets} dataset${r.datasets === 1 ? '' : 's'} from “${b.label}”.`)
        setForcing(null)
        await load()
        onChanged()
      } catch (e) {
        // A refusal because models draw on it is not a failure — it is the question being asked.
        // The second click answers it, so the button changes rather than the message alone.
        setError(errMsg(e))
        setForcing(e instanceof ApiError && e.code === 'import_in_use' ? b.batch : null)
      }
    },
    [load, onChanged]
  )

  const removeBackground = useCallback(
    async (name: string) => {
      setError(null)
      setDone(null)
      try {
        const r = await api<{ database: string; flows_removed: number }>(
          'DELETE',
          `/api/v1/setup/background/${encodeURIComponent(name)}`
        )
        setRemoving(null)
        setDone(
          `Removed ${r.database}` +
            (r.flows_removed
              ? ` and ${r.flows_removed} elementary flow${r.flows_removed === 1 ? '' : 's'} only it used.`
              : '.')
        )
        await load()
        onChanged()
      } catch (e) {
        setRemoving(null)
        setError(errMsg(e))
      }
    },
    [load, onChanged]
  )

  useEffect(() => {
    void load()
  }, [load])

  // Same scroll-spy as the model window: a section counts as current once its head reaches the upper
  // third of the column, not when its last line leaves it. Re-armed whenever the set of sections changes.
  const sectionKey = `${overview ? 1 : 0}:${batches.length}:${library?.own ?? 0}`
  useEffect(() => {
    const root = bodyRef.current
    if (!root) return
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setCurrent(e.target.id.replace('bg-', ''))),
      { root, rootMargin: '-20% 0px -70% 0px' }
    )
    root.querySelectorAll('.bg-sec').forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [sectionKey])

  const poll = useCallback(async () => {
    const st = await api<ImportStatus>('GET', '/api/v1/setup/status')
    setStatus(st)
    if (st.state === 'running') {
      timer.current = setTimeout(() => void poll(), 1500)
    } else {
      await load()
      onChanged()
    }
  }, [load, onChanged])

  const cancelImport = useCallback(async () => {
    await api('POST', '/api/v1/setup/cancel')
  }, [])

  const addMethods = useCallback(async () => {
    const chosen = await window.prism.pickFile([{ name: 'Excel workbook', extensions: ['xlsx'] }])
    if (!chosen) return
    setError(null)
    try {
      await api('POST', '/api/v1/setup/lcia', { lcia_xlsx: chosen, project: overview?.project })
      void poll()
    } catch (e) {
      setError(errMsg(e))
    }
  }, [overview, poll])

  const requestCode = useCallback(async () => {
    setError(null)
    setTyped('')
    try {
      const r = await api<{ code: string }>('POST', '/api/v1/setup/background/reset-code')
      setCode(r.code)
      setResetting(true)
    } catch (e) {
      setError(errMsg(e))
    }
  }, [])

  const doReset = useCallback(async () => {
    setError(null)
    try {
      const r = await api<{ databases: string[]; methods: number }>(
        'POST',
        '/api/v1/setup/background/reset',
        { code: typed }
      )
      setResetting(false)
      setCode(null)
      setTyped('')
      setDone(
        `Removed ${r.databases.length} database${r.databases.length === 1 ? '' : 's'} ` +
          `(${r.databases.join(', ')}) and ${r.methods} impact method${r.methods === 1 ? '' : 's'}.`
      )
      await load()
      onChanged()
    } catch (e) {
      setError(errMsg(e))
    }
  }, [typed, load, onChanged])

  const running = status?.state === 'running'
  const dangling = (overview?.models ?? []).reduce((n, m) => n + m.dangling_exchanges, 0)
  // The library is in this list because it would be left dangling like a model — but it is not one,
  // so it is counted and named apart rather than inflating "your models" by one.
  const affected = (overview?.models ?? []).filter((m) => m.dangling_exchanges > 0 && m.kind !== 'library')
  const affectedLibrary = (overview?.models ?? []).find(
    (m) => m.dangling_exchanges > 0 && m.kind === 'library'
  )
  const ownModels = (overview?.models ?? []).filter((m) => m.kind !== 'library')
  const hasBackground = Boolean(overview && (overview.background.length || overview.biosphere))
  const datasets = (overview?.background ?? []).reduce((n, d) => n + d.activities, 0)
  const offered = overview?.offered ?? []
  const showLibrary = Boolean(library && (batches.length || library.own))

  // The rail: one row per section, a pip that fills once the section has what it is for, and the
  // count the section is about. "Start over" is the one row in the alert colour.
  // Overview has nothing to be "done", so its pip is a spacer that keeps the titles in one column.
  const rail: {
    id: string
    title: string
    done?: boolean
    tally?: string
    danger?: boolean
    nopip?: boolean
  }[] = [
    { id: 'overview', title: 'Overview', nopip: true },
    {
      id: 'inventory',
      title: 'Inventory',
      done: Boolean(overview?.background.length),
      tally: overview ? String(overview.background.length) : undefined
    },
    {
      id: 'methods',
      title: 'Impact methods',
      done: Boolean(overview?.methods.total),
      tally: overview ? fmtInt(overview.methods.total) : undefined
    },
    ...(showLibrary
      ? [{ id: 'library', title: 'Your library', done: batches.length > 0, tally: String(batches.length) }]
      : []),
    ...(hasBackground ? [{ id: 'reset', title: 'Start over', danger: true }] : [])
  ]
  const jump = (id: string): void => {
    document.getElementById(`bg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={() => onClose()} />
      <div className="modal sheet bg-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>Background data</h3>
            <p>
              What this workspace calculates against: the inventory, its elementary flows and the impact
              methods — plus the library of datasets you built or imported yourself.
            </p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="bg-body">
          <aside className="sheet-rail bg-rail">
            <nav className="rail-nav" aria-label="Sections">
              {rail.map((r) => (
                <button
                  key={r.id}
                  className={`rail-item${current === r.id ? ' on' : ''}${r.danger ? ' danger' : ''}`}
                  onClick={() => jump(r.id)}
                >
                  <span
                    className={`rail-pip${r.done ? ' done' : ''}${r.nopip ? ' ghost' : ''}`}
                    aria-hidden="true"
                  />
                  {r.title}
                  {r.tally !== undefined ? <span className="tally">{r.tally}</span> : null}
                </button>
              ))}
            </nav>
            <p className="rail-note">
              <b>{overview?.project ?? 'Loading…'}</b>
              <br />
              Everything here takes effect at once. Your models are never deleted from this window — only what
              they calculate against.
            </p>
          </aside>
          <div className="settings-panel bg-panel" ref={bodyRef}>
            {overview ? (
              <>
                {/* Four numbers first: the state of the project at a glance, before any card asks for a decision. */}
                <section className="bg-sec" id="bg-overview">
                  <div className="bg-stats" aria-label="Overview">
                    <Stat
                      num={datasets}
                      label="Datasets"
                      sub={
                        overview.background.length
                          ? `in ${overview.background.length} database${overview.background.length === 1 ? '' : 's'}`
                          : 'no inventory yet'
                      }
                    />
                    <Stat
                      num={overview.biosphere?.flows ?? 0}
                      label="Elementary flows"
                      sub={
                        overview.biosphere?.revision
                          ? `flow list ${overview.biosphere.revision}`
                          : overview.biosphere
                            ? 'flow list'
                            : 'none yet'
                      }
                    />
                    <Stat
                      num={overview.methods.total}
                      label="Impact methods"
                      sub={
                        overview.methods.total
                          ? overview.methods.custom
                            ? `${overview.methods.custom} of them your own`
                            : 'from the LCIA workbook'
                          : 'nothing to calculate with yet'
                      }
                      tone={overview.methods.total ? undefined : 'warn'}
                    />
                    <Stat
                      num={ownModels.length}
                      label="Your models"
                      sub={
                        ownModels.length
                          ? `${fmtInt(ownModels.reduce((n, m) => n + m.activities, 0))} processes`
                          : 'none yet'
                      }
                      title={ownModels.map((m) => `${m.name} (${m.activities})`).join('\n') || undefined}
                    />
                  </div>
                </section>

                <section className="bg-sec" id="bg-inventory">
                  <h4>Inventory</h4>
                  {overview.background.map((d) => (
                    <div key={d.name} className="bg-card">
                      <div className="bg-card-head">
                        <div className="bg-card-title">
                          <b>{d.label || d.name}</b>
                          {d.provider ? (
                            <span className={`chip bg${d.provider === 'bafu' ? ' bafu' : ''}`}>
                              {PROVIDER_LABEL[d.provider]}
                            </span>
                          ) : null}
                          {d.version ? <span className="chip">{d.version}</span> : null}
                          {d.system_model ? <span className="chip muted">{d.system_model}</span> : null}
                          {d.complete ? null : (
                            <span className="chip warn">empty — the import was interrupted</span>
                          )}
                        </div>
                        <button
                          className="btn sm"
                          onClick={() => setRemoving(removing === d.name ? null : d.name)}
                          disabled={running}
                          title="Removes this database and its search index; refused while a model still uses it"
                        >
                          Remove…
                        </button>
                      </div>
                      <div className="bg-card-meta">
                        {fmtInt(d.activities)} datasets
                        {d.label && d.label !== d.name ? (
                          <>
                            {' '}
                            · <span className="mono">{d.name}</span>
                          </>
                        ) : null}
                        {d.imported_at ? <> · imported {fmtDate(d.imported_at)}</> : null}
                      </div>
                      {d.provider === 'bafu' && d.flow_mapping ? (
                        <p className="bg-card-note">
                          Elementary flows: {fmtInt(d.flow_mapping.exchanges_resolved ?? 0)} exchanges mapped
                          onto {d.flow_mapping.with_ecoinvent ? 'ecoinvent' : 'the bundled flow list'};{' '}
                          {fmtInt(d.flow_mapping.exchanges_new_flow ?? 0)} on{' '}
                          {fmtInt(d.flow_mapping.new_flows ?? 0)} new flows without characterisation factors.
                          {d.flow_mapping.remap
                            ? ` Rewritten onto ecoinvent: ${fmtInt(d.flow_mapping.remap.moved ?? 0)} exchanges moved.`
                            : ''}
                        </p>
                      ) : null}
                      {d.citation ? (
                        <p className="bg-card-note">
                          <span className="bg-card-key">Cite as</span> {d.citation}
                        </p>
                      ) : null}
                      {removing === d.name ? (
                        <div className="bg-confirm" role="alert">
                          <p>
                            Models that draw on it would be left dangling — the removal is refused while any
                            does. The elementary flows and the impact methods stay.
                          </p>
                          <div className="bg-confirm-acts">
                            <button className="btn sm" onClick={() => setRemoving(null)}>
                              Keep it
                            </button>
                            <button className="btn sm danger" onClick={() => void removeBackground(d.name)}>
                              Remove {d.label || d.name}
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {overview.background.length === 0 ? (
                    <p className="bg-empty">
                      No inventory yet. Import a background database below — every model in this workspace
                      will calculate against it.
                    </p>
                  ) : null}

                  {/* Only what is not there yet: with one background installed the other one is offered; with
                both, nothing is (two providers, one database each). */}
                  {offered.length ? (
                    <div className="bg-offers">
                      {offered.map((source) => (
                        <div className="bg-offer" key={source}>
                          <div className="bg-offer-head">
                            <span className={`chip bg${source === 'bafu' ? ' bafu' : ''}`}>
                              {PROVIDER_LABEL[source]}
                            </span>
                            {source === 'ecoinvent' && overview.background.length === 0 ? (
                              <span className="chip muted">recommended first</span>
                            ) : null}
                          </div>
                          <p className="bg-offer-hint">{PROVIDER_HINT[source]}</p>
                          <div className="bg-offer-acts">
                            <button
                              className={`btn sm${overview.background.length === 0 && source === 'ecoinvent' ? ' primary' : ''}`}
                              onClick={() => onImport(source)}
                              disabled={running}
                            >
                              Import {PROVIDER_LABEL[source]}…
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : overview.background.length ? (
                    <p className="settings-hint">Both supported background databases are installed.</p>
                  ) : null}
                </section>

                <section className="bg-sec" id="bg-methods">
                  <h4>Impact methods</h4>
                  <div className="bg-row">
                    <div className="bg-row-text">
                      <b>
                        {overview.methods.total
                          ? `${fmtInt(overview.methods.total)} method${overview.methods.total === 1 ? '' : 's'}`
                          : 'No impact methods'}
                        {overview.methods.custom ? ` · ${overview.methods.custom} your own` : ''}
                      </b>
                      <span>
                        {overview.methods.total
                          ? 'Adds or overwrites methods from an LCIA Implementation workbook.'
                          : overview.biosphere
                            ? 'The inventory came without methods — link a workbook against its elementary flows.'
                            : 'Import an inventory first; the methods link against its elementary flows.'}
                      </span>
                    </div>
                    <button
                      className="btn sm"
                      onClick={addMethods}
                      disabled={running || !overview.biosphere}
                      title={
                        overview.biosphere
                          ? 'Link an LCIA Implementation workbook against the flows already imported'
                          : 'Import an inventory first — the methods link against its elementary flows'
                      }
                    >
                      Add impact methods…
                    </button>
                  </div>
                </section>

                {showLibrary && library ? (
                  <section className="bg-sec" id="bg-library">
                    <h4>
                      Your library <span className="bg-h4-sub">{library.name}</span>
                    </h4>
                    <p className="settings-hint">
                      Datasets you built yourself and everything brought in through the import wizard, in one
                      place every model in this workspace can draw on. It is live — change a dataset here and
                      every model using it changes with it.
                      {library.own ? ` ${library.own} of them you made yourself.` : ''}
                    </p>
                    {batches.map((b) => (
                      <div className="bg-card" key={b.batch}>
                        <div className="bg-card-head">
                          <div className="bg-card-title">
                            <b>{b.label}</b>
                            {b.format ? <span className="chip muted">{b.format}</span> : null}
                          </div>
                          <button
                            className="btn sm"
                            onClick={() => void removeImport(b, forcing === b.batch)}
                            disabled={running}
                          >
                            {forcing === b.batch ? 'Remove it anyway' : 'Remove…'}
                          </button>
                        </div>
                        <div className="bg-card-meta">
                          {fmtInt(b.datasets)} dataset{b.datasets === 1 ? '' : 's'}
                          {b.date ? ` · ${b.date}` : ''}
                          {b.source ? (
                            <>
                              {' '}
                              · <span className="mono">{b.source}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                    ))}
                    {batches.length ? null : (
                      <p className="bg-empty">Nothing imported yet — only what you built yourself.</p>
                    )}
                  </section>
                ) : null}
              </>
            ) : (
              <p className="bg-empty">Loading…</p>
            )}

            {status || done || error ? (
              <div className="bg-feedback">
                {status ? <ImportProgress status={status} onCancel={cancelImport} /> : null}
                {done ? <div className="setup-status done">{done}</div> : null}
                {error ? <div className="setup-status error">{error}</div> : null}
              </div>
            ) : null}

            {hasBackground ? (
              <section className="bg-sec" id="bg-reset">
                <h4 className="bg-h4-danger">Start over</h4>
                <div className="bg-danger">
                  {/* The warning stays on screen while the code is typed — a confirmation shown in an
                    empty panel is a confirmation of nothing. */}
                  <p>
                    Deletes this workspace's background data so a release can be imported again: the
                    inventory, the elementary flows, and <b>every</b> impact method — including{' '}
                    {overview?.methods.custom ?? 0} of your own, because their factors are stored against
                    flows that are about to disappear.
                  </p>
                  <p>
                    Your models are kept, and that is the part to think about:{' '}
                    {affected.length ? (
                      <b>
                        {fmtInt(dangling)} exchange{dangling === 1 ? '' : 's'} in {affected.length} model
                        {affected.length === 1 ? '' : 's'} (
                        {affected
                          .slice(0, 4)
                          .map((m) => m.name)
                          .join(', ')}
                        {affected.length > 4 ? ` and ${affected.length - 4} more` : ''}) point into the data
                        being removed and will point nowhere afterwards.
                      </b>
                    ) : (
                      'no model links to it yet, so nothing will be left dangling.'
                    )}{' '}
                    {affectedLibrary ? (
                      <b>
                        {' '}
                        Your library ({affectedLibrary.name}) loses{' '}
                        {fmtInt(affectedLibrary.dangling_exchanges)} of them too, and every model drawing on
                        it inherits the gap.
                      </b>
                    ) : null}{' '}
                    There is no undo for this.
                  </p>
                  <p>
                    Safer alternative: make a <b>new workspace</b> and import the release there. This one
                    stays intact, and you can compare the two.
                  </p>
                  {!resetting ? (
                    <div className="bg-danger-acts">
                      <button className="btn sm danger" onClick={requestCode} disabled={running}>
                        Start over…
                      </button>
                    </div>
                  ) : (
                    <div className="bg-reset">
                      <p>Type the code to confirm. It is issued once and expires in five minutes.</p>
                      <div className="bg-code">{code}</div>
                      <div className="bg-reset-row">
                        <input
                          className="bg-code-input"
                          value={typed}
                          onChange={(e) => setTyped(e.target.value.replace(/\D/g, '').slice(0, 4))}
                          placeholder="••••"
                          inputMode="numeric"
                          aria-label="Confirmation code"
                          autoFocus
                        />
                        <button
                          className="btn sm"
                          onClick={() => {
                            setResetting(false)
                            setCode(null)
                            setTyped('')
                          }}
                        >
                          Cancel
                        </button>
                        <button className="btn sm danger" onClick={doReset} disabled={typed.length !== 4}>
                          Delete the background data
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            ) : null}
          </div>
        </div>
        <div className="sheet-foot">
          <div className="acts">
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** One of the four numbers at the top. The number carries the weight; the line under it says what it counts. */
function Stat({
  num,
  label,
  sub,
  tone,
  title
}: {
  num: number
  label: string
  sub: string
  tone?: 'warn'
  title?: string
}): JSX.Element {
  return (
    <div className={`bg-stat${tone ? ` ${tone}` : ''}`} title={title}>
      <div className="bg-stat-num">{fmtInt(num)}</div>
      <div className="bg-stat-label">{label}</div>
      <div className="bg-stat-sub">{sub}</div>
    </div>
  )
}

/** An ISO timestamp as a short date; anything unparseable is shown as it came. */
function fmtDate(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })
}
