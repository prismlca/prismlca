import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { fetchQuery } from '../lib/server/useQuery'
import { useSettings, fmtSig } from '../lib/settings'
import { LockIcon } from '../components/icons'
import UnitCombo from '../components/UnitCombo'
import { useLocationSuggestions } from '../lib/useLocationSuggestions'
import EditableField from './EditableField'
import ReferenceProduct from './ReferenceProduct'
import { useAmountEditor } from './useAmountEditor'
import { asReferenceRow } from '../lib/referenceProduct'
import type { ParamName } from '../lib/formula'
import SourceChip from '../components/SourceChip'
import FlowProperties from './FlowProperties'
import FieldLink from './FieldLink'
import FlowSortControl, { FLOW_TOOLS_MIN, type FlowSort, sortFlows } from './FlowSort'
import FlowPicker from './FlowPicker'
import { useFlowNote } from './useFlowNote'
import { mutationRunner } from '../lib/mutation'
import { errMsg } from '../lib/errors'
import { shortUnit } from '../lib/units'

/**
 * Inline foreground-process editor (right inspector). Umberto-inspired layout — a process shown
 * as its reference **product** (ReferenceProduct) plus its **inputs** — but modern: everything is edited
 * inline (no modal cascade), and each amount can be switched to a **formula** (`fx`) so global variables
 * parameterise the flow (useAmountEditor). Background datasets render read-only.
 */
interface FlowInput {
  database: string
  code: string
  name: string | null
  unit: string | null
  location: string | null
  categories?: string[]
}
interface Exchange {
  uid: string
  type: string // production | technosphere | biosphere
  direction: 'input' | 'output'
  amount: number
  formula: string | null
  /** Why this amount is what it is — the sign of a waste flow, a proxy dataset, a formula's intent. */
  comment: string | null
  input: FlowInput
}
interface Detail {
  activity: {
    database: string
    code: string
    name: string | null
    product: string | null
    location: string | null
    unit: string | null
    read_only: boolean
    /** The process description: what it represents and where its data comes from. */
    comment?: string | null
    isic?: string | null
    cpc?: string | null
    cpc_name?: string | null
    /** Flows the import could not link, parked with the dataset — see the import wizard. */
    unmatched_from_import?: number
  }
  exchanges: Exchange[]
}

interface ClassCode {
  code: string
  name: string
}
// The ISIC-section (21 fixed) and CPC vocabularies are process-independent, so fetch once and
// share across every editor instance instead of re-hitting the API on each selection.
let ISIC_SECTIONS: ClassCode[] | null = null
let CPC_VOCAB: ClassCode[] | null = null
async function loadUnitVocab(): Promise<string[]> {
  // Through the shared query cache — the private module cache this replaces could never be
  // invalidated when a new unit entered the model.
  return (await fetchQuery('/api/v1/model/unit-vocabulary')).units
}
async function loadClassVocab(): Promise<{ isic: ClassCode[]; cpc: ClassCode[] }> {
  if (!ISIC_SECTIONS)
    ISIC_SECTIONS = (await api<{ sections: ClassCode[] }>('GET', '/api/v1/model/isic-sections')).sections
  if (!CPC_VOCAB) CPC_VOCAB = (await api<{ cpc: ClassCode[] }>('GET', '/api/v1/model/cpc-vocabulary')).cpc
  return { isic: ISIC_SECTIONS, cpc: CPC_VOCAB }
}

/**
 * ISIC/CPC classifier for a foreground process. ecoinvent activities carry these already; hand-built
 * foreground processes don't, so their own direct impact falls into "(no ISIC)"/"(no CPC)" in the
 * stacked-bar breakdown. Setting them here puts that slice into a real class. ISIC is a fixed
 * 21-section dropdown; CPC is a free autocomplete over the ecoinvent CPC vocabulary.
 */
