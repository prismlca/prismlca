import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { api, type AuditEntry } from '../lib/api'
import { invalidate } from '../lib/server/useQuery'
import { scenariosRoute } from '../lib/server/routes'
import { ruleChoices, ruleViolation, toNumber, type ParamRule } from '../components/ParamRule'
import { AddIcon, CopyIcon, ExcelIcon, ImportIcon, PencilIcon, TrashIcon } from '../components/icons'
import ConfirmDialog, { type ConfirmSpec } from './ConfirmDialog'
import AuditLog from '../components/AuditLog'
import { deliverBase64, XLSX_MIME } from '../lib/download'
import { mutationRunner } from '../lib/mutation'
import { errMsg } from '../lib/errors'
import { parseAmount } from '../lib/numberFormat'
import EscapeCloser from '../components/EscapeCloser'
import FormulaInput from '../components/FormulaInput'
import { lintFormula, type ParamName } from '../lib/formula'

interface Scenario {
  id: string
  name: string
  description: string
  /** A number, or a formula over the model's parameters (a string). Either one replaces the
   *  parameter's own formula while the scenario is applied. */
  overrides: Record<string, number | string>
  /** Overrides that currently set a parameter to the value it already has, so this variant returns
   *  the baseline. Creating one is refused; this is the other way in — the baseline moved onto an
   *  override that was meaningful when it was typed, and only the numbers knew. */
  ineffective?: string[]
}
interface Param {
  name: string
  amount: number | null
  formula: string | null
  group_id: string | null
  unit: string | null
  /** What this parameter's value is allowed to be — a scenario is a set of its values, so the same
   *  rule holds here. The backend refuses a violation too; this refuses it where it is typed. */
  rule?: ParamRule
}
interface Group {
  id: string
  name: string
  order: number
}
interface Draft {
  mode: 'create' | 'edit'
  id?: string
  name: string
  description: string
  ov: Record<string, { on: boolean; value: string }>
}

