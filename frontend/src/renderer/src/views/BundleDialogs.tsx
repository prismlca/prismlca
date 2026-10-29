/**
 * Sending a model somewhere, and taking one in.
 *
 * Two sheets, and the asymmetry between them is deliberate. Export asks **what goes with it** before
 * it writes anything, because "Complete" carries the chat history and the audit log — the moment
 * somebody mails their client conversations by accident, and the only place to prevent it. Import
 * shows a **dry run** before it writes anything, because a background link that cannot be resolved is
 * something to look at rather than to discover afterwards.
 *
 * Neither sheet decides anything the backend does not: the presets, the section list and the whole
 * resolution report come from `/bundle/presets` and `/bundle/inspect`, so this file has no second
 * opinion to drift out of step.
 */
import type React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { api } from '../lib/api'
import { assignFolder, getFolders, reloadFolders, subscribeFolders } from '../lib/modelFolders'
import { bytesFromBase64, deliverBase64, deliverBytes, onDelivery, XLSX_MIME } from '../lib/download'
import { errMsg } from '../lib/errors'
import EscapeCloser from '../components/EscapeCloser'

/** The app's window furniture, as markup rather than as a component — there is no generic Sheet, and
 *  inventing one for two dialogs would mean touching ModelInfo and Settings to keep it honest. */
function Sheet(props: {
  title: string
  subtitle: string
  onClose: () => void
  footer: JSX.Element
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <EscapeCloser onClose={() => props.onClose()} />
      <div className="modal sheet bundle-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>{props.title}</h3>
            <p>{props.subtitle}</p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="settings-panel">{props.children}</div>
        <div className="sheet-foot">
          <div className="acts">{props.footer}</div>
        </div>
      </div>
    </div>
  )
}

interface SectionInfo {
  name: string
  schema: number
  required: boolean
  preset: string
}

/** Plain words for a section, since `graph`/`view` are our names for things, not the user's. */
const LABEL: Record<string, string> = {
  graph: 'The model itself — processes and their flows',
  library: 'The datasets from My processes the model draws on — your own data, carried in full',
  parameters: 'Parameters, formulas and their value rules',
  tags: 'Tags',
  scenarios: 'Scenarios',
  study: 'Goal & scope (the study metadata)',
  view: 'Canvas arrangement, colours and the results setup',
  reports: 'Report definitions',
  chats: 'Assistant conversations — including what they cost',
  audit: 'The change history of this model',
  research_log: 'Research log — the questions the assistant looked up and the sourced findings',
  review_log: 'Review log — what the internal reviews challenged and how each finding was resolved'
}

const PRESET_LABEL: Record<string, string> = {
  model: 'Model — everything the study is',
  full: 'Complete — plus conversations and history',
  graph: 'Graph only — processes and flows, without parameters, scenarios or reports'
}

/** The same sections in a few words, for the list of what a file holds. */
const SHORT: Record<string, string> = {
  graph: 'processes and flows',
  library: 'My processes datasets',
  parameters: 'parameters',
  tags: 'tags',
  scenarios: 'scenarios',
  study: 'goal & scope',
  view: 'canvas and results setup',
  reports: 'reports',
  chats: 'assistant conversations',
  audit: 'change history',
  research_log: 'research log',
  review_log: 'review log'
}

/** Offer the bytes as a download, and only claim "Saved" once the download itself says so.
 *  `setDone` used to fire the moment `click()` returned — before any save dialog was answered and
 *  regardless of the answer, the exact V157 lie the report pane had already been cured of. */
function offerAndReport(
  filename: string,
  base64: string,
  label: string,
  setDone: (v: string | null) => void,
  setError: (v: string | null) => void
): void {
  const off = onDelivery(filename, (d) => {
    off()
    if (d.state === 'completed') setDone(d.path || label)
    else setError(`The download did not finish (${d.state}).`)
  })
  deliverBase64(base64, filename, 'application/zip')
}

