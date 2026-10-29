/**
 * Bringing foreign data in — SimaPro, openLCA, GaBi, EcoSpold, ILCD.
 *
 * Five steps, and the important property is what they do NOT do: **nothing is written until the
 * last button.** Everything before that lives in the backend's session and is thrown away by
 * closing this window. That is what makes step 4 a review rather than a confirmation dialog.
 *
 * What the last button writes into is **the project's library, `My processes`** — not a database
 * of its own. So the name asked for at the end names the *import*, which is what one later looks
 * for in the list of imports and removes again; it is not an address anything points at.
 *
 * The band filter in step 4 is not a convenience. A 300-flow import produces 300 rows nobody reads
 * end to end; what a person can do is look at the 12 uncertain ones. The bands exist so that
 * "look at the uncertain ones" is a click.
 */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'

import Overlay from '../components/Overlay'
import { SearchIcon, SparkleIcon, StopIcon } from '../components/icons'
import { api } from '../lib/api'
import { errMsg } from '../lib/errors'

type Band = 'good' | 'medium' | 'low' | 'open'

/** A flow or a process one could match to. `categories` is the compartment for a flow, `location`
 *  the region for a process — the two questions a reviewer cannot answer from a name alone. */
interface Candidate {
  database: string
  code: string
  label: string
  /** The name without its compartment or region. Two candidates sharing it are one thing, two places. */
  name: string
  unit: string
  categories: string[]
  location: string
  why?: string
  /** From the user's own library, not the background — the reviewer must see whose dataset it is. */
  library?: boolean
  /** A dataset of the package being imported: the source delivered this supplier itself. */
  package?: boolean
  /** Makes the wanted product only as a co-product — cannot be picked until it is allocated. */
  allocation_required?: boolean
  /** Negative reference production: a treatment, what a waste row is booked against. Null = not looked at. */
  treatment?: boolean | null
}

type Target = Candidate

interface Row {
  dataset: string
  /** What identifies the dataset — two processes can share a name (the same activity in two regions). */
  dataset_key?: string
  index: number
  kind: string
  name: string
  amount: number
  unit: string
  compartment: string[]
  confidence: Band
  evidence: string
  factor: number
  scale: string
  /** The amount after unit conversion — what actually lands in the database. */
  scaled_amount: number
  target: Target | null
  candidates: Candidate[]
  /** The region is still the reviewer's call — see the “Select region…” dropdown. */
  region_open?: boolean
  /** The target measures another quantity and only a substance property bridges the two — the
   *  reviewer's to state, in the input under the converted amount. */
  needs_assumption?: boolean
  /** A product the process gives off besides its reference — not booked unless substitution is on. */
  coproduct?: boolean
  /** A waste the process gives off — booked as a link to its treatment, never as a co-product. */
  waste?: boolean
  /** A negative input the source does not call a waste — booked as written; the reviewer decides. */
  sign_review?: boolean
}

interface State {
  active?: boolean
  format_label?: string
  datasets?: number
  rows?: number
  bands?: Partial<Record<Band, number>>
  needs_model?: number
  /** Matched processes whose region nobody has chosen yet — the commit refuses while > 0. */
  region_open?: number
  /** Rows that are co-products, and whether the commit books them as substitution. */
  coproducts?: number
  coproducts_as_substitution?: boolean
  /** Inputs bound to a supplier that came in the same package. */
  from_package?: number
  notes?: string[]
}

/** One activity, with the regions it exists in. The review table needs the pair separately: a
 *  single dropdown holding “activity × region” runs to sixty lines for electricity, and nobody
 *  picks anything out of sixty. */
interface Group {
  key: string
  label: string
  candidates: Candidate[]
}

/** What a hand search also looked for, read off the candidates' reason ("search (also searched as
 *  “polyethylene terephthalate resin”)") — the backend adds it when it spelled out an abbreviation. */
function alsoSearchedAs(found: Candidate[]): string | null {
  for (const c of found) {
    const m = /also searched as “([^”]+)”/.exec(c.why ?? '')
    if (m) return m[1]
  }
  return null
}

/** Group a row's candidates by activity, keeping the order the backend chose (best first). */
function byActivity(candidates: Candidate[]): Group[] {
  const groups: Group[] = []
  const index = new Map<string, Group>()
  for (const c of candidates) {
    // The database belongs in the key: the user's own "styrene production" answers to the same
    // name as ecoinvent's, and folding them into one entry would hide whose numbers get used.
    const key = `${c.database}|${c.name || c.label}|${c.unit}`
    const existing = index.get(key)
    if (existing) {
      existing.candidates.push(c)
      continue
    }
    const group = {
      key,
      label: `${c.name || c.label}${c.treatment ? ' · treatment' : ''}${
        c.allocation_required
          ? ' — from this package, co-product only: allocate it first'
          : c.package
            ? ' — from this package'
            : c.library
              ? ` — ${c.database}`
              : ''
      }`,
      candidates: [c]
    }
    index.set(key, group)
    groups.push(group)
  }
  return groups
}

const BAND_LABEL: Record<Band, string> = {
  good: 'Good',
  medium: 'Medium',
  low: 'Low',
  open: 'Not matched'
}

