/**
 * Pick the models this one is compared with. The same folders as the Overview, but rows instead of
 * cards — a name, its functional unit if it has one, the process count — and a tick per row. A tick
 * links at once and on both sides (`linkModels`), an untick unlinks: there is nothing to save, only
 * to close. Reached from the chat's "+" menu and from the model's Info dialog.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import EscapeCloser from './EscapeCloser'
import { ChevronIcon, FolderIcon, LinkIcon } from './icons'
import { getFolders, reloadFolders, subscribeFolders } from '../lib/modelFolders'
import { linkModels, unlinkModels, useComparedWith } from '../lib/comparison'
import { fetchQuery, useQuery } from '../lib/server/useQuery'
import { studyRoute } from '../lib/server/routes'
import { errMsg } from '../lib/errors'
import { fmtInt } from '../lib/format'

const UNSORTED = '__unsorted__'

export default function ComparisonPicker(props: { database: string; onClose: () => void }): JSX.Element {
  const { database, onClose } = props
  const { data: databases } = useQuery('/api/v1/databases')
  const { folders, of } = useSyncExternalStore(subscribeFolders, getFolders)
  const linked = useComparedWith(database)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [units, setUnits] = useState<Record<string, string>>({})

  useEffect(() => {
    void reloadFolders()
  }, [])

  const models = useMemo(
    () => (databases ?? []).filter((d) => d.kind === 'foreground' && d.name !== database),
    [databases, database]
  )
  // The functional unit as the one-line hint under a name: it is what decides whether two models
  // can be compared at all. Read through the cache, so a model already opened costs nothing.
  const modelKey = JSON.stringify(models.map((m) => m.name))
  useEffect(() => {
    let alive = true
    const names = JSON.parse(modelKey) as string[]
    void Promise.all(
      names.map(async (name) => {
        const meta = (await fetchQuery(studyRoute(name)).catch(() => ({}))) as Record<string, unknown>
        const fu = typeof meta.functional_unit === 'string' ? meta.functional_unit : ''
        return [name, fu] as const
      })
    ).then((pairs) => {
      if (alive) setUnits(Object.fromEntries(pairs))
    })
    return () => {
      alive = false
    }
  }, [modelKey])

  const q = query.trim().toLowerCase()
  const shown = q ? models.filter((m) => m.name.toLowerCase().includes(q)) : models
  const groups = [
    ...folders.map((f) => ({ id: f.id, name: f.name, models: shown.filter((m) => of[m.name] === f.id) })),
    { id: UNSORTED, name: 'Unsorted', models: shown.filter((m) => !of[m.name]) }
  ].filter((g) => g.models.length || (!q && g.id !== UNSORTED))

  const toggle = async (name: string): Promise<void> => {
    setErr(null)
    setBusy(name)
    try {
      if (linked.includes(name)) await unlinkModels(database, name)
      else await linkModels(database, name)
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={onClose} />
      <div className="modal sheet cmp-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>
              <LinkIcon /> Comparison models
            </h3>
            <p>
              Tick the models <b>{database}</b> will be compared with on the Results page. The assistant in
              each model’s chat is then briefed on the other — functional unit, boundaries, tag vocabulary,
              shared assumptions — and keeps the two consistent. The link works both ways and applies at once.
            </p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cmp-body">
          <input
            className="cmp-search"
            placeholder="Find a model…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          {!databases ? <p className="rail-note">Loading…</p> : null}
          {databases && !models.length ? (
            <p className="rail-note">No other model in this workspace yet.</p>
          ) : null}
          {databases && models.length && !shown.length ? (
            <p className="rail-note">No model matches “{query}”.</p>
          ) : null}
          {groups.map((g) => {
            const expanded = !!q || open.includes(g.id) || g.id === UNSORTED
            return (
              <div className="cmp-folder" key={g.id}>
                {g.id !== UNSORTED ? (
                  <button
                    className="cmp-folder-h"
                    onClick={() =>
                      setOpen((o) => (o.includes(g.id) ? o.filter((x) => x !== g.id) : [...o, g.id]))
                    }
                    aria-expanded={expanded}
                  >
                    <span className={`ov-folder-toggle${expanded ? ' open' : ''}`}>
                      <ChevronIcon />
                    </span>
                    <FolderIcon />
                    {g.name}
                    <span className="cmp-count">{g.models.length}</span>
                  </button>
                ) : folders.length ? (
                  <div className="cmp-folder-h muted">Unsorted</div>
                ) : null}
                {expanded
                  ? g.models.map((m) => {
                      const on = linked.includes(m.name)
                      return (
                        <button
                          key={m.name}
                          className={`cmp-row${on ? ' on' : ''}`}
                          role="checkbox"
                          aria-checked={on}
                          disabled={busy !== null}
                          onClick={() => void toggle(m.name)}
                        >
                          <span className="cmp-check" aria-hidden="true">
                            {on ? '✓' : ''}
                          </span>
                          <span className="cmp-text">
                            <span className="cmp-name">{m.name}</span>
                            {units[m.name] ? <span className="cmp-fu">{units[m.name]}</span> : null}
                          </span>
                          <span className="cmp-meta">
                            {fmtInt(m.node_count)} {m.node_count === 1 ? 'process' : 'processes'}
                          </span>
                        </button>
                      )
                    })
                  : null}
              </div>
            )
          })}
          {err ? <p className="ov-folder-err">{err}</p> : null}
        </div>
        <div className="sheet-foot">
          <span className="meta">
            {linked.length ? `${linked.length} linked` : 'Nothing linked yet'} · changes apply immediately
          </span>
          <div className="acts">
            <button className="btn primary" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