export function ExportBundleSheet({
  database,
  onClose
}: {
  database: string
  onClose: () => void
}): JSX.Element {
  const [sections, setSections] = useState<SectionInfo[]>([])
  const [presets, setPresets] = useState<Record<string, string[]>>({})
  const [preset, setPreset] = useState('model')
  const [picked, setPicked] = useState<string[] | null>(null) // null = follow the preset
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [loses, setLoses] = useState<string[]>([])

  useEffect(() => {
    void api<{ loses: string[] }>('GET', '/api/v1/interop/loses')
      .then((r) => setLoses(r.loses ?? []))
      .catch(() => setLoses([]))
    void api<{ presets: Record<string, string[]>; sections: SectionInfo[] }>('POST', '/api/v1/bundle/presets')
      .then((r) => {
        setPresets(r.presets)
        setSections(r.sections)
      })
      .catch((e) => setError(errMsg(e)))
  }, [])

  const include = picked ?? presets[preset] ?? []
  const has = (name: string): boolean => include.includes(name)
  const toggle = (name: string): void => {
    const next = has(name) ? include.filter((n) => n !== name) : [...include, name]
    setPicked(next)
  }

  /** The Brightway/Excel route. Its loss list comes from the backend, next to the exporter, so the
   *  two cannot drift — a dialog that under-reports what it drops is worse than no dialog. */
  const sheet = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.prism.api('GET', `/api/v1/interop/model/${encodeURIComponent(database)}`)
      if (r.status >= 400) throw new Error(`The spreadsheet could not be written (HTTP ${r.status}).`)
      // The XLSX endpoint answers with bytes; the bridge hands a binary answer over as base64 (it
      // used to pass through a UTF-8-decoded string, which cannot carry a ZIP).
      const raw = r.body as { binary?: boolean; base64?: string } | null
      if (!raw?.base64) throw new Error('The spreadsheet came back in an unexpected shape.')
      const bytes = bytesFromBase64(raw.base64)
      const filename = `${database}_model.xlsx`
      const off = onDelivery(filename, (d) => {
        off()
        if (d.state === 'completed') setDone(d.path || filename)
        else setError(`The download did not finish (${d.state}).`)
      })
      deliverBytes(bytes, filename, XLSX_MIME)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ filename: string; base64: string; bytes: number }>(
        'POST',
        '/api/v1/bundle/export',
        { database, include }
      )
      offerAndReport(
        r.filename,
        r.base64,
        `${r.filename} — ${(r.bytes / 1024).toFixed(0)} kB`,
        setDone,
        setError
      )
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={`Export ${database}`}
      subtitle="A .prism file: your model, and references to the background data it uses."
      onClose={onClose}
      footer={
        <>
          <span className="settings-hint" style={{ margin: 0 }}>
            {done ? `Saved ${done}` : `${include.length} section${include.length === 1 ? '' : 's'}`}
          </span>
          <button className="btn sm" onClick={onClose}>
            Close
          </button>
          <button className="btn sm primary" disabled={busy || !include.length} onClick={() => void run()}>
            {busy ? 'Packing…' : 'Export'}
          </button>
        </>
      }
    >
      {error ? <p className="settings-hint bad">{error}</p> : null}
      <h4>What it is for</h4>
      {Object.keys(PRESET_LABEL)
        .filter((p) => presets[p])
        .map((p) => (
          <label className="settings-field settings-check" key={p}>
            <input
              type="radio"
              name="bundle-preset"
              checked={preset === p}
              onChange={() => {
                setPreset(p)
                setPicked(null)
                setDone(null)
              }}
            />
            <span>{PRESET_LABEL[p]}</span>
          </label>
        ))}
      {has('chats') || has('audit') ? (
        <p className="settings-notice">
          This includes{' '}
          {has('chats') ? (
            <>
              your <strong>assistant conversations and what they cost</strong>
            </>
          ) : null}
          {has('chats') && has('audit') ? ', and ' : null}
          {has('audit') ? (
            <>
              the model&rsquo;s <strong>change history in plain text</strong>
            </>
          ) : null}
          . Useful for your own archive or a move to another machine — think twice before sending it to a
          client.
        </p>
      ) : null}

      <h4>What goes with it</h4>
      {sections.map((s) => (
        <label className="settings-field settings-check" key={s.name}>
          <input
            type="checkbox"
            checked={has(s.name)}
            disabled={s.required}
            onChange={() => {
              toggle(s.name)
              setDone(null)
            }}
          />
          <span>
            {LABEL[s.name] ?? s.name}
            {s.required ? ' (always)' : ''}
          </span>
        </label>
      ))}
      <p className="settings-hint">
        Background datasets are never copied — the file references them, so it stays small and carries no
        licensed data; the recipient needs the same ecoinvent or BAFU version.{' '}
        {has('library')
          ? 'Your own datasets from My processes that the model uses travel with it.'
          : 'Your own datasets from My processes stay behind — the recipient must already have them.'}
      </p>

      <h4>For Brightway or the Activity Browser</h4>
      <p className="settings-hint">
        A two-sheet spreadsheet instead, readable by Brightway and the Activity Browser. It carries the
        processes, their flows, the formulas on amounts, the uncertainty distributions, the comments and the
        tags — and leaves behind{' '}
        {loses.length ? loses.join(', ').toLowerCase() : 'everything a spreadsheet cannot hold'}.
      </p>
      <button className="btn sm" disabled={busy} onClick={() => void sheet()}>
        Export as a spreadsheet
      </button>
    </Sheet>
  )
}

