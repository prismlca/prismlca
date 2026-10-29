import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useSettings, fmtSig } from '../lib/settings'
import { LockIcon } from '../components/icons'
import { errMsg } from '../lib/errors'
import { parseAmount } from '../lib/numberFormat'
import EscapeCloser from '../components/EscapeCloser'
import { IdleRoundedInput } from '../components/IdleRoundedInput'
import UnitCombo from '../components/UnitCombo'

/**
 * Flow-properties window for a process's reference product (ecoinvent product properties:
 * carbon content, dry mass, price, heating value, …). Background (ecoinvent) products are shown
 * read-only; foreground products are editable, but each property must stay consistent with the
 * ecoinvent vocabulary (a known property name fixes its unit) — enforced by the backend too.
 *
 * Write-through, no Save button: adding or removing a property writes at once, an amount writes on
 * blur or Enter. The endpoint takes the whole list, so every write sends the whole current list.
 */
interface PropEntry {
  amount: number | null
  unit: string | null
  comment?: string
}
interface PropsResponse {
  product: string | null
  unit: string | null
  read_only: boolean
  properties: Record<string, PropEntry>
}
interface VocabItem {
  name: string
  unit: string
}
interface Row {
  /** The stored value, kept exact while the row is untouched: saving used to write the rounded
   *  display string back over every property, edited or not. Present = the row shows it rounded. */
  raw?: number
  name: string
  /** The text in the field: the full stored number, or what is being typed. */
  amount: string
  unit: string | null
  comment?: string
}

/** The rows as the endpoint wants them: the whole list, every time. */
function toProps(rows: Row[]): Record<string, PropEntry> {
  const properties: Record<string, PropEntry> = {}
  for (const r of rows) {
    properties[r.name] = {
      // `parseAmount`, not `Number`: a property typed as "0,5" was a 5 on a machine whose
      // locale the browser read as English. An untouched row keeps its stored value exactly.
      amount: r.raw ?? parseAmount(r.amount) ?? 0,
      unit: r.unit,
      ...(r.comment ? { comment: r.comment } : {})
    }
  }
  return properties
}