function Classification({
  isic,
  cpc,
  cpcName,
  onSave
}: {
  isic: string | null
  cpc: string | null
  cpcName: string | null
  onSave: (patch: { isic?: string | null; cpc?: string | null; cpc_name?: string | null }) => void
}): JSX.Element {
  const [sections, setSections] = useState<ClassCode[]>(ISIC_SECTIONS ?? [])
  const [cpcVocab, setCpcVocab] = useState<ClassCode[]>(CPC_VOCAB ?? [])
  const cpcDisplay = cpc ? `${cpc}${cpcName ? ` — ${cpcName}` : ''}` : ''
  const [cpcText, setCpcText] = useState(cpcDisplay)
  useEffect(() => setCpcText(cpcDisplay), [cpcDisplay])
  useEffect(() => {
    let alive = true
    void loadClassVocab()
      .then((v) => {
        if (!alive) return
        setSections(v.isic)
        setCpcVocab(v.cpc)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  const commitCpc = (): void => {
    const t = cpcText.trim()
    if (!t) {
      if (cpc) onSave({ cpc: null, cpc_name: null })
      return
    }
    const codePart = t.split('—')[0].trim().split(/\s/)[0]
    const entry =
      cpcVocab.find((e) => `${e.code} — ${e.name}` === t) || cpcVocab.find((e) => e.code === codePart)
    const next = entry ? { cpc: entry.code, cpc_name: entry.name } : { cpc: codePart || t, cpc_name: null }
    if (next.cpc !== cpc || next.cpc_name !== (cpcName ?? null)) onSave(next)
  }

  const cpcOptions = useMemo(() => cpcVocab.map((e) => `${e.code} — ${e.name}`), [cpcVocab])

  return (
    <div className="efield-row class-row">
      <div className="efield">
        <label title="Puts this process's own impact into an ISIC section in the stacked breakdown">
          ISIC section
        </label>
        <select
          className="search-sel"
          value={isic ?? ''}
          onChange={(e) => onSave({ isic: e.target.value || null })}
        >
          <option value="">— none —</option>
          {sections.map((s) => (
            <option key={s.code} value={s.code}>
              {s.code} — {s.name}
            </option>
          ))}
        </select>
      </div>
      <div className="efield">
        <label title="Type a code or name; pick from the ecoinvent CPC vocabulary">CPC class</label>
        {/* A scrolling list rather than a <datalist>: Electron's datalist popup does not scroll. */}
        <UnitCombo
          value={cpcText}
          units={cpcOptions}
          max={50}
          ariaLabel="CPC class"
          placeholder="code or name…"
          onChange={setCpcText}
          onCommit={commitCpc}
        />
      </div>
    </div>
  )
}

/** How much of a background dataset's documentation the inspector shows before it defers to the details
 * window. ecoinvent comments run to several hundred words — a whole methodology section, sometimes — and in a
 * 380px panel that buries the flows underneath it. */
const DESCRIPTION_WORDS = 40

/** A background dataset's description: the first words of it, then the way to all of it.
 *
 * Read-only either way, so there is nothing to lose by shortening it. A shortened text ends in "more", which
 * opens the details window that already exists — the same window as Details on the name's label line and in
 * the process search results. A text shown whole needs no link of its own: Details above it reaches the
 * rest of the dataset (classifications, exchanges, its own metadata). */
function BackgroundDescription({ text, onOpen }: { text: string; onOpen?: () => void }): JSX.Element {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const cut = words.length > DESCRIPTION_WORDS
  const shown = cut ? words.slice(0, DESCRIPTION_WORDS).join(' ') + ' …' : text.trim()
  return (
    <div className="efield">
      <label>Description</label>
      {/* "more" sits *in* the paragraph, right after the ellipsis: that is where the sentence stops and
          where the question "and the rest?" is asked. On its own line it read as a control for the whole
          panel rather than for the text it belongs to. */}
      <div className="val descr-val">
        {shown || '—'}
        {cut && onOpen ? (
          <button
            type="button"
            className="descr-more"
            title="Shortened — open the details for the full text"
            onClick={onOpen}
          >
            more
          </button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The location of an own process: free text, as it always was — with suggestions from every location
 * the workspace uses (see useLocationSuggestions), loaded when the field is first focused.
 */
function LocationField({
  value,
  readOnly,
  onSave
}: {
  value: string | null
  readOnly: boolean
  onSave: (v: string) => void
}): JSX.Element {
  const [v, setV] = useState(value ?? '')
  useEffect(() => setV(value ?? ''), [value])
  const { codes, describe, load } = useLocationSuggestions()
  return (
    <div className="efield">
      <label>Location</label>
      {readOnly ? (
        <div className="val">{value ?? '—'}</div>
      ) : (
        <UnitCombo
          value={v}
          units={codes}
          describe={describe}
          max={12}
          onFocus={load}
          onChange={setV}
          onCommit={() => {
            if (v !== (value ?? '')) onSave(v)
          }}
        />
      )}
    </div>
  )
}

/** Exported for the amount-field test: what a typed amount becomes is worth asserting on a mounted
 *  field rather than on the parser alone — the parser was never the part that was wrong. */
export function FlowRow({
  flow,
  readOnly,
  reference,
  duplicate,
  onAmount,
  onFormula,
  onComment,
  onRemove,
  params = null,
  noteColumn = false
}: {
  flow: Exchange
  readOnly: boolean
  reference: boolean
  duplicate?: boolean
  /** Read-only rows only: the dataset has flow comments, so every row keeps a column for the bubble. */
  noteColumn?: boolean
  /** The model's parameters, for the formula field's completion and name check; null while unknown. */
  params?: ParamName[] | null
  onAmount: (uid: string, amount: number) => void
  onFormula: (uid: string, formula: string | null) => void
  onComment: (uid: string, comment: string) => void
  onRemove: (uid: string) => void
}): JSX.Element {
  // The reason for this amount. The field existed in the data and the report already read it, but
  // nothing could write it, so a waste flow's sign rationale or a proxy justification had to go into the
  // consuming process's description among unrelated sourcing text.
  const note = useFlowNote({ comment: flow.comment, readOnly, onSave: (c) => onComment(flow.uid, c) })
  const amount = useAmountEditor({ flow, readOnly, reference, params, onAmount, onFormula })

  return (
    <div
      className={`flow${reference ? ' ref' : ''}${readOnly ? ' ro' : ''}${readOnly && noteColumn ? ' notes' : ''}`}
    >
      {/* The compartment rides in the tooltip, not the row: two "Benzene" lines in this list are
          usually one to air and one to water, and the row is too narrow to say so in print.
          Hovering the name answers it without a symbol taking space. The location is in the
          tooltip too, because its chip leaves the row when the name needs the room. */}
      <div
        className="flow-name"
        title={`${flow.input.name ?? ''}${flow.input.location ? ` [${flow.input.location}]` : ''}${
          flow.input.categories?.length ? ` · ${flow.input.categories.join(' / ')}` : ''
        } (${flow.type})`}
      >
        <span className="flow-name-text">
          {duplicate ? (
            <span
              className="flow-dup"
              title="This flow is listed more than once in this process — the amounts add up in the result. Consider merging them into one entry."
            >
              ⚠
            </span>
          ) : null}
          {flow.input.name ?? flow.input.code}
        </span>
        {flow.input.location ? <span className="flow-geo">{flow.input.location}</span> : null}
      </div>
      {amount.cell}
      {/* The canvas arrows' short form (kg, kWh, tkm); the stored long form rides in the tooltip. */}
      <div className="flow-unit" title={flow.input.unit ?? undefined}>
        {shortUnit(flow.input.unit) ?? ''}
      </div>
      {/* A read-only row has no remove button and its grid no column for it (`.flow.ro`): every row of
          a read-only dataset is read-only, so nothing below needs a spacer to stay aligned. Its comment
          column is there only when the dataset has a comment to show (`.flow.ro.notes`), and then a row
          without one keeps its cell with a spacer. */}
      {readOnly && !noteColumn ? null : (note.button ?? <span />)}
      {readOnly ? null : !reference ? (
        <button className="flow-del" title="Remove input" onClick={() => onRemove(flow.uid)}>
          ×
        </button>
      ) : (
        <span className="flow-del-spacer" />
      )}
      {note.body}
      {amount.editor}
    </div>
  )
}

export default function ActivityEditor({
  database,
  code,
  kind,
  refresh,
  onChanged,
  onShowDetails
}: {
  database: string
  code: string
  /** The kind of the database the process lives in — `background`, `library` or `foreground` — from the
   *  Workbench's database list. Names the source at the top of the inspector; without
   *  it the read-only flag decides, which cannot tell My processes from a model's own process. */
  kind?: string
  refresh?: number
  onChanged: () => void
  /** Opens the process-details window — owned by the Workbench and shared with the model search, the
   *  contribution tree and the model list, so a background dataset is documented in one place only. */
  onShowDetails?: (target: { database: string; code: string }) => void
}): JSX.Element {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'inputs' | 'outputs'>('inputs')
  const [showProps, setShowProps] = useState(false)
  const [addFlow, setAddFlow] = useState<'input' | 'output' | null>(null)
  // The backend's warning after a unit change, with the unit it was about: shown while that unit stands.
  const [unitNote, setUnitNote] = useState<{ unit: string; text: string } | null>(null)
  // One sort for both tabs; null = exchange order.
  const [sortBy, setSortBy] = useState<FlowSort>(null)
  // ISIC section names for the read-only display ("C — Manufacturing" instead of a bare letter).
  const [isicSections, setIsicSections] = useState<ClassCode[]>(ISIC_SECTIONS ?? [])
  useEffect(() => {
    if (!ISIC_SECTIONS)
      void loadClassVocab()
        .then((v) => setIsicSections(v.isic))
        .catch(() => {})
  }, [])
  // Known units for the unit field's autocomplete; strictness comes from Settings → Modelling.
  const { modelling, round } = useSettings()
  const [unitVocab, setUnitVocab] = useState<string[]>([])
  // The model's parameters, for the formula fields: names to complete, and the check that a formula
  // names only what exists. Null until the list is here (or when the database has none), so that a
  // request still in flight does not flag every name as unknown.
  const [params, setParams] = useState<ParamName[] | null>(null)
  useEffect(() => {
    let live = true
    api<{ name: string; amount: number | null; unit: string | null }[]>(
      'GET',
      `/api/v1/params?database=${encodeURIComponent(database)}`
    )
      .then((list) => {
        if (!live) return
        setParams(
          list.map((p) => ({
            name: p.name,
            // A parameter's value, so the Parameters digits — the same figure the Parameters page shows.
            hint:
              p.amount == null
                ? undefined
                : `${fmtSig(p.amount, round.parameters)}${p.unit ? ` ${p.unit}` : ''}`
          }))
        )
      })
      .catch(() => live && setParams(null))
    return () => {
      live = false
    }
  }, [database, refresh, round.parameters])
  useEffect(() => {
    // Served from the shared query cache after the first editor opens; free thereafter.
    void loadUnitVocab()
      .then(setUnitVocab)
      .catch(() => {})
  }, [])

  const load = useCallback(async () => {
    const d = await api<Detail>(
      'GET',
      `/api/v1/model/activities/${encodeURIComponent(database)}/${encodeURIComponent(code)}`
    )
    setDetail(d)
  }, [database, code])

  useEffect(() => {
    setError(null)
    void load().catch((e) => setError(errMsg(e)))
    // `refresh` bumps on any model mutation (e.g. undo/redo) so the list reflects the backend.
  }, [load, refresh])

  const run = useMemo(
    () =>
      mutationRunner({
        setError,
        after: async () => {
          await load()
          onChanged()
        }
      }),
    [load, onChanged]
  )

  if (!detail) {
    return (
      <div className="insp">
        <div className="eyebrow">Selected · process</div>
        <p className="empty">{error ?? 'Loading…'}</p>
      </div>
    )
  }

  const a = detail.activity
  const ro = a.read_only
  // A background dataset's flows carry the source's own notes; their bubbles take a column only when
  // there is one to show, so a dataset without any keeps the room for its names.
  const roNotes = ro && detail.exchanges.some((e) => !!e.comment)
  const production = detail.exchanges.filter((e) => e.type === 'production')
  // The process's own production exchange is its reference. One pointing at a separate product node keeps its
  // own name and unit, so it stays a row below the block rather than being labelled with this process's product.
  const reference = production.find((e) => e.input.database === database && e.input.code === code)
  // Everything else splits by LCA direction: things drawn in vs. things leaving
  // the process besides the reference product (emissions, waste, co-products).
  // Fall back to the sign if an older backend didn't send `direction`.
  const dirOf = (e: Exchange): 'input' | 'output' => e.direction ?? (e.amount < 0 ? 'output' : 'input')
  const inputs = detail.exchanges.filter((e) => e.type !== 'production' && dirOf(e) === 'input')
  const outputs = detail.exchanges.filter((e) => e.type !== 'production' && dirOf(e) === 'output')
  const unsorted = tab === 'inputs' ? inputs : outputs
  const rows = sortFlows(unsorted, sortBy)
  const isicLabel = (c: string): string => {
    const name = isicSections.find((s) => s.code === c)?.name
    return name ? `${c} — ${name}` : c
  }

  // Flag flows that appear more than once (same flow + type) — their amounts silently sum.
  const flowKey = (e: Exchange): string => `${e.type}|${e.input.database}|${e.input.code}`
  const counts = new Map<string, number>()
  for (const e of detail.exchanges) counts.set(flowKey(e), (counts.get(flowKey(e)) ?? 0) + 1)
  const isDuplicate = (e: Exchange): boolean => (counts.get(flowKey(e)) ?? 0) > 1

  const saveField = (field: string, value: string): void =>
    void run(async () => {
      const r = await api<{ warning?: string }>('POST', '/api/v1/model/activities/fields', {
        database,
        code,
        [field]: value
      })
      // A new unit keeps the number of every exchange that consumes this process and changes what it
      // means. The backend counts those consumers and warns; the warning used to end in a discarded
      // return value, so the one change that silently rescales a model said nothing.
      if (field === 'unit') setUnitNote(r?.warning ? { unit: value, text: r.warning } : null)
    })
  // Classification sets all three override fields at once, so merge the patch with the current
  // values (a missing field would otherwise be cleared server-side).
  const saveClass = (patch: { isic?: string | null; cpc?: string | null; cpc_name?: string | null }): void =>
    void run(() =>
      api('POST', '/api/v1/model/activities/classification', {
        database,
        code,
        isic: a.isic ?? null,
        cpc: a.cpc ?? null,
        cpc_name: a.cpc_name ?? null,
        ...patch
      })
    )
  const onAmount = (uid: string, amount: number): void =>
    void run(() =>
      api('POST', '/api/v1/model/exchanges/amount', {
        activity_database: database,
        activity_code: code,
        uid,
        amount
      })
    )
  const onFormula = (uid: string, formula: string | null): void =>
    void run(async () => {
      await api('POST', '/api/v1/params/exchange-formula', {
        activity_database: database,
        activity_code: code,
        uid,
        formula
      })
      await api('POST', `/api/v1/params/recalculate?database=${encodeURIComponent(database)}`)
    })
  const onComment = (uid: string, comment: string): void =>
    void run(() =>
      api('POST', '/api/v1/model/exchanges/comment', {
        activity_database: database,
        activity_code: code,
        uid,
        comment
      })
    )
  const onRemove = (uid: string): void =>
    void run(() =>
      api('POST', '/api/v1/model/exchanges/remove', {
        activity_database: database,
        activity_code: code,
        uid
      })
    )

  return (
    <div className="insp editor">
      {/* The padlock says read-only; the chip says which database. */}
      <div className="eyebrow with-chip">
        {ro ? (
          <>
            <LockIcon /> Background
          </>
        ) : (
          'Process'
        )}
        <SourceChip database={database} kind={kind ?? (ro ? 'background' : 'foreground')} />
      </div>
      {/* Details a second time, on the name's label line — the same link as Properties at the reference product. The one
          after the description answers "and the rest of this text?"; this one is where you look when the
          *dataset* is the question, before you have read anything at all. */}
      <EditableField
        label="Name"
        value={a.name}
        readOnly={ro}
        onSave={(v) => saveField('name', v)}
        action={
          ro && onShowDetails ? (
            <FieldLink
              label="Details"
              title="All details of this dataset"
              onClick={() => onShowDetails({ database, code })}
            />
          ) : undefined
        }
      />
      {showProps ? (
        <FlowProperties
          database={database}
          code={code}
          onClose={() => setShowProps(false)}
          onChanged={onChanged}
        />
      ) : null}
      {/* The description. A foreground process has no documentation unless somebody writes it, and the
          report's writers are handed this verbatim — it is what lets a chapter explain a process rather
          than name it. Background datasets bring their own text, so there it is read-only. */}
      {ro ? (
        <BackgroundDescription
          text={a.comment ?? ''}
          onOpen={onShowDetails ? () => onShowDetails({ database, code }) : undefined}
        />
      ) : (
        <EditableField
          label="Description"
          value={a.comment ?? ''}
          readOnly={false}
          multiline
          onSave={(v) => saveField('comment', v)}
          hint="What this process represents and where its data comes from — own data, estimate, or a source with its URL"
        />
      )}
      {/* Half width, as it was beside the unit: the unit went to the reference product it belongs to. */}
      <div className="efield-row">
        <LocationField value={a.location} readOnly={ro} onSave={(v) => saveField('location', v)} />
      </div>
      {ro ? (
        <div className="efield-row">
          <div className="efield">
            <label>ISIC section</label>
            <div className="val">{a.isic ? isicLabel(a.isic) : '—'}</div>
          </div>
          <div className="efield">
            <label>CPC class</label>
            <div className="val">{a.cpc ? `${a.cpc}${a.cpc_name ? ` — ${a.cpc_name}` : ''}` : '—'}</div>
          </div>
        </div>
      ) : (
        <Classification
          isic={a.isic ?? null}
          cpc={a.cpc ?? null}
          cpcName={a.cpc_name ?? null}
          onSave={saveClass}
        />
      )}

      <ReferenceProduct
        product={a.product}
        unit={a.unit}
        flow={reference}
        otherProduction={production.length > 0}
        readOnly={ro}
        unitVocab={unitVocab}
        restrictUnits={!modelling.freeUnits}
        params={params}
        // Gone again once the unit is not the one the warning was about, e.g. after an undo.
        unitNotice={unitNote && unitNote.unit === a.unit ? unitNote.text : null}
        onField={saveField}
        onAmount={onAmount}
        onFormula={onFormula}
        onComment={onComment}
        onShowProperties={() => setShowProps(true)}
      />
      {/* Production exchanges besides the process's own (an import can bring them) are rows with their own
          names and units: the block edits only the process's own, the one every other flow is per. */}
      {production
        .filter((f) => f !== reference)
        .map((f) => (
          <FlowRow
            key={f.uid}
            flow={asReferenceRow(f, a)}
            readOnly={ro}
            reference
            noteColumn={roNotes}
            params={params}
            onAmount={onAmount}
            onFormula={onFormula}
            onComment={onComment}
            onRemove={onRemove}
          />
        ))}

      {a.unmatched_from_import ? (
        // Said here, where the flows are edited, not only in the health check: the list below looks
        // complete and carries less burden than the imported file stated.
        <p className="settings-hint warn">
          {a.unmatched_from_import} flow{a.unmatched_from_import === 1 ? '' : 's'} from the import{' '}
          {a.unmatched_from_import === 1 ? 'is' : 'are'} not linked and not in this list.
        </p>
      ) : null}
      <div className="flow-tabs" role="tablist">
        <button
          role="tab"
          className={`flow-tab${tab === 'inputs' ? ' on' : ''}`}
          aria-selected={tab === 'inputs'}
          onClick={() => setTab('inputs')}
        >
          Inputs <span className="flow-count">{inputs.length}</span>
        </button>
        <button
          role="tab"
          className={`flow-tab${tab === 'outputs' ? ' on' : ''}`}
          aria-selected={tab === 'outputs'}
          onClick={() => setTab('outputs')}
        >
          Outputs <span className="flow-count">{outputs.length}</span>
        </button>
        {unsorted.length >= FLOW_TOOLS_MIN ? <FlowSortControl value={sortBy} onChange={setSortBy} /> : null}
      </div>
      <div className="flow-list">
        {rows.length ? (
          rows.map((f) => (
            <FlowRow
              key={f.uid}
              flow={f}
              readOnly={ro}
              reference={false}
              duplicate={isDuplicate(f)}
              noteColumn={roNotes}
              params={params}
              onAmount={onAmount}
              onFormula={onFormula}
              onComment={onComment}
              onRemove={onRemove}
            />
          ))
        ) : (
          <p className="empty">
            {tab === 'inputs' ? 'No inputs yet.' : 'No outputs besides the reference product.'}
          </p>
        )}
      </div>
      {!ro ? (
        <>
          <button className="add-flow-btn" onClick={() => setAddFlow(tab === 'inputs' ? 'input' : 'output')}>
            + Add {tab === 'inputs' ? 'input' : 'output'} flow
          </button>
          <p className="hint-sm">
            Pick an existing elementary flow{tab === 'inputs' ? ' or create a product flow' : ''}, or drag a
            process from the canvas. Toggle <b>fx</b> to parameterise a flow with a formula.
          </p>
        </>
      ) : null}
      {addFlow ? (
        <FlowPicker
          database={database}
          code={code}
          direction={addFlow}
          existing={detail.exchanges.map((e) => ({
            uid: e.uid,
            type: e.type,
            amount: e.amount,
            input: { database: e.input.database, code: e.input.code }
          }))}
          onClose={() => setAddFlow(null)}
          onAdded={() => run(async () => {})}
        />
      ) : null}

      {error ? <div className="editor-err">{error}</div> : null}
    </div>
  )
}
