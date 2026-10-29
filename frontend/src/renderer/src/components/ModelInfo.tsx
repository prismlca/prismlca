import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import ComparisonPicker from './ComparisonPicker'
import { LinkIcon } from './icons'
import { unlinkModels, useComparedWith } from '../lib/comparison'
import { api } from '../lib/api'
import { fetchQuery, invalidate } from '../lib/server/useQuery'
import { studyRoute } from '../lib/server/routes'
import { PencilIcon } from './icons'
import { holdForDeparture, renameCachedView, SAVE_NOW_EVENT } from '../lib/modelView'
import { renameModelKeys } from '../lib/persist'
import { errMsg } from '../lib/errors'
import EscapeCloser from './EscapeCloser'
import { ALL_FIELDS, SECTIONS } from './modelInfoFields'

/** Grow a textarea to its content — a scope of ten lines should not be read through a two-line slot. */
function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

/**
 * The functional unit, made real.
 *
 * The field above it is prose: "1 kWh of electricity". The model underneath usually delivers
 * something else — one installation, one batch, one machine — and the division between the two lives
 * nowhere. Writing it down by hand needs a trick most people do not know: a small process above the
 * reference process whose input amount is `1 / denominator`. One observed run is the
 * evidence that it is not obvious — the assistant computed the denominator, wrote it into a
 * parameter, and never connected it, which left seven parameters and three of four scenarios unable
 * to move a number (V233).
 *
 * The division goes into the MODEL, not into this view. A displayed quotient is computed once and
 * repeated under every scenario — and for a per-unit figure the interesting scenarios are exactly
 * the ones that change the denominator, not the numerator. Put it in the matrix and a yield
 * scenario moves the result because it really does.
 */