export default function FlowProperties({
  database,
  code,
  onClose,
  onChanged
}: {
  database: string
  code: string
  onClose: () => void
  onChanged: () => void
}): JSX.Element {
  const { round } = useSettings()
  const [data, setData] = useState<PropsResponse | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [vocab, setVocab] = useState<VocabItem[]>([])
  const [addName, setAddName] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Writes run one after the other, so a quick add-then-delete cannot land in the wrong order.
  const queue = useRef<Promise<void>>(Promise.resolve())
  // The list as last sent (or loaded): a blur that changed nothing sends nothing.
  const sent = useRef('')
  // The list the backend last CONFIRMED (or loaded). Only a confirmed list turns typed rows back into
  // stored ones — `sent` includes a write still in flight, which may yet fail.
  const acked = useRef('')
  // Writes queued and not yet answered. Rows settle only when the write confirming them is the LAST one
  // queued: any confirmation says nothing about a later write still on its way — A, then B, then A again,
  // and if B lands and the second A fails, the model holds B whatever the first A said.
  const inFlight = useRef(0)

  const load = useCallback(async () => {
    const d = await api<PropsResponse>(
      'GET',
      `/api/v1/model/activities/${encodeURIComponent(database)}/${encodeURIComponent(code)}/properties`
    )
    const loaded: Row[] = Object.entries(d.properties)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, p]) => ({
        name,
        amount: p.amount == null ? '' : String(p.amount),
        raw: p.amount ?? undefined,
        unit: p.unit,
        comment: p.comment
      }))
    setData(d)
    sent.current = JSON.stringify(toProps(loaded))
    acked.current = sent.current
    setRows(loaded)
    if (!d.read_only) {
      try {
        const v = await api<{ properties: VocabItem[] }>('GET', '/api/v1/model/property-vocabulary')
        setVocab(v.properties)
      } catch {
        setVocab([])
      }
    }
  }, [database, code])

  useEffect(() => {
    setError(null)
    void load().catch((e) => setError(errMsg(e)))
  }, [load])

  const ro = data?.read_only ?? true
  const used = new Set(rows.map((r) => r.name))
  const addable = vocab.filter((v) => !used.has(v.name))
  const unitOf = useMemo(() => new Map(vocab.map((v) => [v.name, v.unit])), [vocab])

  // Sends `next` as the full property list. Unreadable text is refused, not saved as 0.
  // What is stored now reads rounded again: a typed row whose text is the amount that went out takes it
  // as its stored value. A row typed into since keeps its text.
  // `submitted` is each typed row's text as it went out. A row settles only while it still reads exactly
  // that: Enter writes without leaving the field, and "1." typed after submitting "1" parses to the same
  // number — a numeric match would have swallowed the decimal point mid-edit.
  const settle = (properties: Record<string, PropEntry>, submitted: Record<string, string>): void =>
    setRows((rs) =>
      rs.map((r) => {
        const stored = properties[r.name]?.amount
        return r.raw === undefined && stored != null && submitted[r.name] === r.amount
          ? { ...r, raw: stored, amount: String(stored) }
          : r
      })
    )

  const persist = (next: Row[]): void => {
    const bad = next.find((r) => r.raw === undefined && parseAmount(r.amount) === null)
    if (bad) {
      setError(`"${bad.name}" is not a number — use 0.5 or 0,5.`)
      return
    }
    const properties = toProps(next)
    const body = JSON.stringify(properties)
    const submitted = Object.fromEntries(
      next.filter((r) => r.raw === undefined).map((r) => [r.name, r.amount])
    )
    if (body === sent.current) {
      setError(null)
      // Nothing new to send. Settle only if this list is confirmed; a write still in flight settles the
      // rows itself when it succeeds, and leaves them as typed when it fails.
      if (body === acked.current && inFlight.current === 0) settle(properties, submitted)
      return
    }
    sent.current = body
    inFlight.current += 1
    queue.current = queue.current.then(async () => {
      try {
        await api('POST', '/api/v1/model/properties', { database, code, properties })
        acked.current = body
        setError(null)
        if (inFlight.current === 1) settle(properties, submitted) // this one, and nothing after it
        onChanged()
      } catch (e) {
        sent.current = ''
        setError(`Not saved: ${errMsg(e)}`)
      } finally {
        inFlight.current -= 1
      }
    })
  }

  const addProperty = (name: string): void => {
    const item = vocab.find((v) => v.name === name)
    if (!item || used.has(item.name)) return
    const next = [...rows, { name: item.name, amount: '0', unit: item.unit }]
    setRows(next)
    setAddName('')
    persist(next)
  }

  const removeProperty = (i: number): void => {
    const next = rows.filter((_, j) => j !== i)
    setRows(next)
    persist(next)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={() => onClose()} />
      <div className="modal sheet props-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>Flow properties</h3>
            <p className="props-sub">
              {data?.product ?? code}
              {data?.unit ? <span className="props-unit">per {data.unit}</span> : null}
              <span className={`props-badge ${ro ? 'ro' : 'ed'}`}>
                {ro ? (
                  <>
                    <LockIcon /> read-only
                  </>
                ) : (
                  'editable'
                )}
              </span>
            </p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">
          {!data ? (
            <p className="empty">{error ?? 'Loading…'}</p>
          ) : rows.length === 0 && ro ? (
            <p className="empty">This product has no flow properties.</p>
          ) : (
            <div className="props-table">
              <div className="props-row props-head">
                <span>Property</span>
                <span>Amount</span>
                <span>Unit</span>
                <span />
              </div>
              {rows.map((r, i) => (
                <div className="props-row" key={r.name}>
                  <span className="props-name" title={r.comment}>
                    {r.name}
                    {r.comment ? (
                      <span className="props-note" title={r.comment}>
                        ⓘ
                      </span>
                    ) : null}
                  </span>
                  {ro ? (
                    <span className="props-amt ro" title={r.amount}>
                      {r.raw === undefined ? r.amount : fmtSig(r.raw, round.properties)}
                    </span>
                  ) : (
                    <IdleRoundedInput
                      idle={r.raw === undefined ? null : fmtSig(r.raw, round.properties)}
                      className={`props-amt${r.amount.trim() && parseAmount(r.amount) === null ? ' refused' : ''}`}
                      type="text"
                      inputMode="decimal"
                      aria-invalid={r.amount.trim() && parseAmount(r.amount) === null ? true : undefined}
                      title={
                        r.amount.trim() && parseAmount(r.amount) === null
                          ? 'Not a number — use 0.5 or 0,5'
                          : undefined
                      }
                      value={r.amount}
                      onChange={(e) =>
                        setRows((rs) =>
                          rs.map((x, j) => (j === i ? { ...x, amount: e.target.value, raw: undefined } : x))
                        )
                      }
                      onBlur={() => persist(rows)}
                      onKeyDown={(e) => e.key === 'Enter' && persist(rows)}
                    />
                  )}
                  <span className="props-unit-cell">{r.unit}</span>
                  {ro ? (
                    <span />
                  ) : (
                    <button className="props-del" title="Remove property" onClick={() => removeProperty(i)}>
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {!ro && data ? (
            <div className="props-add">
              {/* The whole vocabulary, scrolling; choosing a property adds it. */}
              <UnitCombo
                value={addName}
                units={addable.map((v) => v.name)}
                describe={(name) => unitOf.get(name)}
                max={Infinity}
                ariaLabel="Add property"
                placeholder="Add property… (type to find)"
                onChange={setAddName}
                onPick={addProperty}
              />
              <button
                className="btn sm"
                onClick={() => addProperty(addName)}
                disabled={!vocab.some((v) => v.name === addName)}
              >
                Add
              </button>
            </div>
          ) : null}

          {error && data ? <p className="settings-hint bad">{error}</p> : null}
        </div>
      </div>
    </div>
  )
}