/** What a reviewer's pick says about the row, in the band and the note that end up on the dataset.
 *
 *  Picking a region is not choosing another material: the product, the technology and the reason
 *  they fit stay what the rules or the model established. Sending the generic note for it replaced
 *  that reason with "chosen in review" — in the review, in the exchange comment and in the dataset's
 *  metadata — so the one step a person must take erased the record of why the match was made.
 *  A region pick keeps the band and the note and adds the decision to it; a material
 *  pick is the reviewer's own and says so. */
export const REGION_NOTE = 'region chosen in review'
export function reviewDecision(
  row: Pick<Row, 'confidence' | 'evidence' | 'target' | 'scale' | 'factor'>,
  target: { database: string; code: string; regionChosen?: boolean } | null
): { confidence: Band; evidence: string; assumption?: { quantity: number; what: string } } {
  if (!target) return { confidence: 'open', evidence: 'cleared by the reviewer' }
  if (target.regionChosen && row.target && row.confidence !== 'open') {
    const base = row.evidence.endsWith(` · ${REGION_NOTE}`)
      ? row.evidence.slice(0, -` · ${REGION_NOTE}`.length)
      : row.evidence
    // The backend recomputes the conversion from the decision it is sent. A density the reviewer
    // stated for this material still holds in another region, so it travels along — without it the
    // factor fell back to 1 and a 1 000-fold wrong amount became committable.
    const applied = appliedAssumption(row.scale, row.factor)
    return {
      confidence: row.confidence,
      evidence: base ? `${base} · ${REGION_NOTE}` : REGION_NOTE,
      ...(applied.what ? { assumption: { quantity: Number(applied.quantity), what: applied.what } } : {})
    }
  }
  return { confidence: 'medium', evidence: 'chosen in review' }
}