function ReferenceQuantity({ database }: { database: string }): JSX.Element {
  const [rq, setRq] = useState<{ parameter?: string; of?: string; name?: string } | null>(null)
  const [params, setParams] = useState<Array<{ name: string; amount: number | null; unit?: string }>>([])
  const [root, setRoot] = useState<{ code: string; name: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [param, setParam] = useState('')
  const [unit, setUnit] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = (): void => {
    const db = encodeURIComponent(database)
    void api<{ parameter?: string; of?: string; name?: string }>(
      'GET',
      `/api/v1/model/reference-quantity/${db}`
    )
      .then((r) => setRq(r && r.parameter ? r : null))
      .catch(() => setRq(null))
    void api<Array<{ name: string; amount: number | null; unit?: string }>>(
      'GET',
      `/api/v1/params?database=${db}`
    )
      .then((r) => setParams(Array.isArray(r) ? r : []))
      .catch(() => setParams([]))
    void api<{ candidates?: Array<{ code: string; name: string }> }>('GET', `/api/v1/model/reference/${db}`)
      .then((r) => setRoot(r?.candidates?.[0] ?? null))
      .catch(() => setRoot(null))
  }
  useEffect(load, [database])

  // Only a parameter with a value can be a denominator, and dividing by the total the model already
  // spreads over is the whole idea — so a zero is filtered out rather than refused later.
  const usable = params.filter((p) => typeof p.amount === 'number' && p.amount !== 0)

  const apply = (): void => {
    const chosen = usable.find((p) => p.name === param)
    if (!chosen || !unit.trim() || !root) return
    setBusy(true)
    setErr(null)
    void api('POST', '/api/v1/model/reference-quantity', {
      database,
      code: root.code,
      parameter: chosen.name,
      unit: unit.trim(),
      name: `${root.name} — per ${unit.trim()}`
    })
      .then(() => {
        setOpen(false)
        load()
      })
      .catch((e) => setErr(errMsg(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="mi-field span2 mi-refq">
      <div className="top">
        <label>Reference quantity</label>
        {rq ? <span className="mi-tag">In the model</span> : null}
      </div>
      {rq ? (
        <p className="mi-refq-now">
          The result is divided by <code>{rq.parameter}</code>, so every scenario that moves it moves the
          result too.
        </p>
      ) : (
        <p className="mi-refq-now muted">
          The model delivers whatever its reference process produces. If the functional unit above is a
          quantity the model spreads itself over — a lifetime output, a batch, a service life — divide by the
          parameter that holds it.
        </p>
      )}
      {open ? (
        <div className="mi-refq-form">
          <select value={param} onChange={(e) => setParam(e.target.value)} aria-label="Divide by">
            <option value="">Divide by…</option>
            {usable.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name} = {p.amount}
                {p.unit ? ` ${p.unit}` : ''}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={unit}
            placeholder="Unit of one, e.g. kilowatt hour"
            onChange={(e) => setUnit(e.target.value)}
          />
          <button className="btn primary" disabled={busy || !param || !unit.trim() || !root} onClick={apply}>
            {busy ? 'Applying…' : rq ? 'Replace' : 'Apply'}
          </button>
          <button className="btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="btn"
          onClick={() => {
            setParam(rq?.parameter || '')
            setOpen(true)
          }}
        >
          {rq ? 'Change reference quantity' : 'Set reference quantity'}
        </button>
      )}
      {err ? <p className="mi-refq-err">{err}</p> : null}
      {!root && open ? (
        <p className="mi-refq-err">This model has no reference process yet — build it first.</p>
      ) : null}
    </div>
  )
}

/** The fields whose value differs from the one loaded — all that a save sends. */
function changedFields(
  current: Record<string, string>,
  loaded: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(Object.entries(current).filter(([k, v]) => v !== (loaded[k] ?? '')))
}

/**
 * Editor for a model's goal & scope and the other study metadata. The same data is read and
 * written by the AI assistant (get_model_info / set_model_info); saving goes through the command
 * bus, so it is undoable and audited. That is why the text is not written through on every keystroke
 * like the settings are — every pause would be an undo step — but once, when the dialog closes.
 *
 * Closing saves, however it happens: ✕, Close, Escape or a click beside the sheet. It had a Save
 * button with a Cancel beside it, and Escape or a stray click threw a page of goal and scope away
 * without asking — in an app whose tour tells people there is nothing to save.
 * Only the fields that differ from what was loaded are sent, so an untouched field never overwrites
 * what the assistant wrote into it while the dialog was open. A refused save keeps the dialog open
 * with the reason in the footer; closing it again retries. The fields are read-only while a save is
 * on its way (what was typed after Escape would miss the payload and close with it), and the sheet
 * does not close during a rename (the write would go to the old name). Quitting the app with the
 * sheet open saves the same way the canvas keeps its layout: on `beforeunload`, and on the save-now
 * event an update sends before it stops the backend, which waits for the write (`holdForDeparture`).
 * One study write at a time, whichever path starts it; one that falls into a rename waits for it.
 */
export default function ModelInfo(props: {
  database: string
  onClose: () => void
  /** The model now goes by this name. The caller has to act on it: the model list, the model dropdown
   *  and — when the renamed model is the open one — `activeDb` all still say the old name, and every
   *  later request under it would 404. */
  onRenamed?: (next: string) => void
}): JSX.Element {
  const [vals, setVals] = useState<Record<string, string>>({})
  //: Which LLM last filled study fields — stamped by the backend on assistant edits (V128), never
  //: editable here: provenance is a fact about the text, not a field of the study.
  const [aiModel, setAiModel] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  /** The values as loaded — what `close` compares against to send only what was changed here. */
  const loadedVals = useRef<Record<string, string>>({})
  /** The live values and model name, for the departure save, whose listener outlives any one render. */
  const live = useRef({ vals, database: props.database })
  live.current = { vals, database: props.database }
  /** Set synchronously, unlike the state beside them: a departure can fire between a click and the
   *  render that would show `saving` or `renaming`. */
  const writing = useRef(false)
  /** A rename on its way, resolving to the name the model answers to once it has landed (the new one,
   *  or the old one if it was refused). A departure in the meantime waits for it, then writes there. */
  const renamingNow = useRef<Promise<string> | null>(null)

  /** Send the changed fields; on success they become the new baseline, so nothing is sent twice. */
  const writeStudy = (database: string, changed: Record<string, string>): Promise<unknown> => {
    writing.current = true
    const sent = api('POST', '/api/v1/study', { database, ...changed, source: 'user' })
      .then((r) => {
        loadedVals.current = { ...loadedVals.current, ...changed }
        return r
      })
      .finally(() => {
        writing.current = false
      })
    holdForDeparture(sent)
    return sent
  }
  const [error, setError] = useState<string | null>(null)
  const [current, setCurrent] = useState(SECTIONS[0].id)
  const fieldsRef = useRef<HTMLDivElement | null>(null)
  // Renaming: the name in the head is text until the pencil is clicked, then a field with a discard and
  // a confirm beside it. Deliberately NOT part of the save on close below: the name is not a study
  // field, and the study write would then have to go to a model that no longer answers to the name it
  // was addressed by. And deliberately not committed on blur either — the two
  // buttons are the only commit, which is what keeps this field out of the Escape-versus-blur race the
  // table cells had (a `setState` never reaches a commit that the same keystroke's blur already ran).
  const [editingName, setEditingName] = useState(false)
  // The models this one is compared with — a study property, symmetric, written through at once by the
  // picker and the ✕ (no Save: the relation is not a text field of the study, see lib/comparison.ts).
  const comparedWith = useComparedWith(props.database)
  const [picking, setPicking] = useState(false)
  const [linkErr, setLinkErr] = useState<string | null>(null)
  const [name, setName] = useState(props.database)
  const [renaming, setRenaming] = useState(false)
  // Only the refusal is worth a line: a rename that worked says so by the title carrying the new name.
  const [nameErr, setNameErr] = useState<string | null>(null)
  /** The input this session of editing already focused — a ref callback runs on every render. */
  const focusedName = useRef<HTMLInputElement | null>(null)
  /** The name this dialog itself just gave the model. Its metadata is what is on screen — the reload the
   *  new name triggers below would replace unsaved goal/scope text with the stored one. */
  const renamedTo = useRef<string | null>(null)

  useEffect(() => {
    if (renamedTo.current === props.database) {
      renamedTo.current = null
      return
    }
    let alive = true
    // What is stored, not what a view cached before: the assistant may have written it a moment ago.
    invalidate(studyRoute(props.database))
    void fetchQuery(studyRoute(props.database))
      .then((raw) => {
        if (!alive) return
        const meta = raw as Record<string, string>
        const next = Object.fromEntries(ALL_FIELDS.map((f) => [f.key, meta?.[f.key] ?? '']))
        loadedVals.current = next
        setVals(next)
        setAiModel(meta?.ai_model || null)
        setLoaded(true)
      })
      .catch((e) => {
        if (!alive) return
        setError(errMsg(e))
        setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [props.database])

  // Follow the model the dialog is about — including the rename this dialog just made.
  useEffect(() => {
    setName(props.database)
    setEditingName(false)
  }, [props.database])

  // Grow every textarea once the values arrive, not only as they are typed into.
  useEffect(() => {
    if (!loaded) return
    fieldsRef.current?.querySelectorAll('textarea').forEach((t) => autoGrow(t as HTMLTextAreaElement))
  }, [loaded])

  // Which section is being read, so the rail can mark it. `-70%` at the bottom means a section counts
  // as current once its head reaches the upper third, not when its last line leaves the viewport.
  useEffect(() => {
    const root = fieldsRef.current
    if (!root || !loaded) return
    const obs = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setCurrent(e.target.id.replace('mi-', ''))),
      { root, rootMargin: '-20% 0px -70% 0px' }
    )
    root.querySelectorAll('.mi-sec').forEach((s) => obs.observe(s))
    return () => obs.disconnect()
  }, [loaded])

  const filled = (key: string): boolean => (vals[key] ?? '').trim().length > 0
  const progress = useMemo(() => {
    const done = ALL_FIELDS.filter((f) => filled(f.key)).length
    return { done, total: ALL_FIELDS.length, ratio: ALL_FIELDS.length ? done / ALL_FIELDS.length : 0 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vals])

  const cancelRename = (): void => {
    focusedName.current = null
    setEditingName(false)
    setName(props.database)
    setNameErr(null)
  }

  /**
   * Rename the model, from the ✓ or from Enter. A refused name stays in the field with the reason
   * under it (“Database 'x' already exists.”) rather than being thrown away — the fix is usually one
   * word, and re-typing the whole name to find out the next one is taken too is not a dialog.
   */
  const rename = async (): Promise<void> => {
    const next = name.trim()
    if (!next || next === props.database) {
      cancelRename()
      return
    }
    setRenaming(true)
    let landed: (name: string) => void = () => {}
    renamingNow.current = new Promise<string>((r) => (landed = r))
    let finalName = props.database
    try {
      await api('POST', '/api/v1/databases/foreground/rename', {
        database: props.database,
        name: next,
        source: 'user'
      })
      // The view store first, because it has a write in flight: its 400 ms debounce would otherwise
      // PUT the canvas arrangement under a model that no longer exists.
      renameCachedView(props.database, next)
      // Then the rest of the model-scoped browser state, keyed by the model's name (`modelKey`) and
      // out of the backend's reach — or the folded parameter groups and the chosen result subjects
      // stay behind under a name nothing uses again.
      renameModelKeys(props.database, next)
      setNameErr(null)
      setEditingName(false)
      renamedTo.current = next
      finalName = next
      props.onRenamed?.(next)
    } catch (e) {
      setNameErr(errMsg(e))
    } finally {
      setRenaming(false)
      renamingNow.current = null
      landed(finalName)
    }
  }

  // Leaving the app with the sheet open must not throw the text away either (see the doc comment).
  useEffect(() => {
    const writeTo = (database: string): Promise<unknown> | undefined => {
      if (writing.current) return undefined
      const changed = changedFields(live.current.vals, loadedVals.current)
      if (!Object.keys(changed).length) return undefined
      return writeStudy(database, changed).catch(() => {})
    }
    const onLeave = (): void => {
      const rename = renamingNow.current
      if (rename) holdForDeparture(rename.then(writeTo))
      else void writeTo(live.current.database)
    }
    window.addEventListener('beforeunload', onLeave)
    window.addEventListener(SAVE_NOW_EVENT, onLeave)
    return () => {
      window.removeEventListener('beforeunload', onLeave)
      window.removeEventListener(SAVE_NOW_EVENT, onLeave)
    }
  }, [])

  const close = async (): Promise<void> => {
    if (saving || writing.current || renamingNow.current) return
    const changed = changedFields(vals, loadedVals.current)
    if (!loaded || Object.keys(changed).length === 0) {
      props.onClose()
      return
    }
    setSaving(true)
    setError(null)
    try {
      await writeStudy(props.database, changed)
      invalidate(studyRoute(props.database)) // Overview snippets and report briefs read this key
      props.onClose()
    } catch (e) {
      setError(errMsg(e))
      setSaving(false)
    }
  }

  const CIRC = 113.1 // 2πr for r = 18

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && void close()}>
      <EscapeCloser onClose={() => void close()} />
      <div className="modal sheet model-info" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="sheet-head-grow">
            <h3>
              Model info <span className="sep">/</span>
              {editingName ? (
                <span className="mi-title-edit">
                  <input
                    aria-label="Model name"
                    type="text"
                    value={name}
                    // Focused, selected, and scrolled back to the start: a name longer than the field
                    // otherwise opens showing its last few words, which is the half that does not say
                    // which model this is.
                    ref={(el) => {
                      if (!el || el === focusedName.current) return
                      focusedName.current = el
                      el.focus()
                      el.select()
                      el.scrollLeft = 0
                    }}
                    disabled={renaming}
                    spellCheck={false}
                    onChange={(e) => {
                      setName(e.target.value)
                      setNameErr(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void rename()
                      }
                      if (e.key === 'Escape') {
                        e.stopPropagation() // abandons the rename; the window stays
                        cancelRename()
                      }
                    }}
                  />
                  {/* Discard first, confirm second: the confirming button sits closest to the field's
                      right edge, where the pencil was. */}
                  <button
                    className="act-icon"
                    aria-label="Discard the new name"
                    title="Discard (Esc)"
                    disabled={renaming}
                    onClick={cancelRename}
                  >
                    ✕
                  </button>
                  <button
                    className="act-icon ok"
                    aria-label="Rename the model"
                    title="Rename (Enter)"
                    disabled={renaming}
                    onClick={() => void rename()}
                  >
                    ✓
                  </button>
                </span>
              ) : (
                <>
                  {props.database}
                  <button
                    className="mi-title-pencil"
                    aria-label="Rename this model"
                    title="Rename this model — parameters, scenarios, tags, reports, chats, the canvas arrangement and its history follow the new name"
                    onClick={() => {
                      focusedName.current = null
                      setName(props.database)
                      setNameErr(null)
                      setEditingName(true)
                    }}
                  >
                    <PencilIcon />
                  </button>
                </>
              )}
            </h3>
            {nameErr ? <p className="mi-title-err">{nameErr}</p> : null}
            <p>
              Goal, scope and study metadata for this model. The assistant reads this as its brief and keeps
              it current as decisions are made.
              {aiModel ? (
                <>
                  {' '}
                  <span
                    className="mi-aimodel"
                    title="Recorded automatically when the assistant writes study fields — which LLM produced these words is part of the study's provenance."
                  >
                    Study fields last written by <code>{aiModel}</code>.
                  </span>
                </>
              ) : null}
            </p>
          </div>
          <button className="sheet-x" aria-label="Close" onClick={() => void close()}>
            ✕
          </button>
        </div>

        <div className="model-info-body">
          <aside className="sheet-rail">
            <div className="mi-gauge">
              <svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true">
                <circle className="track" cx="23" cy="23" r="18" fill="none" strokeWidth="4" />
                <circle
                  className="arc"
                  cx="23"
                  cy="23"
                  r="18"
                  fill="none"
                  strokeWidth="4"
                  strokeDasharray={CIRC}
                  strokeDashoffset={CIRC * (1 - progress.ratio)}
                />
              </svg>
              <div>
                <div className="pct">{Math.round(progress.ratio * 100)} %</div>
                <div className="lbl">Briefed</div>
              </div>
            </div>

            <nav className="rail-nav" aria-label="Sections">
              {SECTIONS.map((sec) => {
                const done = sec.fields.filter((f) => filled(f.key)).length
                return (
                  <button
                    key={sec.id}
                    className={`rail-item${current === sec.id ? ' on' : ''}`}
                    onClick={() =>
                      document
                        .getElementById(`mi-${sec.id}`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }
                  >
                    <span
                      className={`rail-pip${done === sec.fields.length ? ' done' : ''}`}
                      aria-hidden="true"
                    />
                    {sec.title}
                    <span className="tally">
                      {done}/{sec.fields.length}
                    </span>
                  </button>
                )
              })}
            </nav>

            {/* Said here because it changes how much effort this dialog deserves: a report does not print
                these fields any more, it has them written into prose. Keywords are enough. */}
            <p className="rail-note">
              <b>Keywords are enough.</b> The report no longer prints these fields verbatim — the chapter is
              written from them, so “mass allocation, ISO 14044 §4.3.4.2” becomes a sentence.
            </p>
          </aside>

          <div className="mi-fields" ref={fieldsRef}>
            {!loaded ? (
              <p className="rail-note" style={{ marginTop: 18 }}>
                Loading…
              </p>
            ) : (
              <>
                <section className="mi-sec" id="mi-compare">
                  <div className="mi-sechead">
                    <span className="mi-swatch" aria-hidden="true" />
                    <h4>Compared with</h4>
                    <span className="mi-std">Results page · assistant brief</span>
                  </div>
                  {/* The chat's picker explains itself in its head; this block used to say nothing, so a
                      reader here could not tell what linking DOES. One sentence, the
                      part that matters: the other model goes into the assistant's context. */}
                  <p className="mi-compare-note">
                    Models that will stand side by side on the Results page. The AI assistant in this model’s
                    chat gets a summary of each linked model as context — functional unit, boundaries, tag
                    vocabulary, shared assumptions — and keeps the two consistent. The link works both ways.
                  </p>
                  <div className="mi-compare">
                    {comparedWith.map((other) => (
                      <span
                        key={other}
                        className="chat-cmp"
                        title={`${props.database} and ${other} are comparison models of each other`}
                      >
                        <LinkIcon />
                        <span className="chat-attach-name">{other}</span>
                        <button
                          className="chat-attach-x"
                          title="Remove the link (on both models)"
                          onClick={() => {
                            setLinkErr(null)
                            void unlinkModels(props.database, other).catch((e) => setLinkErr(errMsg(e)))
                          }}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                    {!comparedWith.length ? (
                      <span className="mi-compare-empty">Not compared with another model yet.</span>
                    ) : null}
                    <button className="btn ico-label" onClick={() => setPicking(true)}>
                      <LinkIcon /> {comparedWith.length ? 'Change…' : 'Add comparison model…'}
                    </button>
                  </div>
                  {linkErr ? <p className="mi-refq-err">{linkErr}</p> : null}
                </section>
                {SECTIONS.map((sec) => (
                  <section className="mi-sec" id={`mi-${sec.id}`} key={sec.id}>
                    <div className="mi-sechead">
                      <span className="mi-swatch" aria-hidden="true" />
                      <h4>{sec.title}</h4>
                      <span className="mi-std">{sec.std}</span>
                    </div>
                    <div className="mi-grid">
                      {sec.fields.map((f) => (
                        <Fragment key={f.key}>
                          <div
                            className={`mi-field${filled(f.key) ? ' filled' : ''}${f.half ? '' : ' span2'}`}
                          >
                            <div className="top">
                              <label htmlFor={`mi-f-${f.key}`}>{f.label}</label>
                              {/* Only the required ones are marked. Tagging the other ten "Optional" as well
                              filled the column with chips that all said the same thing — the absence of
                              the mark is the answer, and what has to stand out is the three that do not
                              have an absence to fall back on. */}
                              {f.required ? <span className="mi-tag req">Required</span> : null}
                            </div>
                            {f.options ? (
                              <select
                                id={`mi-f-${f.key}`}
                                title={f.title}
                                value={vals[f.key] || f.fallback || ''}
                                disabled={saving}
                                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                              >
                                {f.options.map((o) => (
                                  <option key={o.code} value={o.code}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                            ) : f.textarea ? (
                              <textarea
                                id={`mi-f-${f.key}`}
                                rows={2}
                                value={vals[f.key] ?? ''}
                                placeholder={f.placeholder}
                                autoFocus={f.key === 'goal'}
                                readOnly={saving}
                                onChange={(e) => {
                                  autoGrow(e.target)
                                  setVals((v) => ({ ...v, [f.key]: e.target.value }))
                                }}
                              />
                            ) : (
                              <input
                                id={`mi-f-${f.key}`}
                                type="text"
                                title={f.title}
                                value={vals[f.key] ?? ''}
                                placeholder={f.placeholder}
                                readOnly={saving}
                                onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
                              />
                            )}
                          </div>
                          {/* The one field whose answer the model can actually be made to compute. */}
                          {f.key === 'functional_unit' ? (
                            <ReferenceQuantity database={props.database} />
                          ) : null}
                        </Fragment>
                      ))}
                    </div>
                  </section>
                ))}
              </>
            )}
          </div>
        </div>

        <div className="sheet-foot">
          {error ? (
            <span className="model-info-error">{error}</span>
          ) : (
            <span className="meta">
              Saved when you close · read by the assistant on its next run · {progress.done} of{' '}
              {progress.total} fields filled
            </span>
          )}
          <div className="acts">
            <button className="btn primary" disabled={saving} onClick={() => void close()}>
              {saving ? 'Saving…' : 'Close'}
            </button>
          </div>
        </div>
      </div>
      {picking ? <ComparisonPicker database={props.database} onClose={() => setPicking(false)} /> : null}
    </div>
  )
}
