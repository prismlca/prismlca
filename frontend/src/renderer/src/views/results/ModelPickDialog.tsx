import { useEffect, useState } from 'react'
import { api, type DatabaseInfo } from '../../lib/api'
import { errMsg } from '../../lib/errors'
import EscapeCloser from '../../components/EscapeCloser'
import type { ModelSubject } from './types'

/** A model's reference process as `/model/reference` ranks it — the first candidate, which this page,
 *  the detailed tree and the report also take for the open model. */
interface Root {
  code: string
  name: string
  product?: string | null
  location?: string | null
  unit?: string | null
}

/**
 * Adds another model to the comparison. A model is compared by its reference process, the one the rest
 * of the model feeds, so the dialog shows that process and only asks to confirm it. Offering every
 * process of the other model invited comparing a whole product with somebody else's sub-assembly; the
 * parts of the open model stay addable one by one ("+ Add from this model"), where that is deliberate.
 */
function ModelPickDialog({
  databases,
  activeDb,
  existing,
  onPick,
  onClose
}: {
  databases: DatabaseInfo[]
  activeDb: string | null
  existing: ModelSubject[]
  onPick: (s: ModelSubject) => void
  onClose: () => void
}): JSX.Element {
  const models = databases.filter((d) => d.kind === 'foreground' && d.name !== activeDb)
  // Open on a model that is not in the comparison yet: the first one usually is, after one add.
  const [model, setModel] = useState(
    () => (models.find((d) => !existing.some((x) => x.database === d.name)) ?? models[0])?.name ?? ''
  )
  // Keyed by model, so a switch shows "loading" instead of the previous model's process for a moment.
  const [found, setFound] = useState<{ model: string; root: Root | null; err?: string } | null>(null)
  useEffect(() => {
    if (!model) return
    let alive = true
    void api<{ candidates?: Root[] }>('GET', `/api/v1/model/reference/${encodeURIComponent(model)}`)
      .then((r) => alive && setFound({ model, root: r.candidates?.[0] ?? null }))
      .catch((e) => alive && setFound({ model, root: null, err: errMsg(e) }))
    return () => {
      alive = false
    }
  }, [model])
  const current = found?.model === model ? found : null
  const root = current?.root ?? null
  const added = !!root && existing.some((x) => x.database === model && x.code === root.code)
  const meta = root
    ? [root.product !== root.name ? root.product : null, root.location, root.unit].filter(Boolean).join(' · ')
    : ''
  const add = (): void => {
    if (!root || added) return
    onPick({ database: model, code: root.code, name: root.name })
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={() => onClose()} />
      <div className="modal sheet search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>Add another model</h3>
            <p>A model is compared by its reference process, the one everything else in it feeds.</p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">
          {models.length ? (
            <>
              <div className="srow">
                <select
                  className="search-sel"
                  aria-label="Model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {models.map((d) => (
                    <option key={d.name} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
              {!current ? (
                <p className="empty">Finding the reference process…</p>
              ) : current.err ? (
                <p className="empty">{current.err}</p>
              ) : root ? (
                <div className="modelpick-ref" title={`${root.name} · ${model}`}>
                  <span className="modelpick-ref-label">Reference process</span>
                  <span className="modelpick-ref-name">{root.name}</span>
                  {meta ? <span className="modelpick-ref-meta">{meta}</span> : null}
                </div>
              ) : (
                <p className="empty">This model has no processes yet.</p>
              )}
            </>
          ) : (
            <p className="empty">There is no other model in this workspace yet.</p>
          )}
        </div>
        <div className="sheet-foot">
          <div className="acts">
            <button className="btn sm" onClick={onClose}>
              Cancel
            </button>
            <button className="btn sm primary" disabled={!root || added} onClick={add}>
              {added ? 'Already added' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ModelPickDialog