export default function ImportWizard({
  onClose,
  onDone
}: {
  onClose: () => void
  /** The library the import landed in — the caller refreshes its database list. */
  onDone: (name: string) => void
}) {
  const [path, setPath] = useState('')
  const [detected, setDetected] = useState<{ label: string; evidence: string; files: number } | null>(null)
  const [state, setState] = useState<State>({})
  const [rows, setRows] = useState<Row[]>([])
  const [filter, setFilter] = useState<Band | 'all'>('all')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [readProgress, setReadProgress] = useState<{
    phase: string
    done: number
    total: number
  } | null>(null)
  /** A read is in flight. Its own flag rather than a look at `busy`, which also stands for choosing
   *  a file and for the commit — only a read can be stopped. */
  const [reading, setReading] = useState(false)
  /** The stop was sent and the pass has not reached a checkpoint yet. The button says so, because
   *  a stop that takes a few seconds and shows nothing reads as a stop that did not work. */
  const [stopping, setStopping] = useState(false)
  const [matchProgress, setMatchProgress] = useState<{
    done: number
    total: number
    matched?: number
  } | null>(null)
  const [name, setName] = useState('')
  const [keepUnmatched, setKeepUnmatched] = useState(true)
  /** Set when the import landed but nothing can find it yet — see `commit`. */
  const [unsearchable, setUnsearchable] = useState<number | null>(null)
  /** With `unsearchable`: the index exists but could not take the datasets (an embedding provider
   *  failing after the write). The datasets are in either way; the advice differs. */
  const [indexError, setIndexError] = useState<string | null>(null)
  /** Set when the import landed and IS findable — the confirmation the window used to skip.
   *  Closing silently read as "did anything happen?". */
  const [done, setDone] = useState<{ datasets: number; parked: number; coproducts: number } | null>(null)

  // An import that is already open comes back with the window. Closing this sheet does not throw
  // the session away (only Discard does), so without this a user who closed it to look something
  // up would land on step 1 with no way back to their review — and no way to reach the Discard
  // button either, since that lives inside the review.
  useEffect(() => {
    void api<State>('GET', '/api/v1/import/state')
      .then((s) => {
        if (s.active) setState(s)
      })
      .catch(() => {})
  }, [])

  const loadRows = useCallback(async () => {
    const query = filter === 'all' ? '' : `?confidence=${filter}`
    const r = await api<{ rows: Row[] }>('GET', `/api/v1/import/rows${query}`)
    setRows(r.rows)
  }, [filter])

  useEffect(() => {
    if (state.active) void loadRows().catch((e) => setError(errMsg(e)))
  }, [state.active, loadRows])

  // The run lives in the main process, so the window has to LISTEN for its end rather than wait
  // for its own call to return: a run started anywhere — including one already in flight when this
  // window opened — otherwise finished invisibly and the table kept showing the old rows until
  // somebody closed and reopened the sheet.
  useEffect(() => {
    const off = window.prism.onImportMatchProgress((p) => {
      setMatchProgress(p)
      if (p.total > 0 && p.done >= p.total) {
        setMatchProgress(null)
        void (async () => {
          setState({ active: true, ...(await api<State>('GET', '/api/v1/import/state')) })
          await loadRows().catch((e) => setError(errMsg(e)))
        })()
      }
    })
    return () => {
      off()
    }
  }, [loadRows])

  const choose = async (folder: boolean): Promise<void> => {
    // A source is a file OR a folder, and the OS dialog cannot offer both at once — an ILCD export
    // is a directory of thousands of files, a SimaPro export is one CSV.
    const picked = folder
      ? await window.prism.pickDirectory()
      : (
          await window.prism.pickFiles([
            { name: 'LCA exports', extensions: ['xml', 'spold', 'csv', 'zip', 'json', 'txt'] }
          ])
        )[0]
    if (!picked) return
    setPath(picked)
    setError(null)
    try {
      setBusy('Looking at the file…')
      setDetected(await api('POST', '/api/v1/import/detect', { path: picked }))
    } catch (e) {
      setDetected(null)
      setError(errMsg(e))
    } finally {
      setBusy('')
    }
  }

  const read = async (): Promise<void> => {
    setError(null)
    setStopping(false)
    setReading(true)
    // The deterministic pass takes minutes on a big package, so the wizard polls where it stands
    // and draws the same bar the model run gets — the backend counts rows as it matches them.
    const poll = setInterval(() => {
      void api<{ reading: { phase: string; done: number; total: number } | null }>(
        'GET',
        '/api/v1/import/progress'
      )
        .then((p) => setReadProgress(p.reading))
        .catch(() => {})
    }, 600)
    try {
      setBusy('Reading and matching what can be matched by rule…')
      // A stopped pass answers `active: false`, which the spread carries over the optimistic
      // `true` — the wizard lands back on the file it had picked, with nothing said. Saying
      // "stopped" would be telling the user what they just did.
      setState({ active: true, ...(await api<State>('POST', '/api/v1/import/start', { path })) })
    } catch (e) {
      setError(errMsg(e))
      setState({})
    } finally {
      clearInterval(poll)
      setReadProgress(null)
      setReading(false)
      setStopping(false)
      setBusy('')
    }
  }

  /** Stop the pass that is running. Cooperative: the backend gives up at its next row, so this
   *  only sends the word and lets the button say it is waiting for it. */
  const stopReading = async (): Promise<void> => {
    setStopping(true)
    try {
      await api('POST', '/api/v1/import/stop', {})
    } catch (e) {
      // A stop that did not arrive must not leave a dead button behind: say so and hand the click
      // back. (Seen for real — a renderer hot-reloaded onto a backend that predated /import/stop
      // answered "not found", and the only way on was closing the window.)
      setError(errMsg(e))
      setStopping(false)
    }
  }

  const runModel = async (): Promise<void> => {
    setError(null)
    setMatchProgress({ done: 0, total: state.needs_model ?? 0 })
    try {
      setBusy('Asking the matching model about what the rules left open…')
      const result = await window.prism.matchImport()
      if (result.error) setError(result.error)
      setState({ active: true, ...(await api('GET', '/api/v1/import/state')) })
      await loadRows()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy('')
      setMatchProgress(null)
    }
  }

  const decide = async (
    row: Row,
    target: { database: string; code: string; regionChosen?: boolean } | null
  ): Promise<void> => {
    setError(null)
    try {
      await sendDecision(row, target)
    } catch (e) {
      setError(errMsg(e))
    }
    setState({ active: true, ...(await api('GET', '/api/v1/import/state')) })
    await loadRows()
  }

  /** The reviewer's bridge between two quantities: same target, a stated figure and why. The
   *  match's reason and band travel along; the backend puts an assumed conversion in "low" itself. */
  const assume = async (row: Row, quantity: number, what: string): Promise<void> => {
    if (!row.target) return
    setError(null)
    try {
      await api('POST', '/api/v1/import/decide', {
        decisions: [
          {
            dataset: row.dataset,
            dataset_key: row.dataset_key,
            index: row.index,
            database: row.target.database,
            code: row.target.code,
            confidence: row.confidence === 'open' ? 'medium' : row.confidence,
            evidence: row.evidence,
            // The region the row already has is a settled choice; a bridge must not reopen it.
            region_chosen: !row.region_open,
            assumption: { quantity, what }
          }
        ]
      })
    } catch (e) {
      setError(errMsg(e))
    }
    setState({ active: true, ...(await api('GET', '/api/v1/import/state')) })
    await loadRows()
  }

  const sendDecision = async (
    row: Row,
    target: { database: string; code: string; regionChosen?: boolean } | null
  ): Promise<void> => {
    const { confidence, evidence, assumption } = reviewDecision(row, target)
    await api('POST', '/api/v1/import/decide', {
      decisions: [
        {
          dataset: row.dataset,
          dataset_key: row.dataset_key,
          index: row.index,
          database: target?.database,
          code: target?.code ?? null,
          confidence,
          evidence,
          // Picking a region in the dropdown IS the decision the backend is waiting for — without
          // this flag it would keep counting the row as "Select region…".
          region_chosen: !!target?.regionChosen,
          ...(assumption ? { assumption } : {})
        }
      ]
    })
  }

  const commit = async (): Promise<void> => {
    setError(null)
    try {
      setBusy('Writing into the library…')
      const r = await api<{
        database: string
        datasets: number
        unmatched: number
        coproducts?: number
        index: { added: number; exists: boolean; error?: string }
      }>('POST', '/api/v1/import/commit', {
        label: name.trim(),
        unmatched: keepUnmatched ? 'park' : 'drop'
      })
      onDone(r.database)
      // An indexed library takes the new datasets along and there is nothing to report. An
      // un-indexed one swallows them silently — they are in, but no search will show them — and
      // closing on that would be closing on a job half done.
      if (r.index.error && r.datasets) {
        setIndexError(r.index.error)
        setUnsearchable(r.datasets)
      } else if (!r.index.exists && r.datasets) setUnsearchable(r.datasets)
      else
        setDone({
          datasets: r.datasets,
          // The backend's count, whatever the checkbox said: a waste (and a match whose target
          // produces nothing) is parked even when unmatched flows are dropped.
          parked: r.unmatched,
          coproducts: r.coproducts ?? 0
        })
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy('')
    }
  }

  /** Write-through: the switch applies when it is flipped, and the backend answers with the new state. */
  // While the switch is on its way the commit waits, and while the commit writes the switch is off
  // limits: flipped halfway, one import came out partly parked and partly substituted.
  const [optionPending, setOptionPending] = useState(false)
  const setSubstitution = async (on: boolean): Promise<void> => {
    setError(null)
    setOptionPending(true)
    try {
      setState({
        active: true,
        ...(await api<State>('POST', '/api/v1/import/options', { coproducts_as_substitution: on }))
      })
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setOptionPending(false)
    }
  }

  const cancel = async (): Promise<void> => {
    await api('POST', '/api/v1/import/cancel', {}).catch(() => {})
    onClose()
  }

  // The bar only exists once the pass counts rows; while the package is still being parsed there
  // is no total and the busy line carries the news instead.
  const readBar = readProgress && readProgress.total > 0 ? readProgress : null
  const bands = state.bands ?? {}
  const openCount = bands.open ?? 0
  // 400 rows at a time, and more on request: a filter with more than 400 rows left the rest — and an
  // open region decision among them — unreachable, which blocked the commit.
  const [shownCap, setShownCap] = useState(400)
  const shown = useMemo(() => rows.slice(0, shownCap), [rows, shownCap])

  // Closing is not discarding. The session lives in the backend and survives this window — that is
  // what makes step 4 a review rather than a dialog — so the X and a click beside the sheet just put
  // it away, and only Discard throws it out. A stray click used to cost 228 reviewed rows,
  // which is too much to lose to a misclick.
  // Only the review step needs the wide sheet — a table of flow names does. Picking a file is a
  // sentence and two buttons, and at 1100px that reads as an empty room.
  const reviewing = state.active && done === null && unsearchable === null

  // Which of the three stations the sheet is at — for the strip in the head and the foot's buttons.
  const step = done !== null || unsearchable !== null ? 3 : state.active ? 2 : 1
  const STEPS = ['Pick a file', 'Review the matches', 'Done'] as const

  return (
    <Overlay onClose={onClose} className={`modal sheet import-wizard${reviewing ? '' : ' compact'}`}>
      <div className="sheet-head">
        <div className="sheet-head-grow">
          <h3>Import from other software</h3>
          <p>
            {step === 1
              ? 'Everything you import lands in My processes, where every model in this workspace can draw on it.'
              : step === 2
                ? 'Check what each flow was matched to. Nothing is written until you add it.'
                : 'Imported into My processes.'}
          </p>
          <ol className="imp-steps" aria-label="Steps">
            {STEPS.map((label, i) => (
              <li key={label} className={i + 1 < step ? 'done' : i + 1 === step ? 'on' : ''}>
                <span className="imp-step-n" aria-hidden="true">
                  {i + 1 < step ? '✓' : i + 1}
                </span>
                {label}
              </li>
            ))}
          </ol>
        </div>
        <button className="sheet-x" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="sheet-body imp-body">
        {done !== null ? (
          <>
            <p>
              {done.datasets === 1 ? 'Process' : `${done.datasets} processes`} imported into{' '}
              <b>My processes</b> — findable on the model page: tick <b>My processes</b> under the search, or
              use its <i>(list all)</i>.
            </p>
            {done.parked ? (
              <p className="settings-hint">
                {done.parked} kept as unmatched (waste is always kept) — with the dataset
                {done.datasets === 1 ? '' : 's'}, counted and visible to the health check.
              </p>
            ) : null}
            {done.coproducts ? (
              <p className="settings-hint warn">
                {done.coproducts} co-product{done.coproducts === 1 ? ' was' : 's were'} not booked — the
                dataset
                {done.datasets === 1 ? ' carries' : 's carry'} the whole burden until you allocate it or book
                the co-product as substitution.
              </p>
            ) : null}
          </>
        ) : unsearchable !== null ? (
          <>
            <p>
              {unsearchable} dataset{unsearchable === 1 ? '' : 's'} added to <b>My processes</b>.
            </p>
            {indexError ? (
              <p className="settings-hint warn">
                The search index could not take them ({indexError}), so nothing will find them until it is
                rebuilt: the <b>Index</b> button in the search panel on the model page, with{' '}
                <b>My processes</b> selected.
              </p>
            ) : (
              <p className="settings-hint warn">
                Your library has no search index yet, so nothing will find them. Build it once in the search
                panel on the model page — the <b>Index</b> button, with <b>My processes</b>
                selected. After that every import keeps the index up to date on its own.
              </p>
            )}
          </>
        ) : !state.active ? (
          <>
            <p className="settings-hint">
              A <b>SimaPro CSV</b> export (<span className="mono">.csv</span>,{' '}
              <span className="mono">.txt</span>), an <b>openLCA JSON-LD</b> package (
              <span className="mono">.json</span>, <span className="mono">.zip</span> or a folder), an{' '}
              <b>EcoSpold 1</b> or <b>EcoSpold 2</b> file (<span className="mono">.xml</span>,{' '}
              <span className="mono">.spold</span>, or a folder of them), or an <b>ILCD</b> package (
              <span className="mono">.zip</span> or a folder).
            </p>
            <p className="settings-hint">
              PrismLCA reads what the file says it is — there is nothing to pick. Everything lands in your
              library, <b>My processes</b>, where every model in this workspace can draw on it.
            </p>
            <div className="row-gap">
              <button className="btn" onClick={() => void choose(false)}>
                Choose a file…
              </button>
              <button className="btn" onClick={() => void choose(true)}>
                Choose a folder…
              </button>
            </div>
            {/* The picked path is the one line on this step the user has to *recognise* — set as faint
              grey prose it read as another hint and vanished into the two around it. A terminal
              face on its own ground says "this is what is on disk". */}
            {path ? <p className="imp-path">{path}</p> : null}
            {detected ? (
              <p className="settings-hint imp-detected">
                <b>{detected.label}</b> — {detected.evidence}
                {detected.files > 1 ? `, ${detected.files} files` : ''}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="settings-hint">
              <b>{state.format_label}</b> · {state.datasets} datasets · {state.rows} flows
              {state.from_package ? ` · ${state.from_package} linked within the package` : ''}.{' '}
              {Object.entries(bands)
                .map(([band, count]) => `${count} ${BAND_LABEL[band as Band].toLowerCase()}`)
                .join(' · ')}
            </p>
            {(state.notes ?? []).map((note) => (
              <p className="settings-hint warn" key={note}>
                {note}
              </p>
            ))}

            {state.needs_model ? (
              <div className="row-gap">
                <button
                  className="btn ico-label"
                  disabled={!!busy}
                  onClick={() => void runModel()}
                  title={`Let the matching model look at the ${state.needs_model} rows the rules could not settle`}
                >
                  <SparkleIcon /> AI assignment ({state.needs_model})
                </button>
                {/* The same bar the index build uses — a bare "17 of 110" makes you do the division,
                  and a run of six batches is long enough to want the shape at a glance. */}
                {matchProgress ? (
                  <div
                    className="idx-progress imp-progress"
                    title={`${matchProgress.matched} matched so far`}
                  >
                    <div className="idx-progress-bar">
                      <span
                        style={{
                          width:
                            matchProgress.total > 0
                              ? `${Math.round((matchProgress.done / matchProgress.total) * 100)}%`
                              : '100%'
                        }}
                      />
                    </div>
                    <div className="idx-progress-num">
                      {matchProgress.done} / {matchProgress.total}
                    </div>
                    <button
                      className="btn sm imp-stop"
                      title="Stop — answers already given are kept, the rest stays open"
                      onClick={() => void window.prism.stopImportMatch()}
                    >
                      Stop
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="row-gap">
              {(['all', 'good', 'medium', 'low', 'open'] as const).map((band) => (
                <button
                  key={band}
                  className={`seg-btn${filter === band ? ' on' : ''}`}
                  onClick={() => setFilter(band)}
                >
                  {band === 'all' ? 'All' : BAND_LABEL[band]}
                  {band !== 'all' && bands[band] ? ` (${bands[band]})` : ''}
                </button>
              ))}
            </div>

            <div className="ai-table-wrap">
              <table className="ai-table">
                <thead>
                  <tr>
                    <th>From the file</th>
                    <th>Matched to</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <tr key={`${row.dataset}:${row.index}`}>
                      <td>
                        <div className="imp-name">{row.name}</div>
                        <div className="settings-hint">
                          {row.amount} {row.unit}
                          {row.compartment.length ? ` · ${row.compartment.join(' / ')}` : ''}
                        </div>
                        {row.coproduct ? (
                          <span
                            className="chip"
                            title={
                              state.coproducts_as_substitution
                                ? 'Given off besides the reference product. Booked as substitution: the matched process is credited as avoided burden (system expansion).'
                                : 'Given off besides the reference product. Not booked, so the dataset carries the whole burden — allocate it, or book co-products as substitution below.'
                            }
                          >
                            {state.coproducts_as_substitution
                              ? 'Co-product — booked as substitution'
                              : 'Co-product — not booked'}
                          </span>
                        ) : null}
                        {row.waste ? (
                          <span
                            className="chip"
                            title="A waste this process gives off. Booked as a link to the treatment it is matched to, with that dataset's own sign — a treatment whose reference is −1 takes a negative amount, so its burden is added. Never a co-product, never a substitution."
                          >
                            Waste → treatment
                          </span>
                        ) : null}
                        {row.sign_review ? (
                          <span
                            className="chip"
                            title="The file gives this input a negative amount but does not say it is a waste. It is booked as written: against a producing process that is a credit, against a treatment (reference −1) it sends waste to treatment. Check which one the source meant, and match it accordingly."
                          >
                            Negative input — check whether this is waste to treatment
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <MatchCell
                          row={row}
                          onPick={(t) => void decide(row, t)}
                          onAssume={(q, what) => void assume(row, q, what)}
                        />
                      </td>
                      <td>
                        <span className={`band band-${row.confidence}`}>{BAND_LABEL[row.confidence]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > shown.length ? (
                <p className="settings-hint">
                  Showing {shown.length} of {rows.length} rows.{' '}
                  <button className="btn sm" onClick={() => setShownCap((c) => c + 400)}>
                    Show 400 more
                  </button>
                </p>
              ) : null}
            </div>
            {rows.length > shown.length ? (
              <p className="settings-hint">
                Showing the first {shown.length} of {rows.length}. Filter by band to see the rest.
              </p>
            ) : null}

            <label className="settings-field">
              <span>Name for this import</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. supplier data, spring delivery"
              />
            </label>
            <p className="settings-hint">
              Names this delivery — it is how you find it again in Background, and how you remove it again.
              Leave it empty and the file's own name is used.
            </p>
            {openCount ? (
              <label className="settings-field settings-check">
                <input
                  type="checkbox"
                  checked={keepUnmatched}
                  onChange={(e) => setKeepUnmatched(e.target.checked)}
                />
                <span>
                  Keep the {openCount} unmatched flows with their datasets, counted and reported
                  {keepUnmatched
                    ? ''
                    : ' — unticked, they are dropped and the study will look better than it is (waste is always kept)'}
                </span>
              </label>
            ) : null}
            {state.coproducts ? (
              <label className="settings-field settings-check">
                <input
                  type="checkbox"
                  checked={!!state.coproducts_as_substitution}
                  disabled={!!busy || optionPending}
                  onChange={(e) => void setSubstitution(e.target.checked)}
                />
                <span>
                  Book the {state.coproducts} co-product{state.coproducts === 1 ? '' : 's'} as substitution
                  {state.coproducts_as_substitution
                    ? ' — each matched co-product credits the process it is matched to (avoided burden, system expansion). This changes results.'
                    : ' — unticked, they are not booked and each dataset carries the whole burden; allocation or system expansion is then yours to model.'}
                </span>
              </label>
            ) : null}
            {state.region_open ? (
              <p className="settings-hint warn">
                {state.region_open} matched process{state.region_open === 1 ? '' : 'es'} still{' '}
                {state.region_open === 1 ? 'needs' : 'need'} a region — the source names none, so it is your
                call. Pick one in each row showing “Select region…”.
              </p>
            ) : null}
          </>
        )}
        {error ? <p className="settings-hint bad imp-error">{error}</p> : null}
      </div>
      {/* The foot carries what moves the wizard on — and, on the first step, the progress of the read
          beside the button that started it, with the way out next to it. */}
      <div className="sheet-foot">
        {step === 3 ? (
          <div className="acts">
            <button className="btn primary" onClick={onClose}>
              Close
            </button>
          </div>
        ) : step === 1 ? (
          <>
            <div className="meta imp-foot-meta">
              {readBar ? (
                <div
                  className="idx-progress imp-progress imp-readbar"
                  title="Matching by rule — nothing is written yet"
                >
                  <div className="idx-progress-bar">
                    <span style={{ width: `${Math.round((readBar.done / readBar.total) * 100)}%` }} />
                  </div>
                  <div className="idx-progress-num">
                    {readBar.done} / {readBar.total}
                  </div>
                </div>
              ) : busy ? (
                // Until the pass can count rows there is no bar, and the spinner stands in for it —
                // in the same place, so nothing jumps when the one becomes the other.
                <BusyLine text={busy} inline />
              ) : detected ? (
                <>
                  <b>{detected.label}</b>
                  {detected.files > 1 ? ` · ${detected.files} files` : ''}
                </>
              ) : (
                'Pick a file or folder to begin.'
              )}
            </div>
            <div className="acts">
              {reading ? (
                <button
                  className="btn ico imp-stop"
                  disabled={stopping}
                  aria-label={stopping ? 'Stopping' : 'Stop reading'}
                  title={
                    stopping
                      ? 'Stopping at the next row…'
                      : 'Stop reading — nothing has been written, and the file stays picked'
                  }
                  onClick={() => void stopReading()}
                >
                  <StopIcon />
                </button>
              ) : null}
              <button className="btn primary" disabled={!detected || !!busy} onClick={() => void read()}>
                Read it
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="meta imp-foot-meta">
              {busy ? (
                <BusyLine text={busy} inline />
              ) : state.region_open ? (
                <span className="imp-foot-warn">
                  {state.region_open} region{state.region_open === 1 ? '' : 's'} still to pick
                </span>
              ) : (
                `${state.datasets} datasets · ${state.rows} flows`
              )}
            </div>
            <div className="acts">
              <button className="btn" onClick={() => void cancel()}>
                Discard
              </button>
              <button
                className="btn primary"
                disabled={!!busy || optionPending || !!state.region_open}
                onClick={() => void commit()}
              >
                Add to My processes
              </button>
            </div>
          </>
        )}
      </div>
    </Overlay>
  )
}

/**
 * The busy line with a life sign: a spinner and the seconds that have passed.
 *
 * "Reading and matching what can be matched by rule…" stands for MINUTES on a big ILCD package
 * (the technosphere search runs per input), and a static sentence that long is indistinguishable
 * from a hang. A true progress bar needs the backend to report row counts
 * mid-read; until it does, the spinner and the clock are the honest signal that work is happening.
 */
function BusyLine({ text, inline = false }: { text: string; inline?: boolean }): JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    setSeconds(0)
    const t = setInterval(() => setSeconds((v) => v + 1), 1000)
    return () => clearInterval(t)
  }, [text])
  return (
    <p className={`settings-hint imp-busy${inline ? ' imp-busy-inline' : ''}`}>
      <span className="imp-spinner" aria-hidden="true" />
      {text}
      {seconds >= 3 ? <span className="imp-busy-s">{seconds}s</span> : null}
    </p>
  )
}

/** What an assumption already applied to the row says, read back from its note
 *  ("kg → cubic meter via liquid water, 1 kg/L (0.001 cubic meter/kg)") — so the input shows it. */
export function appliedAssumption(scale: string, factor: number): { quantity: string; what: string } {
  const m = / via (.+) \([^()]*\)$/.exec(scale || '')
  return m ? { quantity: String(factor), what: m[1] } : { quantity: '', what: '' }
}

/**
 * The reviewer's bridge between two quantities: "1 kg = [ ] m³ because [ ]".
 *
 * The figure is asked for in the direction it is applied — target units per source unit — rather
 * than as a density, because "1 kg/L" turned into a factor is exactly where 1, 0.001 and 1 000 get
 * confused; stated this way, the arithmetic is on screen. Applied when both fields hold something and
 * a field is left or Enter pressed — no button (every change applies immediately). Without a
 * reason the backend refuses the figure, and so does this: a factor nobody can trace is an invented
 * one.
 */
export function AssumptionInput({
  row,
  onAssume
}: {
  row: Row
  onAssume: (quantity: number, what: string) => void
}): JSX.Element {
  const applied = appliedAssumption(row.scale, row.factor)
  const [quantity, setQuantity] = useState(applied.quantity)
  const [what, setWhat] = useState(applied.what)
  const commit = (): void => {
    const q = Number(quantity.replace(',', '.'))
    if (!(q > 0) || !what.trim()) return
    if (String(q) === applied.quantity && what.trim() === applied.what) return
    onAssume(q, what.trim())
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') commit()
  }
  return (
    <div className="imp-assume">
      <span>1 {row.unit} =</span>
      <input
        className="imp-assume-q"
        inputMode="decimal"
        aria-label={`How many ${row.target?.unit || 'target units'} one ${row.unit} is`}
        placeholder="?"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
      />
      <span>{row.target?.unit}, because</span>
      <input
        className="imp-assume-what"
        aria-label="What the figure rests on"
        placeholder="e.g. density of liquid water, 1 kg/L"
        value={what}
        onChange={(e) => setWhat(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
      />
    </div>
  )
}

/**
 * The "Matched to" cell: what this line became, and everything a reviewer needs to judge it.
 *
 * Four things have to be readable without opening anything, because each of them can make the
 * match wrong in a way the name does not show:
 *
 * - **the compartment**, for a flow — a characterisation factor is per compartment, so CO₂ to air
 *   and CO₂ to water are two different numbers;
 * - **the region**, for a process — which electricity mix, which transport distances;
 * - **the unit and the conversion** — 2.5 kg becoming 2 500 g is arithmetic the reviewer signs off;
 * - **what else it could have been**, and a way to look for something the shortlist never had.
 *
 * The *reason* is the one thing that hides: it was a column and ate the width the four above need,
 * so it sits behind the ⓘ.
 */
export function MatchCell({
  row,
  onPick,
  onAssume
}: {
  row: Row
  onPick: (target: { database: string; code: string; regionChosen?: boolean } | null) => void
  onAssume?: (quantity: number, what: string) => void
}): JSX.Element {
  const isFlow = row.kind === 'biosphere'
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Candidate[] | null>(null)
  const [looking, setLooking] = useState(false)

  const groups = useMemo(() => byActivity(row.candidates), [row.candidates])
  const chosen = row.target
    ? (groups.find((g) => g.candidates.some((c) => c.code === row.target?.code)) ?? null)
    : null
  const regions = chosen?.candidates.filter((c) => c.location) ?? []

  const look = async (): Promise<void> => {
    if (!query.trim()) return
    setLooking(true)
    try {
      const r = await api<{ candidates: Candidate[] }>(
        'GET',
        `/api/v1/import/candidates?kind=${isFlow ? 'biosphere' : 'technosphere'}&q=${encodeURIComponent(query)}`
      )
      setFound(r.candidates)
    } finally {
      setLooking(false)
    }
  }

  const why = [row.evidence, row.scale].filter(Boolean).join(' · ')
  const factor = row.factor ?? 1

  return (
    <div className="imp-match">
      <div className="imp-row">
        <select
          value={chosen?.key ?? ''}
          onChange={(e) => {
            const group = groups.find((g) => g.key === e.target.value)
            onPick(group ? { database: group.candidates[0].database, code: group.candidates[0].code } : null)
          }}
        >
          <option value="">— not matched —</option>
          {groups.map((g) => (
            <option
              key={g.key}
              value={g.key}
              // A co-product supplier is shown, with its reason, but cannot be picked: linking to it
              // would buy its whole process. The backend refuses it too (import_allocation_required).
              disabled={g.candidates.every((c) => c.allocation_required)}
              // What put it on the shortlist — including what the search read an abbreviation as.
              title={g.candidates[0].why || undefined}
            >
              {g.label}
            </option>
          ))}
          {row.target && !groups.some((g) => g.candidates.some((c) => c.code === row.target?.code)) ? (
            <option value={row.target.code}>{row.target.name || row.target.label}</option>
          ) : null}
        </select>
        {/* The region of a process stays up here, because it is a *choice* — a compartment is not,
            it is a property of the flow, and it reads better mirrored under the name. */}
        {isFlow ? null : regions.length > 1 ? (
          <select
            className={row.region_open ? 'region-pending' : undefined}
            value={row.region_open ? '' : (row.target?.code ?? '')}
            onChange={(e) =>
              e.target.value &&
              onPick({ database: row.target?.database ?? '', code: e.target.value, regionChosen: true })
            }
            title={
              row.region_open
                ? 'The source names no region, so this one is your call — the import cannot be committed until it is made'
                : 'Which region of this dataset'
            }
          >
            {row.region_open ? (
              // Not preselecting anything is the point: the file said nothing, and whichever region
              // stood here first was search order dressed as a decision.
              <option value="" disabled>
                Select region…
              </option>
            ) : null}
            {regions.map((c) => (
              <option key={c.code} value={c.code}>
                {c.location}
              </option>
            ))}
          </select>
        ) : row.target?.location ? (
          <span className="chip">{row.target.location}</span>
        ) : null}
        {why ? (
          <span className="imp-why" title={why} aria-label={why}>
            ⓘ
          </span>
        ) : null}
        <button
          className="imp-find"
          title={isFlow ? 'Search all elementary flows' : 'Search all processes'}
          onClick={() => setSearching((v) => !v)}
        >
          <SearchIcon />
        </button>
      </div>

      {/* Mirrors the source line above it — amount, unit, compartment — so the two can be read
          against each other. That is where the conversion becomes visible: the number on the left
          is what the file said, the number here is what lands in the database. */}
      {row.target ? (
        <div className={`imp-scale${row.scale ? ' assumed' : ''}`} title={row.scale || undefined}>
          {row.scaled_amount} {row.target.unit || 'no unit'}
          {row.target.categories?.length ? ` · ${row.target.categories.join(' / ')}` : ''}
          {factor === 1 ? '' : ` (× ${factor})`}
          {row.scale ? ' ⚠' : ''}
        </div>
      ) : null}
      {row.target && row.needs_assumption && onAssume ? (
        // Keyed by what the figure is about: another target (or another unit) starts empty instead of
        // offering the last target's density under new labels, and an answer from the backend
        // (a new note) re-reads what is now applied.
        <AssumptionInput
          key={`${row.target.database}|${row.target.code}|${row.target.unit}|${row.scale}`}
          row={row}
          onAssume={onAssume}
        />
      ) : null}

      {searching ? (
        <div className="imp-search">
          <input
            autoFocus
            placeholder={isFlow ? 'Find an elementary flow…' : 'Find a process…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void look()}
          />
          <button className="btn sm" disabled={looking || !query.trim()} onClick={() => void look()}>
            {looking ? '…' : 'Find'}
          </button>
          {found ? (
            <div className="imp-hits">
              {found.length === 0 ? <div className="settings-hint">Nothing found.</div> : null}
              {alsoSearchedAs(found) ? (
                <div className="settings-hint">Also searched as “{alsoSearchedAs(found)}”.</div>
              ) : null}
              {found.slice(0, 40).map((c) => (
                <button
                  key={`${c.database}/${c.code}`}
                  className="imp-hit"
                  title={c.why || undefined}
                  onClick={() => {
                    onPick({ database: c.database, code: c.code })
                    setSearching(false)
                    setFound(null)
                    setQuery('')
                  }}
                >
                  <span className="imp-hit-name">{c.name || c.label}</span>
                  <span className="settings-hint">
                    {c.categories?.length ? c.categories.join(' / ') : c.location}
                    {c.unit ? ` · ${c.unit}` : ''}
                    {c.treatment ? ' · treatment' : ''}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
