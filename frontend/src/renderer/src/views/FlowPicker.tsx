import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { fetchQuery } from '../lib/server/useQuery'
import { useSettings } from '../lib/settings'
import UnitCombo from '../components/UnitCombo'
import { errMsg } from '../lib/errors'
import { parseAmount } from '../lib/numberFormat'
import EscapeCloser from '../components/EscapeCloser'

/**
 * Add an input/output flow to a foreground process. You pick from the EXISTING elementary
 * (biosphere) flows — filtered to the tab's direction (inputs = resources drawn from nature,
 * outputs = emissions released to nature). For inputs you may also create your own PRODUCT flow
 * (a new foreground product); its unit must be chosen from the existing units. Own elementary
 * flows are never created — that vocabulary is fixed.
 */
interface Flow {
  database: string
  code: string
  name: string
  unit: string | null
  categories: string[]
  direction: 'input' | 'output'
}

interface Existing {
  uid: string
  type: string
  amount: number
  input: { database: string; code: string }
}

export default function FlowPicker({
  database,
  code,
  direction,
  existing,
  onClose,
  onAdded
}: {
  database: string
  code: string
  direction: 'input' | 'output'
  existing: Existing[]
  onClose: () => void
  onAdded: () => void
}): JSX.Element {
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [q, setQ] = useState('')
  const [flows, setFlows] = useState<Flow[]>([])
  const [sel, setSel] = useState<Flow | null>(null)
  const [amount, setAmount] = useState('1')
  const [units, setUnits] = useState<string[]>([])
  // Settings → Modelling: hybrid mode turns the strict unit dropdown into an editable combo.
  const {
    modelling: { freeUnits }
  } = useSettings()
  const [newName, setNewName] = useState('')
  const [newUnit, setNewUnit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Debounced elementary-flow search, scoped to the direction.
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      void (async () => {
        try {
          const r = await api<{ flows: Flow[] }>(
            'GET',
            `/api/v1/model/flows?direction=${direction}&query=${encodeURIComponent(q)}&limit=60`
          )
          if (alive) setFlows(r.flows)
        } catch (e) {
          if (alive) setError(errMsg(e))
        }
      })()
    }, 160)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [q, direction])

  // Units to choose from (product-flow creation only).
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetchQuery('/api/v1/model/unit-vocabulary')
        setUnits(r.units)
        setNewUnit((u) => u || (r.units.includes('kilogram') ? 'kilogram' : (r.units[0] ?? '')))
      } catch {
        /* leave empty */
      }
    })()
  }, [])

  const wrap = (fn: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        await fn()
        onAdded()
        onClose()
      } catch (e) {
        setError(errMsg(e))
        setBusy(false)
      }
    })()
  }

  // An identical flow already on this process (same flow, same biosphere type) → offer to merge.
  const dupOf = (f: Flow | null): Existing | undefined =>
    f
      ? existing.find(
          (e) => e.type === 'biosphere' && e.input.database === f.database && e.input.code === f.code
        )
      : undefined
  const dup = dupOf(sel)

  // The typed amount, read once for the dialog. `Number(amount) || 0` was the same bug twice over: a
  // comma dropped by the browser turned 0,5 into 5, and anything it could not read added the flow
  // with an amount of zero instead of saying so. `null` here means "not a number" and blocks the add.
  const amt = parseAmount(amount)
  const amtBad = amount.trim() !== '' && amt === null

  // Takes the flow rather than reading `sel`: a double-click adds the row it lands on, and the click
  // before it has set `sel` only for the next render.
  const addExisting = (f: Flow | null): void => {
    if (!f) return
    wrap(async () => {
      await api('POST', '/api/v1/model/exchanges', {
        activity_database: database,
        activity_code: code,
        input_database: f.database,
        input_code: f.code,
        amount: amt ?? 0,
        type: 'biosphere'
      })
    })
  }

  const mergeExisting = (): void => {
    if (!sel || !dup) return
    wrap(async () => {
      await api('POST', '/api/v1/model/exchanges/amount', {
        activity_database: database,
        activity_code: code,
        uid: dup.uid,
        amount: dup.amount + (amt ?? 0)
      })
    })
  }

  const createProduct = (): void => {
    const name = newName.trim()
    if (!name || !newUnit) return
    wrap(async () => {
      const res = await api<{ activity: { code: string } }>('POST', '/api/v1/model/activities', {
        database,
        name,
        product: name,
        unit: newUnit
      })
      await api('POST', '/api/v1/model/exchanges', {
        activity_database: database,
        activity_code: code,
        input_database: database,
        input_code: res.activity.code,
        amount: amt ?? 0,
        type: 'technosphere'
      })
    })
  }

  const title = direction === 'input' ? 'Add input flow' : 'Add output flow'
  const elemLabel = direction === 'input' ? 'resource (from nature)' : 'emission (to nature)'

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <EscapeCloser onClose={() => onClose()} />
      <div className="modal sheet flowpick-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>{title}</h3>
            <p>
              {direction === 'input'
                ? 'Pick an existing elementary resource (from nature), or create a new product flow.'
                : `Choose an existing elementary ${elemLabel}.`}
            </p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {direction === 'input' ? (
          <div className="flow-tabs" role="tablist">
            <button
              className={`flow-tab${mode === 'existing' ? ' on' : ''}`}
              onClick={() => setMode('existing')}
            >
              Existing elementary flow
            </button>
            <button className={`flow-tab${mode === 'new' ? ' on' : ''}`} onClick={() => setMode('new')}>
              New product flow
            </button>
          </div>
        ) : null}

        <div className="sheet-body">
          {mode === 'existing' ? (
            <>
              <input
                className="flowpick-search"
                autoFocus
                placeholder={
                  direction === 'input'
                    ? 'Search resources from nature… (e.g. water, in ground)'
                    : 'Search emissions to nature… (e.g. carbon dioxide)'
                }
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <div className="flowpick-list">
                {flows.length === 0 ? (
                  <p className="empty">No matching flows.</p>
                ) : (
                  flows.map((f) => (
                    <button
                      key={`${f.database}/${f.code}`}
                      className={`flowpick-row${sel?.code === f.code ? ' on' : ''}`}
                      onClick={() => setSel(f)}
                      // Double-click is the Add button for this row. A flow already on the process
                      // only gets selected: there the footer asks whether to merge or keep two entries.
                      onDoubleClick={() => {
                        if (!busy && !amtBad && !dupOf(f)) addExisting(f)
                      }}
                      title={`${f.name}${f.categories.length ? ` — ${f.categories.join(' · ')}` : ''}`}
                    >
                      <span className="fp-name" title={f.name}>
                        {f.name}
                      </span>
                      <span className="fp-cat" title={f.categories.join(' · ')}>
                        {f.categories.join(' · ')}
                      </span>
                      <span className="fp-unit">{f.unit}</span>
                    </button>
                  ))
                )}
              </div>
              {dup ? (
                <div className="settings-notice">
                  This flow is already on the process ({dup.amount}). Merge adds to it; separate keeps two
                  entries (they sum in the result).
                </div>
              ) : null}
            </>
          ) : (
            <div className="flowpick-new">
              <label className="settings-field">
                <span>Product name</span>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
              </label>
              <label className="settings-field">
                <span>Unit{freeUnits ? '' : ' (existing only)'}</span>
                {freeUnits ? (
                  // Hybrid (Settings → Modelling): editable combo, suggestions from the first character.
                  <UnitCombo value={newUnit} units={units} onChange={setNewUnit} />
                ) : (
                  <select value={newUnit} onChange={(e) => setNewUnit(e.target.value)}>
                    {units.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                )}
              </label>
              <label className="settings-field">
                <span>Amount</span>
                <input
                  className={amtBad ? 'refused' : undefined}
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  aria-invalid={amtBad ? true : undefined}
                  title={amtBad ? 'Not a number — use 0.5 or 0,5' : undefined}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <p className="settings-hint">
                Creates a new foreground product and links it as an input. You can model its upstream later,
                or leave it as a cut-off.
              </p>
            </div>
          )}
          {error ? <div className="editor-err">{error}</div> : null}
        </div>

        {mode === 'existing' ? (
          <div className="sheet-foot">
            <span className="meta fp-sel" title={sel?.name}>
              {sel ? sel.name : 'Select a flow above, or double-click it to add it'}
            </span>
            <div className="acts">
              <input
                className={`fp-amt${amtBad ? ' refused' : ''}`}
                type="text"
                inputMode="decimal"
                value={amount}
                aria-invalid={amtBad ? true : undefined}
                title={amtBad ? 'Not a number — use 0.5 or 0,5' : 'Amount'}
                onChange={(e) => setAmount(e.target.value)}
              />
              <span className="fp-unit">{sel?.unit ?? ''}</span>
              {dup ? (
                <>
                  <button
                    className="btn sm"
                    disabled={busy || amtBad}
                    onClick={() => addExisting(sel)}
                    title="Keep a second entry"
                  >
                    Separate
                  </button>
                  <button className="btn sm primary" disabled={busy || amtBad} onClick={mergeExisting}>
                    {busy ? '…' : `Merge → ${dup.amount + (amt ?? 0)}`}
                  </button>
                </>
              ) : (
                <button
                  className="btn sm primary"
                  disabled={!sel || busy || amtBad}
                  onClick={() => addExisting(sel)}
                >
                  {busy ? '…' : 'Add'}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="sheet-foot">
            <div className="acts">
              <button className="btn sm" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn sm primary"
                disabled={busy || amtBad || !newName.trim() || !newUnit}
                onClick={createProduct}
              >
                {busy ? '…' : 'Create & add'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