interface Reference {
  database: string
  code: string
  name: string
  verdict: string
  detail: string
}

interface Inspection {
  manifest: { written_by?: string; format?: number }
  sections: string[]
  unreadable_sections: string[]
  /** Newer shapes of sections this version knows: cannot be read, so not imported. */
  newer_sections?: string[]
  /** The user's own datasets travelling with the model (landed in My processes on import). */
  library?: { datasets: number; present: number; new: number }
  model: {
    name: string
    /** What the import will actually call it — `name` plus a suffix when that one is taken. */
    suggested_name: string
    name_taken: boolean
    activities: number
    exchanges: number
  }
  references: Reference[]
  summary: { total: number; resolved: number; can_import: boolean; counts: Record<string, number> }
}

export function ImportBundleSheet({
  onClose,
  onImported
}: {
  onClose: () => void
  /** `renamed`: 'deviated' = the import used a name other than the one in the field; 'collision' = the
   *  field still held the suggested stand-in because the bundle's own name was taken; null = the user's
   *  own name, nothing to explain (V340). */
  onImported: (database: string, renamed: 'deviated' | 'collision' | null) => void
}): JSX.Element {
  const [content, setContent] = useState<string | null>(null)
  const [filename, setFilename] = useState('')
  const [look, setLook] = useState<Inspection | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The second way in: the two-sheet spreadsheet "Export as a spreadsheet" writes (interop/model/import).
  const [sheet, setSheet] = useState<{ content: string; filename: string } | null>(null)
  const [sheetName, setSheetName] = useState('')
  // Imported, but with formulas whose parameters a spreadsheet cannot carry: said before the jump.
  const [sheetDone, setSheetDone] = useState<{ database: string; unresolved: string } | null>(null)
  // A bundle arrives with no idea where it belongs, and the moment to say is now — an import that
  // lands unfiled among forty models is one the person has to go and find again.
  const { folders } = useSyncExternalStore(subscribeFolders, getFolders)
  const [folder, setFolder] = useState('')
  useEffect(() => {
    void reloadFolders()
  }, [])

  const pick = async (file: File): Promise<void> => {
    setBusy(true)
    setError(null)
    setLook(null)
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      let bin = ''
      for (const byte of buf) bin += String.fromCharCode(byte)
      const b64 = btoa(bin)
      setContent(b64)
      setFilename(file.name)
      // Look before touching anything: this call writes nothing, by design.
      const r = await api<Inspection>('POST', '/api/v1/bundle/inspect', { content: b64 })
      setLook(r)
      // The name the import will really use. Prefilling the bundle's own name made a collision
      // invisible: the field showed a name that was already taken, and the import then quietly
      // renamed.
      setName(r.model.suggested_name || r.model.name)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const pickSheet = async (file: File): Promise<void> => {
    setError(null)
    const buf = new Uint8Array(await file.arrayBuffer())
    let bin = ''
    for (const byte of buf) bin += String.fromCharCode(byte)
    setSheet({ content: btoa(bin), filename: file.name })
    setSheetName(file.name.replace(/\.xlsx$/i, ''))
  }

  const runSheet = async (): Promise<void> => {
    if (!sheet || !sheetName.trim()) return
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ database: string; formulas_unresolved?: string }>(
        'POST',
        '/api/v1/interop/model/import',
        { name: sheetName.trim(), content: sheet.content }
      )
      if (folder) await assignFolder(r.database, folder)
      if (r.formulas_unresolved) setSheetDone({ database: r.database, unresolved: r.formulas_unresolved })
      else onImported(r.database, null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const run = async (): Promise<void> => {
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ database: string; applied: string[] }>('POST', '/api/v1/bundle/import', {
        content,
        name: name.trim() || null
      })
      if (folder) await assignFolder(r.database, folder)
      // Say what was created before jumping into it. Opening a model silently is how a rename goes
      // unnoticed — the user then cannot tell an import from an overwrite.
      const asked = name.trim() || look?.model.name || ''
      const suggested = look?.model.suggested_name || look?.model.name || ''
      onImported(
        r.database,
        r.database !== asked
          ? 'deviated'
          : asked === suggested && suggested !== (look?.model.name ?? '')
            ? 'collision'
            : null
      )
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  // Once a spreadsheet import has gone through, leaving the sheet any way at all must hand the new model
  // over — Close, Escape and the backdrop included — or the model list never learns it exists.
  const close = (): void => (sheetDone ? onImported(sheetDone.database, null) : onClose())

  const unresolved = (look?.references ?? []).filter(
    (r) => !['exact', 'relinked', 'matched'].includes(r.verdict)
  )

  return (
    <Sheet
      title="Import a model"
      subtitle="A .prism file from PrismLCA, or the spreadsheet its export writes. Nothing is written until you say so."
      onClose={close}
      footer={
        <>
          <span className="settings-hint" style={{ margin: 0 }}>
            {look ? `${look.model.activities} processes, ${look.summary.total} background links` : ''}
          </span>
          <button className="btn sm" onClick={close}>
            Close
          </button>
          <button
            className="btn sm primary"
            disabled={busy || !look || !look.summary.can_import}
            onClick={() => void run()}
          >
            {busy ? 'Working…' : 'Import'}
          </button>
        </>
      }
    >
      {error ? <p className="settings-hint bad">{error}</p> : null}
      <label className="settings-field settings-key">
        <span>Bundle file</span>
        <input
          type="file"
          accept=".prism,application/zip"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void pick(f)
          }}
        />
      </label>
      {filename && !look && busy ? <p className="settings-hint">Reading {filename}…</p> : null}

      {look ? (
        <>
          <h4>What is in it</h4>
          <label className="settings-field settings-key">
            <span>Import as</span>
            <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
          </label>
          {/* Beside the name, because both answer the same question: what will this be called and
              where will it be. Filing it now is the difference between an import you can find
              again and one you have to go looking for. */}
          <label className="settings-field settings-key">
            <span>Folder</span>
            <select value={folder} onChange={(e) => setFolder(e.target.value)}>
              <option value="">— not in a folder —</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-hint">
            {look.model.activities} processes and {look.model.exchanges} flows, written by PrismLCA{' '}
            {look.manifest.written_by ?? '—'}. It holds: {look.sections.map((s) => SHORT[s] ?? s).join(', ')}.
          </p>
          {look.model.name_taken ? (
            <p className="settings-notice">
              You already have a model called <strong>{look.model.name}</strong>. This will be imported as a{' '}
              <strong>second, separate model</strong> — nothing about the existing one is touched, and the two
              are never merged (there is no answer to which of two identical parameters should win). Rename it
              above if you want a name of your own; to replace the old model, delete it first.
            </p>
          ) : null}
          {look.unreadable_sections.length ? (
            <p className="settings-hint">
              Written by a newer PrismLCA than this one: {look.unreadable_sections.join(', ')}. Those parts
              are kept unchanged with the model rather than dropped, so a later version can still read them.
            </p>
          ) : null}
          {look.newer_sections?.length ? (
            <p className="settings-notice">
              In a newer format than this version of PrismLCA reads:{' '}
              {look.newer_sections.map((s) => SHORT[s] ?? s).join(', ')}. These parts are{' '}
              <strong>not imported</strong> — update PrismLCA and import the file again to bring them in.
            </p>
          ) : null}

          {look.library?.datasets ? (
            <p className="settings-hint">
              {look.library.datasets} dataset{look.library.datasets === 1 ? '' : 's'} from the sender&rsquo;s{' '}
              <strong>My processes</strong> travel with the model and land in yours as one import
              {look.library.present
                ? ` — ${look.library.present} of them ${look.library.present === 1 ? 'is' : 'are'} already here and ${look.library.present === 1 ? 'is' : 'are'} kept as ${look.library.present === 1 ? 'it is' : 'they are'}`
                : ''}
              .
            </p>
          ) : null}

          <h4>Background data</h4>
          {look.summary.can_import ? (
            <p className="settings-hint ok">All {look.summary.total} background references resolve here.</p>
          ) : (
            <>
              <p className="settings-hint bad">
                {unresolved.length} of {look.summary.total} references cannot be resolved here, so nothing can
                be imported. Import the file into a workspace with the background data the model was built on
                — the same ecoinvent or BAFU version.
              </p>
              <div className="audit-list">
                {unresolved.slice(0, 12).map((r) => (
                  <div className="aud" key={`${r.database}/${r.code}`}>
                    <span className="aud-src">{r.verdict}</span>
                    <span>
                      {r.name || r.code} — {r.detail}
                    </span>
                  </div>
                ))}
              </div>
              {unresolved.length > 12 ? (
                <p className="settings-hint">…and {unresolved.length - 12} more.</p>
              ) : null}
            </>
          )}
        </>
      ) : null}

      {/* Not a .prism: the spreadsheet PrismLCA's own export writes. It carries less (no parameters,
          scenarios, study metadata or reports — see the export sheet), so it is the second way in, below. */}
      {!look ? (
        <>
          <h4>Or: a spreadsheet</h4>
          <p className="settings-hint">
            The two-sheet .xlsx that <strong>Export as a spreadsheet</strong> writes becomes a new model:
            processes, flows, formulas, distributions, comments and tags. Inputs from background databases
            must exist in this workspace; if one does not, nothing is created.
          </p>
          <label className="settings-field settings-key">
            <span>Spreadsheet</span>
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void pickSheet(f)
              }}
            />
          </label>
          {sheetDone ? (
            <>
              <p className="settings-notice">
                Imported as <strong>{sheetDone.database}</strong>. Some amounts are formulas that name
                parameters a spreadsheet cannot bring along ({sheetDone.unresolved}). They keep the amounts
                from the export until you create those parameters on the Parameters page — or import the model
                as a .prism file, which carries them.
              </p>
              <button className="btn sm primary" onClick={() => onImported(sheetDone.database, null)}>
                Open the model
              </button>
            </>
          ) : sheet ? (
            <>
              <label className="settings-field settings-key">
                <span>Import as</span>
                <input value={sheetName} onChange={(e) => setSheetName(e.target.value)} spellCheck={false} />
              </label>
              <button
                className="btn sm primary"
                disabled={busy || !sheetName.trim()}
                onClick={() => void runSheet()}
              >
                {busy ? 'Working…' : 'Import spreadsheet'}
              </button>
            </>
          ) : null}
        </>
      ) : null}
    </Sheet>
  )
}