export default function Scenarios({
  activeDb,
  rev,
  onChanged
}: {
  activeDb: string | null
  /** Bumped by the Workbench on every mutation it made itself, an Undo or Redo included — see
   *  `Parameters`. */
  rev?: number
  /** Something undoable was written from this page. The toolbar above it holds the Undo and Redo
   *  buttons and reads their state from `GET /model/history`; nothing else tells it to look again, so
   *  without this call Undo sat greyed out as “Nothing to undo” while the line was already in the log
   *  beside it, and Redo stayed enabled on a stack this write had just cleared (clicking it produced
   *  “Nothing to redo.”, the very 409 the disabled state exists to prevent). */
  onChanged?: () => void
}): JSX.Element {
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [params, setParams] = useState<Param[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [err, setErr] = useState<string | null>(null)
  /** Fingerprint of the last state written, so opening a scenario is not stored as a change. */
  const lastSaved = useRef<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [selId, setSelId] = useState<string | null>(null) // scenario shown in the side panel
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [note, setNote] = useState<string | null>(null) // import result message
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!activeDb) {
      setScenarios([])
      setParams([])
      setGroups([])
      setAudit([])
      return
    }
    const q = `?database=${encodeURIComponent(activeDb)}`
    const [sc, ps, gs, au] = await Promise.all([
      api<Scenario[]>('GET', `/api/v1/scenarios${q}`),
      api<Param[]>('GET', `/api/v1/params${q}`),
      api<Group[]>('GET', `/api/v1/params/groups${q}`),
      api<AuditEntry[]>('GET', `/api/v1/model/audit${q}`) // query parameter, see Parameters.tsx
    ])
    setScenarios(sc)
    setParams(ps)
    setGroups(gs)
    setAudit(au)
  }, [activeDb])

  useEffect(() => {
    void load()
  }, [load])

  // The Workbench wrote to this model (an Undo from the toolbar, a canvas edit) — reload. Separate
  // from the effect above so mounting does not fetch twice; see `Parameters`.
  const seenRev = useRef(rev)
  useEffect(() => {
    if (seenRev.current === rev) return
    seenRev.current = rev
    void load()
  }, [rev, load])

  const run = mutationRunner({
    setError: setErr,
    after: async () => {
      await load()
      onChanged?.()
    }
  })

  const baseline = (p: Param): string => (p.amount == null ? '' : String(p.amount))
  /** Text the override field accepts as a plain number (decimal comma included); anything else is read
   *  as a formula. */
  const isNumber = useCallback((v: string): boolean => parseAmount(v) !== null, [])
  /** The names a formula override may use, for completion and the linter. */
  const paramNames = useMemo<ParamName[]>(
    () =>
      params.map((p) => ({
        name: p.name,
        hint: `${p.amount ?? '—'}${p.unit ? ` ${p.unit}` : ''}`
      })),
    [params]
  )
  const formulaOf = (name: string): string | null => params.find((p) => p.name === name)?.formula || null
  const unitOf = (name: string): string => params.find((p) => p.name === name)?.unit ?? ''
  // Current (live) baseline amount of a parameter, for the "500 → 600" side-panel display.
  const baselineOf = (name: string): string => {
    const p = params.find((x) => x.name === name)
    return p && p.amount != null ? String(p.amount) : '—'
  }
  const selected = scenarios.find((s) => s.id === selId) ?? null

  const openCreate = (): void =>
    setDraft({
      mode: 'create',
      name: '',
      description: '',
      ov: Object.fromEntries(params.map((p) => [p.name, { on: false, value: baseline(p) }]))
    })

  const openEdit = (s: Scenario): void => {
    const d: Draft = {
      mode: 'edit',
      id: s.id,
      name: s.name,
      description: s.description,
      ov: Object.fromEntries(
        params.map((p) => [
          p.name,
          p.name in s.overrides
            ? { on: true, value: String(s.overrides[p.name]) }
            : { on: false, value: baseline(p) }
        ])
      )
    }
    // Seed the fingerprint with the state as opened, so the write-through effect has nothing to do until
    // something actually changes.
    lastSaved.current = `${s.id}:${JSON.stringify(draftBody(d))}`
    setDraft(d)
  }

  /** Why this override may not be saved, or null. A number is held to the parameter's rule here; any
   *  other text is a formula and is held to the formula linter (its result is checked by the server,
   *  which knows the values). An empty field is "nothing typed yet". */
  const ovRefused = (p: Param, value: string): string | null => {
    if (!value.trim()) return null
    const n = toNumber(value)
    if (n !== null) return ruleViolation(p.rule, n)
    return lintFormula(value, paramNames, { self: p.name })?.message ?? null
  }

  /** Overrides that break their parameter's rule, by name. A scenario is a set of parameter values, so it
   *  is bound by what those parameters allow — and the live save must not fire a request the backend will
   *  refuse on every keystroke. Named rather than counted: the message says which one. */
  const draftRefused = (d: Draft | null): string[] =>
    !d ? [] : params.filter((p) => d.ov[p.name]?.on && ovRefused(p, d.ov[p.name]!.value)).map((p) => p.name)

  /** The draft as the API wants it — one place, used by both the create action and the live save. */
  const draftBody = (d: Draft): Record<string, unknown> => {
    const overrides: Record<string, number | string> = {}
    for (const p of params) {
      const o = d.ov[p.name]
      if (!o?.on) continue
      const n = parseAmount(o.value)
      const text = o.value.replace(/\s+/g, ' ').trim()
      // A number is sent as a number; other text is a formula; an empty field stays what it always was.
      overrides[p.name] = n ?? (text || 0)
    }
    return { database: activeDb, name: d.name.trim(), description: d.description.trim(), overrides }
  }

  const saveDraft = (): Promise<void> =>
    run(async () => {
      if (!activeDb || !draft || !draft.name.trim()) return
      if (draft.mode === 'edit' && draft.id) {
        await api('POST', '/api/v1/scenarios/update', { id: draft.id, ...draftBody(draft) })
        if (activeDb) invalidate(scenariosRoute(activeDb))
      } else {
        await api('POST', '/api/v1/scenarios', draftBody(draft))
        if (activeDb) invalidate(scenariosRoute(activeDb))
      }
      setDraft(null)
    })

  /**
   * Editing an existing scenario writes through, like every other option in this app: a ticked override
   * or a renamed scenario is stored as it is made, and the dialog closes rather than saves. Nothing here
   * is a decision that needs confirming, and a dialog that looks like it needs one raises the question
   * of what happens to the change if you close it — the answer used to depend on finding a button below
   * a list of thirty parameters. Creating a NEW scenario keeps its Create action: there is nothing to
   * write through to until it exists.
   */
  /** The debounced write still waiting, so Close can send it first (see below). */
  const flushPending = useRef<(() => void) | null>(null)
  // One way out of the editor for X, Escape and a click beside the sheet: in edit mode a pending
  // override edit is written first, as Close always did — Escape used to drop it.
  const closeEditor = (): void => {
    if (draft?.mode === 'edit') flushPending.current?.()
    setDraft(null)
  }
  useEffect(() => {
    if (!activeDb || !draft || draft.mode !== 'edit' || !draft.id || !draft.name.trim()) return
    // A value that breaks its parameter's rule is not written — the backend would refuse it, and refusing
    // it here means the field stays as typed instead of the dialog filling with errors per keystroke.
    if (draftRefused(draft).length) return
    const id = draft.id
    const body = draftBody(draft)
    const fingerprint = `${id}:${JSON.stringify(body)}`
    // Opening the dialog must not count as an edit: without this the audit log filled with updates that
    // changed nothing, every time someone looked at a scenario.
    if (lastSaved.current === fingerprint) return
    const send = (): void => {
      lastSaved.current = fingerprint
      void api('POST', '/api/v1/scenarios/update', { id, ...body })
        .then(() => activeDb && invalidate(scenariosRoute(activeDb)))
        .then(() => load())
        .then(() => onChanged?.())
        .catch((e) => setErr(errMsg(e)))
    }
    const t = setTimeout(send, 400) // typing a name must not fire a request per keystroke
    // Closing within the debounce used to clear the timer and lose the last edit under a dialog that
    // says changes are saved as they are made: Close sends it now.
    flushPending.current = () => {
      clearTimeout(t)
      flushPending.current = null
      send()
    }
    return () => {
      clearTimeout(t)
      flushPending.current = null
    }
    // `params` only shapes the body; `draftBody` is recreated each render and would defeat the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDb, draft])

  const duplicate = (id: string): Promise<void> =>
    run(async () => {
      if (activeDb) await api('POST', '/api/v1/scenarios/duplicate', { database: activeDb, id })
      if (activeDb) invalidate(scenariosRoute(activeDb))
    })
  const del = (s: Scenario): void =>
    setConfirm({
      title: 'Delete scenario',
      message: `Delete the scenario “${s.name}”?`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () =>
        void run(async () => {
          if (activeDb) await api('POST', '/api/v1/scenarios/delete', { database: activeDb, id: s.id })
          if (activeDb) invalidate(scenariosRoute(activeDb))
        })
    })

  // Download an example workbook (parameters × scenarios) — base64→blob, like the Results exports.
  const downloadTemplate = (): void => {
    if (!activeDb) return
    void (async () => {
      try {
        const r = await api<{ filename: string; base64: string }>(
          'GET',
          `/api/v1/scenarios/template?database=${encodeURIComponent(activeDb)}`
        )
        deliverBase64(r.base64, r.filename, XLSX_MIME)
      } catch (e) {
        setErr(errMsg(e))
      }
    })()
  }

  // Import scenarios from a chosen .xlsx: read as base64, POST, then report created/overwritten.
  const onImportFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    e.target.value = '' // let the same file be picked again after a fix
    if (!file || !activeDb) return
    setNote(null)
    const reader = new FileReader()
    reader.onload = () =>
      void run(async () => {
        const res = String(reader.result)
        const b64 = res.includes(',') ? res.slice(res.indexOf(',') + 1) : res
        if (activeDb) invalidate(scenariosRoute(activeDb))
        const r = await api<{ created: number; overwritten: number }>('POST', '/api/v1/scenarios/import', {
          database: activeDb,
          xlsx_base64: b64
        })
        setNote(`Import done: ${r.created} created, ${r.overwritten} overwritten.`)
      })
    reader.readAsDataURL(file)
  }

  // Params grouped by group (in group order), then an "Ungrouped" bucket — for the dialog body.
  const sections = useMemo(() => {
    const secs = groups.map((g) => ({
      id: g.id as string | null,
      name: g.name,
      rows: params.filter((p) => p.group_id === g.id)
    }))
    const ungrouped = params.filter((p) => !p.group_id || !groups.some((g) => g.id === p.group_id))
    if (ungrouped.length) secs.push({ id: null, name: 'Ungrouped', rows: ungrouped })
    return secs.filter((s) => s.rows.length)
  }, [groups, params])

  const setOv = (name: string, patch: Partial<{ on: boolean; value: string }>): void =>
    setDraft((d) => (d ? { ...d, ov: { ...d.ov, [name]: { ...d.ov[name], ...patch } } } : d))

  return (
    <div className="view scen-view">
      <div className="scen-main" onClick={() => setSelId(null)}>
        <div className="view-head">
          <h2>Scenarios</h2>
          <div className="srow">
            <button
              className="btn ico-label"
              onClick={openCreate}
              disabled={!params.length}
              title={params.length ? 'Create a scenario' : 'Add parameters first'}
            >
              <AddIcon /> Scenario
            </button>
            <button
              className="btn ico-label"
              onClick={() => fileRef.current?.click()}
              disabled={!activeDb}
              title="Import scenarios from an Excel file (rows = parameters, columns = scenarios)"
            >
              <ImportIcon /> Import
            </button>
            <button
              className="btn ico-label"
              onClick={downloadTemplate}
              disabled={!activeDb}
              title="Download an example workbook in the expected import format"
            >
              <ExcelIcon /> Template
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              style={{ display: 'none' }}
              onChange={onImportFile}
            />
          </div>
        </div>
        {err ? (
          <div className="wb-error" onClick={() => setErr(null)}>
            {err}
          </div>
        ) : null}
        {note ? (
          <div className="wb-note" onClick={() => setNote(null)}>
            {note}
          </div>
        ) : null}

        {!activeDb ? (
          <p className="empty">
            Scenarios belong to a model. Open or create a model to manage its scenarios.
          </p>
        ) : scenarios.length === 0 ? (
          <p className="empty">
            No scenarios yet.{' '}
            {params.length
              ? 'Create one with the button above.'
              : 'Add parameters first, then create a scenario.'}
          </p>
        ) : (
          <div className="scen-list">
            {scenarios.map((s) => (
              <div
                className={`scen-card${selId === s.id ? ' sel' : ''}`}
                key={s.id}
                onClick={(e) => {
                  e.stopPropagation()
                  setSelId(s.id)
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  // A double-click on an action button is two clicks on that button, not a request to edit.
                  if ((e.target as HTMLElement).closest('.scen-card-actions')) return
                  openEdit(s)
                }}
              >
                <div className="scen-card-main">
                  <div className="scen-card-name">{s.name}</div>
                  {s.description ? <div className="scen-card-desc">{s.description}</div> : null}
                  <div className="scen-card-count">
                    {Object.keys(s.overrides).length
                      ? `${Object.keys(s.overrides).length} override${Object.keys(s.overrides).length === 1 ? '' : 's'}`
                      : 'no overrides'}
                    {s.ineffective?.length ? (
                      <span
                        className="scen-card-warn"
                        title={`${s.ineffective.join(', ')} now hold the model's own value, so this variant returns the baseline result. Change the override, or change the parameter.`}
                      >
                        · {s.ineffective.length} change{s.ineffective.length === 1 ? 's' : ''} nothing
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="scen-card-actions">
                  <button
                    className="act-icon"
                    title="Edit scenario"
                    aria-label="Edit scenario"
                    onClick={(e) => {
                      e.stopPropagation()
                      openEdit(s)
                    }}
                  >
                    <PencilIcon />
                  </button>
                  <button
                    className="act-icon"
                    title="Duplicate scenario"
                    aria-label="Duplicate scenario"
                    onClick={(e) => {
                      e.stopPropagation()
                      void duplicate(s.id)
                    }}
                  >
                    <CopyIcon />
                  </button>
                  <button
                    className="act-icon danger"
                    title="Delete scenario"
                    aria-label="Delete scenario"
                    onClick={(e) => {
                      e.stopPropagation()
                      del(s)
                    }}
                  >
                    <TrashIcon />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <aside className="scen-side">
        {selected ? (
          <div className="scen-detail">
            <div className="scen-detail-head">
              <div className="rp-title">{selected.name}</div>
              <div className="scen-card-actions">
                <button
                  className="act-icon"
                  title="Edit scenario"
                  aria-label="Edit scenario"
                  onClick={() => openEdit(selected)}
                >
                  <PencilIcon />
                </button>
                <button
                  className="act-icon"
                  title="Duplicate scenario"
                  aria-label="Duplicate scenario"
                  onClick={() => void duplicate(selected.id)}
                >
                  <CopyIcon />
                </button>
                <button
                  className="act-icon danger"
                  title="Delete scenario"
                  aria-label="Delete scenario"
                  onClick={() => del(selected)}
                >
                  <TrashIcon />
                </button>
              </div>
            </div>
            {selected.description ? <p className="scen-detail-desc">{selected.description}</p> : null}
            <div className="subj-subhead">Overrides</div>
            {Object.keys(selected.overrides).length ? (
              <div className="scen-ov-detail">
                {Object.entries(selected.overrides).map(([k, v]) => (
                  <div className="scen-ov-line" key={k}>
                    <div className="scen-ov-line-name">
                      {k}
                      {selected.ineffective?.includes(k) ? (
                        <span
                          className="scen-ov-same"
                          title="The parameter already holds this value, so this override changes nothing."
                        >
                          same as the model
                        </span>
                      ) : null}
                    </div>
                    <div className="scen-ov-line-vals">
                      <span className="base">
                        {formulaOf(k) ? <code className="scen-fx">ƒ {formulaOf(k)}</code> : null}
                        {formulaOf(k) ? ' = ' : null}
                        {baselineOf(k)}
                        {unitOf(k) ? ` ${unitOf(k)}` : ''}
                      </span>
                      <span className="arrow">→</span>
                      <span className="to">
                        {typeof v === 'string' ? <code className="scen-fx">ƒ {v}</code> : v}
                        {typeof v === 'string' ? null : unitOf(k) ? ` ${unitOf(k)}` : ''}
                      </span>
                    </div>
                    {formulaOf(k) ? (
                      <div className="scen-ov-replaces">
                        Replaces the parameter&apos;s formula in this scenario.
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="empty">This scenario overrides nothing — it equals the baseline.</p>
            )}
            <p className="hint-sm" style={{ marginTop: 14 }}>
              Baseline values are read live from your current parameters. See the comparison on the Results
              page.
            </p>
          </div>
        ) : (
          <div className="scen-help">
            <div className="rp-title">What scenarios do</div>
            <p>
              A scenario is a named set of <b>parameter overrides</b> laid on top of your baseline model —
              e.g. <code>distance 500&nbsp;km → 600&nbsp;km</code>. Use them to explore what-if variants
              without editing the model.
            </p>
            <p>
              <b>How they work:</b> in the create/edit dialog you tick the parameters a scenario should change
              and give them new values — a number, or a formula over other parameters such as{' '}
              <code>1.2 * distance</code>. Everything untouched keeps its baseline value. Amounts (and any
              formulas that use them) recompute automatically. An override on a parameter that has a formula
              of its own replaces that formula for the scenario.
            </p>
            <p>
              <b>Where to see results:</b> open the <b>Results</b> page — each scenario appears as a
              selectable subject beneath your model (alongside the baseline) and flows through the normal
              charts, stacked bars and Excel export.
            </p>
            <p className="hint-sm">
              Select a scenario on the left to see exactly which parameters it changes.
            </p>
          </div>
        )}
        <AuditLog entries={audit} />
      </aside>

      {draft ? (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeEditor()}>
          <EscapeCloser onClose={closeEditor} />
          <div className="modal sheet scenario-modal" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <div className="sheet-head-grow">
                <h3>{draft.mode === 'edit' ? 'Edit scenario' : 'New scenario'}</h3>
                <p>Tick a parameter to give it a scenario value; unticked parameters keep the baseline.</p>
              </div>
              <button className="sheet-x" aria-label="Close" onClick={closeEditor}>
                ✕
              </button>
            </div>
            <div className="sheet-body">
              <label className="scen-field">
                <span>Name</span>
                <input
                  value={draft.name}
                  autoFocus
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="e.g. High recycling"
                />
              </label>
              <label className="scen-field">
                <span>Description</span>
                <textarea
                  value={draft.description}
                  rows={2}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="What this scenario represents (optional)"
                />
              </label>
              <div className="scen-ov-head">Overrides</div>
              <div className="scen-ov-list">
                {sections.length === 0 ? <p className="empty">No parameters to override yet.</p> : null}
                {sections.map((sec) => (
                  <div className="scen-ov-group" key={sec.id ?? 'ungrouped'}>
                    <div className="scen-ov-group-name">{sec.name}</div>
                    {sec.rows.map((p) => {
                      const o = draft.ov[p.name] ?? { on: false, value: baseline(p) }
                      return (
                        <label className={`scen-ov-row${o.on ? ' on' : ''}`} key={p.name}>
                          <input
                            type="checkbox"
                            checked={o.on}
                            onChange={(e) => setOv(p.name, { on: e.target.checked })}
                          />
                          <span className="scen-ov-name">{p.name}</span>
                          <span
                            className="scen-ov-base"
                            title={
                              p.formula
                                ? `Baseline: formula ${p.formula} = ${baseline(p)}. An override replaces this formula in the scenario.`
                                : 'Baseline value'
                            }
                          >
                            {p.formula ? <code className="scen-fx">ƒ {p.formula}</code> : null}
                            {p.formula ? ' = ' : null}
                            {baseline(p)}
                            {p.unit ? ` ${p.unit}` : ''}
                          </span>
                          {ruleChoices(p.rule).length ? (
                            // A rule that lists its values is a choice here as well: the same dropdown the
                            // parameter page shows, so an override cannot leave the list either.
                            <select
                              className="pc-pick"
                              value={o.value}
                              disabled={!o.on}
                              onChange={(e) => setOv(p.name, { value: e.target.value })}
                            >
                              {ruleChoices(p.rule).some((c) => c === toNumber(o.value)) ? null : (
                                <option value={o.value}>{o.value || '—'}</option>
                              )}
                              {ruleChoices(p.rule).map((c) => (
                                <option key={c} value={String(c)}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          ) : !o.on ? (
                            <input
                              className="num"
                              type="text"
                              value={o.value}
                              disabled
                              aria-label={`${p.name} override`}
                            />
                          ) : (
                            // A number or a formula: text, so a decimal comma means the same here as in the
                            // process editor, and a formula completes the model's parameter names.
                            <span
                              className={`scen-ov-input${ovRefused(p, o.value) ? ' refused' : ''}`}
                              title={
                                ovRefused(p, o.value) || 'A number, or a formula such as 2 * other_parameter'
                              }
                            >
                              <FormulaInput
                                className="num"
                                multiline={false}
                                value={o.value}
                                onChange={(v) => setOv(p.name, { value: v })}
                                params={paramNames}
                                self={p.name}
                                isPlainValue={isNumber}
                                placeholder="number or formula"
                              />
                            </span>
                          )}
                        </label>
                      )
                    })}
                  </div>
                ))}
              </div>
              {draftRefused(draft).length ? (
                <p className="pc-refused scen-ov-refused">
                  Not saved: {draftRefused(draft).join(', ')} — the value breaks the rule on that parameter,
                  or the formula cannot be read.
                </p>
              ) : null}
            </div>
            <div className="sheet-foot">
              {draft.mode === 'edit' ? (
                <span className="meta">Changes are saved as you make them.</span>
              ) : null}
              <div className="acts">
                {draft.mode === 'edit' ? (
                  <button
                    className="btn primary"
                    onClick={() => {
                      flushPending.current?.()
                      setDraft(null)
                    }}
                  >
                    Close
                  </button>
                ) : (
                  <>
                    <button className="btn" onClick={() => setDraft(null)}>
                      Cancel
                    </button>
                    <button
                      className="btn primary"
                      onClick={saveDraft}
                      disabled={!draft.name.trim() || draftRefused(draft).length > 0}
                    >
                      Create
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirm ? <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} /> : null}
    </div>
  )
}
