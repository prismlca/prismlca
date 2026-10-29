import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent
} from 'react'
import { api, type AuditEntry } from '../lib/api'
import {
  AddIcon,
  ChevronIcon,
  InfoIcon,
  ModelIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon
} from '../components/icons'
import ConfirmDialog, { type ConfirmSpec } from './ConfirmDialog'
import AuditLog from '../components/AuditLog'
import { IdleRoundedInput } from '../components/IdleRoundedInput'
import ParamRuleEditor, {
  describeRule,
  ruleChoices,
  ruleViolation,
  toNumber,
  type ParamRule
} from '../components/ParamRule'
import { modelKey, usePersisted } from '../lib/persist'
import { mutationRunner } from '../lib/mutation'
import { parseAmount } from '../lib/numberFormat'
import FormulaInput from '../components/FormulaInput'
import { lintFormula, type ParamName } from '../lib/formula'
import { useSettings, fmtSig } from '../lib/settings'

interface Param {
  name: string
  amount: number | null
  formula: string | null
  group_id: string | null
  group: string | null
  description: string | null
  unit: string | null
  /** What this parameter's value is allowed to be. `{}` — the state of every parameter written before
   *  rules existed — means any number. Enforced by the backend on every path that writes a value; here it
   *  refuses one where it is typed, with the field still on screen. */
  rule?: ParamRule
  /** Exchanges whose formula names this parameter — `?with_usage=true`, computed by the backend. */
  used_by?: { activity_code: string; activity_name: string; input: string; formula: string }[]
  /** And the other parameters that name it — a volume and a density drive a mass, not an exchange. */
  used_by_parameters?: { name: string; formula: string }[]
}
interface Group {
  id: string
  name: string
  order: number
}

const EMPTY: {
  name: string
  amount: string
  formula: string
  unit: string
  description: string
  group_id: string
  rule: ParamRule
} = {
  name: '',
  amount: '',
  formula: '',
  unit: '',
  description: '',
  group_id: '',
  // The rule the parameter is born with: a value is refused from the first one on, which is the
  // point — a rule added afterwards has to argue with numbers that are already in the model.
  rule: {}
}

/** Inline editor cell: commits on blur / Enter, reverts on Escape. `multiline` grows on focus. */
function CellInput({
  initial,
  onCommit,
  numeric,
  mono,
  placeholder,
  multiline,
  autoFocus,
  check,
  onRefused,
  idle
}: {
  initial: string
  onCommit: (v: string) => void
  numeric?: boolean
  /** The stored value rounded to the Parameters digits, shown while the field is idle and untouched. */
  idle?: string
  mono?: boolean
  placeholder?: string
  multiline?: boolean
  autoFocus?: boolean
  /** Nothing: a numeric cell is a text field now (see the input below), so there is no stepper to
   *  bound. What the rule allows is enforced by `check`, which the backend enforces again. */
  /** Why this text may not be written, or null. A refused commit reverts and says why — the value the
   *  parameter has is never replaced by one the rule forbids. */
  check?: (v: string) => string | null
  /** Where to say it. Reported upward rather than drawn here: the value column is 128px wide, and a
   *  sentence in it either stacks one word per line or reaches over the description beside it. The
   *  row draws it under the field, across the width it has. */
  onRefused?: (why: string | null) => void
}): JSX.Element {
  const [v, setV] = useState(initial)
  const [why, setWhy] = useState<string | null>(null)
  // Escape has to beat the blur it triggers. `setV(initial)` does not reach `commit` before the browser
  // fires focusout, so the commit still saw the abandoned text and WROTE it — measured:
  // typing 9.99 into a parameter and pressing Escape posted 9.99. A ref is the only thing that crosses
  // that gap; state is one render too late by construction.
  const abandoned = useRef(false)
  // Keep in sync when the underlying value changes (e.g. a recalculated amount).
  useEffect(() => setV(initial), [initial])
  const commit = (): void => {
    if (abandoned.current) {
      abandoned.current = false
      setV(initial)
      setWhy(null)
      onRefused?.(null)
      return
    }
    let out = mono ? v.replace(/\s+/g, ' ').trim() : v
    if (numeric && out.trim()) {
      // The one reading of a typed number in this app. What comes out is plain ASCII ("0,5" → "0.5"),
      // so `check` and every caller's `Number(v)` see the same digits the person meant.
      const n = parseAmount(out)
      if (n === null) {
        setWhy('not a number')
        onRefused?.('not a number')
        setV(initial)
        return
      }
      out = String(n)
      setV(out) // "0,5" reads back as "0.5", including when it turned out to be the stored value
    }
    if (out === initial) return
    const refused = check?.(out) ?? null
    if (refused) {
      setWhy(refused)
      onRefused?.(refused)
      setV(initial)
      return
    }
    setWhy(null)
    onRefused?.(null)
    onCommit(out)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
    }
    if (e.key === 'Escape') {
      abandoned.current = true
      setV(initial)
      ;(e.target as HTMLElement).blur()
    }
  }
  if (multiline) {
    return (
      <textarea
        className={`pmulti ${mono ? 'mono' : ''}`.trim()}
        value={v}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={onKey}
      />
    )
  }
  return (
    <>
      <IdleRoundedInput
        idle={idle !== undefined && v === initial ? idle : null}
        className={`${numeric ? 'num' : ''} ${mono ? 'mono' : ''}${why ? ' refused' : ''}`.trim()}
        // Always text. `type="number"` handed the meaning of a comma to Chromium's locale, so the
        // same keystrokes gave 0.5 on one machine and 5 on another; `inputMode` still asks a touch
        // keyboard for digits.
        type="text"
        inputMode={numeric ? 'decimal' : undefined}
        value={v}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-invalid={why ? true : undefined}
        title={why ?? undefined}
        onChange={(e) => {
          setV(e.target.value)
          if (why) {
            setWhy(null)
            onRefused?.(null)
          }
        }}
        onBlur={commit}
        onKeyDown={onKey}
      />
    </>
  )
}

/** The inline formula editor of a row: `CellInput`'s commit rules (blur/Enter write, Escape reverts) on a
 *  field that completes parameter names and refuses a broken formula before it is sent. */
function FormulaCell({
  initial,
  params,
  self,
  onCommit
}: {
  initial: string
  params: ParamName[]
  self: string
  onCommit: (v: string) => void
}): JSX.Element {
  const [v, setV] = useState(initial)
  useEffect(() => setV(initial), [initial])
  return (
    <FormulaInput
      className="pmulti mono"
      value={v}
      onChange={setV}
      params={params}
      self={self}
      placeholder="e.g. mass * 2 (drives the value)"
      onCommit={(problem) => {
        if (problem) return // said under the field; nothing is written
        const out = v.replace(/\s+/g, ' ').trim()
        if (out !== initial) onCommit(out)
      }}
      onAbandon={() => setV(initial)}
    />
  )
}

/** Characters past which a description is assumed to run beyond three lines when the cell cannot be measured
 *  (jsdom, or before layout). The real decision is the measured overflow below. */
const DESC_CLAMP_CHARS = 180

/**
 * A parameter's description, clamped to three lines (V430). A description that cites its sources carries
 * their URLs, and three datasheet links made one row 740 px high — the table became a page of comments.
 * The full text stays one click (or Enter) away on the "more" toggle and in the title; editing is unchanged,
 * it lives in the edit panel behind the pencil.
 */
function DescCell({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(text.length > DESC_CLAMP_CHARS)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    // Measured only while clamped; an unlaid-out element (height 0) keeps the length estimate.
    if (el.clientHeight > 0) setOverflows(el.scrollHeight > el.clientHeight + 1)
    else setOverflows(text.length > DESC_CLAMP_CHARS)
  }, [text, open])
  return (
    <>
      <span ref={ref} className={`pc-desc-text${open ? ' open' : ''}`} title={open ? undefined : text}>
        {text}
      </span>
      {overflows || open ? (
        <button className="pc-desc-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'less' : 'more'}
        </button>
      ) : null}
    </>
  )
}

export default function Parameters({
  activeDb,
  rev,
  onChanged,
  onJumpToProcess
}: {
  activeDb: string | null
  /** Bumped by the Workbench on every model mutation it made itself — an Undo or a Redo from the
   *  toolbar above this page included. Without it this page kept showing the value the undo had just
   *  taken back (measured: the row said 4.25 while the model held 3.95), and its own audit list was
   *  missing the line the undo had written. */
  rev?: number
  onChanged?: () => void
  /** Open the Model page with this process selected and centred. */
  onJumpToProcess?: (code: string) => void
}): JSX.Element {
  const [rows, setRows] = useState<Param[]>([])
  const [groups, setGroups] = useState<Group[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [f, setF] = useState({ ...EMPTY })
  const [adding, setAdding] = useState(false) // "New parameter" panel open
  const [newGroup, setNewGroup] = useState<string | null>(null) // null = the field is closed
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null) // param name being edited inline (fields + comment)
  const [renameGid, setRenameGid] = useState<string | null>(null) // group being renamed inline
  const [dragName, setDragName] = useState<string | null>(null) // parameter being dragged
  const [dropGid, setDropGid] = useState<string | null | undefined>(undefined) // section hovered (null = Ungrouped)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  /** Did the pointer go down in a row's first column? A row is only draggable from there — see onDragStart. */
  const grabbed = useRef(false)
  /** The one refused value and the row it belongs to: only one field is edited at a time, so one slot is
   *  enough — and the message is drawn by the row, under the field, not inside the 128px value column. */
  const [refused, setRefused] = useState<{ name: string; why: string } | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  // Displayed numbers follow Settings → General, "Parameters". Its own dial rather than the exchange
  // one: a parameter is read while it is being set, where a long tail is noise, and an exchange
  // amount is read while a result is checked, where it can be the point.
  // Only the DISPLAY: what is stored, sent and computed with is the full number, and the title
  // attribute shows it unrounded.
  const { round } = useSettings()
  // What the formula fields complete and check against — every parameter of the model, with its value.
  const paramNames = useMemo<ParamName[]>(
    () =>
      rows.map((p) => ({
        name: p.name,
        hint:
          p.amount == null ? undefined : `${fmtSig(p.amount, round.parameters)}${p.unit ? ` ${p.unit}` : ''}`
      })),
    [rows, round.parameters]
  )
  // Which sections are folded away. Per model, and remembered across sessions: which groups you keep
  // shut is a working habit, not a preference to set — and a session that re-folded them would throw
  // away the one you deliberately left open. `null` = never touched, see the seeding effect below.
  const [shut, setShut] = usePersisted<string[] | null>(modelKey('prism.params.shut', activeDb), null)

  const load = useCallback(async () => {
    if (!activeDb) {
      setRows([])
      setGroups([])
      setAudit([])
      return
    }
    const q = `?database=${encodeURIComponent(activeDb)}`
    const [ps, gs, au] = await Promise.all([
      api<Param[]>('GET', `/api/v1/params${q}&with_usage=true`),
      api<Group[]>('GET', `/api/v1/params/groups${q}`),
      // A QUERY parameter, and it has to stay one: the route reads it from the query string, so
      // the same name in a request body silently returns the whole project's history and looks
      // exactly like a broken filter.
      api<AuditEntry[]>('GET', `/api/v1/model/audit${q}`)
    ])
    setRows(ps)
    setGroups(gs)
    setAudit(au)
  }, [activeDb])

  useEffect(() => {
    void load()
  }, [load])

  // The Workbench changed the model under this page — reload it. Kept apart from the effect above so
  // mounting does not fetch twice: `load` only changes identity with the model, `rev` only moves when
  // something outside this page wrote.
  const seenRev = useRef(rev)
  useEffect(() => {
    if (seenRev.current === rev) return
    seenRev.current = rev
    void load()
  }, [rev, load])

  // A click outside the parameter being edited closes its strip — the strip is a state of that one
  // row, and leaving it open while you work elsewhere on the page is the kind of thing you notice three
  // parameters later.
  //
  // On mousedown, but deferred by a tick: a field commits on blur, and blur happens as the focus leaves
  // during this very mousedown. Unmounting the strip synchronously would take the textarea away first and
  // lose what was typed into it.
  useEffect(() => {
    if (editing == null) return
    const away = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null
      // The formula field's completion list lives in <body> now, but is part of the row being edited.
      if (el?.closest('.prow-item.editing, .fx-combo-list')) return
      // A dialog raised *from* the row (delete confirmation) is not "outside" in any useful sense.
      if (el?.closest('.modal-backdrop, .sheet, .confirm')) return
      setTimeout(() => setEditing(null), 0)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [editing])

  const run = mutationRunner({
    setError: setErr,
    after: async () => {
      await load()
      onChanged?.()
    }
  })

  const add = (): Promise<void> =>
    run(async () => {
      if (!activeDb || !f.name.trim()) return
      // Unreadable text is not a zero: "abc" used to become 0 on the Enter path, which skipped the
      // button's own check.
      if (!f.formula && f.amount.trim() && parseAmount(f.amount) === null)
        throw new Error('The value is not a number — use 0.5 or 0,5.')
      if (newViolation) throw new Error(newViolation)
      await api('POST', '/api/v1/params', {
        database: activeDb,
        name: f.name.trim(),
        amount: f.formula ? undefined : (parseAmount(f.amount) ?? 0),
        formula: f.formula || undefined,
        unit: f.unit || undefined,
        description: f.description || undefined,
        group_id: f.group_id || undefined,
        rule: f.rule
      })
      setF({ ...EMPTY })
    })

  /** Edits made on a row since it was last loaded, per parameter: a second edit that lands before the
   *  first has been saved and re-read used to rebuild its request from the stale row and write the
   *  old amount back over the new one. Cleared once the list is reloaded. */
  const pendingEdits = useRef<Map<string, Partial<Param>>>(new Map())
  useEffect(() => {
    pendingEdits.current.clear()
  }, [rows])

  const patch = (p: Param, changes: Partial<Param>): Promise<void> =>
    run(async () => {
      if (!activeDb) return
      const earlier = pendingEdits.current.get(p.name) ?? {}
      const merged = { ...earlier, ...changes }
      pendingEdits.current.set(p.name, merged)
      const m = { ...p, ...merged }
      // A formula cleared on purpose is sent as "" so the backend removes it — `undefined` drops the
      // field from the JSON, which the backend reads as "leave the formula as it is".
      const clearingFormula = 'formula' in merged && !merged.formula
      await api('POST', '/api/v1/params', {
        database: activeDb,
        name: p.name,
        amount: m.formula ? undefined : (parseAmount(String(m.amount ?? '')) ?? 0),
        formula: clearingFormula ? '' : m.formula || undefined,
        unit: m.unit ?? '',
        description: m.description ?? '',
        // Only when this write is about the rule: sending it on every edit would re-assert a rule the
        // backend may have normalised, and `{}` on an unrelated edit would silently clear one.
        ...('rule' in changes ? { rule: changes.rule ?? {} } : {})
      })
    })

  const del = (name: string): void =>
    setConfirm({
      title: 'Delete parameter',
      message: `Delete the parameter “${name}”? Formulas that reference it will error until you fix them.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () =>
        void run(async () => {
          if (!activeDb) return
          await api('POST', '/api/v1/params/delete', { database: activeDb, name })
          if (editing === name) setEditing(null)
        })
    })

  const recalc = (): Promise<void> =>
    run(
      async () =>
        void (await api(
          'POST',
          `/api/v1/params/recalculate${activeDb ? `?database=${encodeURIComponent(activeDb)}` : ''}`
        ))
    )

  const addGroup = (): Promise<void> =>
    run(async () => {
      const name = (newGroup ?? '').trim()
      setNewGroup(null)
      if (!activeDb || !name) return
      await api('POST', '/api/v1/params/groups', { database: activeDb, name })
    })
  const renameGroup = (id: string, name: string): Promise<void> =>
    run(async () => {
      setRenameGid(null)
      if (activeDb && name.trim())
        await api('POST', '/api/v1/params/groups/rename', { database: activeDb, id, name: name.trim() })
    })
  const deleteGroup = (g: Group): void =>
    setConfirm({
      title: 'Delete group',
      message: `Delete the group “${g.name}”? Its parameters are kept (moved to Ungrouped).`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: () =>
        void run(async () => {
          if (activeDb) await api('POST', '/api/v1/params/groups/delete', { database: activeDb, id: g.id })
        })
    })
  const assign = (name: string, gid: string | null): Promise<void> =>
    run(async () => {
      if (!activeDb) return
      await api('POST', '/api/v1/params/group', { database: activeDb, name, group_id: gid })
    })

  const rowsFor = (gid: string | null): Param[] => rows.filter((p) => (p.group_id ?? null) === gid)

  // Search covers everything the row shows — name, value, unit, formula, comment and the processes it
  // drives — so a parameter is findable by what you remember about it, not only by its name.
  const q = query.trim().toLowerCase()
  const hit = (p: Param): boolean =>
    !q ||
    [
      p.name,
      p.unit,
      p.formula,
      p.description,
      // Both spellings: the row shows the rounded number, so that is what somebody types to find it,
      // and the stored one still matches a value pasted from elsewhere.
      p.amount == null ? '' : `${p.amount} ${fmtSig(p.amount, round.parameters)}`,
      ...(p.used_by ?? []).map((u) => u.activity_name)
    ].some((s) => (s ?? '').toLowerCase().includes(q))
  const hits = q ? rows.filter(hit).length : rows.length

  // The new parameter's value against the rule it is being given: the Add button is the commit here, so
  // this is where "you cannot even enter it" has to hold. A formula's RESULT is checked by the backend; its
  // text — unknown names, brackets, a decimal comma — is checked here, where it is typed.
  const valueViolation = f.formula
    ? null
    : // Text that is not a number is its own refusal. Without this the Add button stayed live and
      // wrote a 0, which is the failure the amount fields had everywhere.
      f.amount.trim() && toNumber(f.amount) === null
      ? 'not a number'
      : ruleViolation(f.rule, f.amount === '' ? 0 : toNumber(f.amount))
  const newViolation = f.formula
    ? (lintFormula(f.formula, paramNames, { self: f.name.trim() || undefined })?.message ?? null)
    : valueViolation

  const key = (gid: string | null): string => gid ?? '(ungrouped)'

  // The sections on screen, in display order: the groups, then the "Ungrouped" bucket (group_id null).
  // While searching, a section without a match says nothing — leave it out. An empty Ungrouped bucket is
  // noise too, except while a row is being dragged: then it is the target that takes a parameter back out
  // of its group.
  const visible = [
    ...groups.map((g) => ({ id: g.id as string | null, name: g.name })),
    { id: null, name: 'Ungrouped' }
  ]
    .map((sec) => {
      const all = rowsFor(sec.id)
      return { ...sec, all, shown: q ? all.filter(hit) : all }
    })
    .filter((sec) => (q ? sec.shown.length > 0 : !(sec.id === null && sec.all.length === 0 && !dragName)))

  // Every section that exists, search or no search — what the fold state is keyed on.
  const sectionKeys = [...groups.map((g) => g.id), ...(rowsFor(null).length ? [key(null)] : [])].join('|')

  // First visit to a model: everything folded but the first section. A list of a dozen groups should
  // open as its table of contents, not as its whole content. From then on your own last state counts —
  // and a group you create later starts open, because you create one in order to fill it.
  useEffect(() => {
    if (shut != null || !sectionKeys) return
    setShut(sectionKeys.split('|').slice(1))
  }, [shut, sectionKeys, setShut])

  // Functional update, not `shut` from this render: two carets clicked in the same tick both read the
  // same stale list, and the first fold was lost.
  const toggleShut = (gid: string | null): void =>
    setShut((prev) => {
      const base = prev ?? sectionKeys.split('|').slice(1)
      return base.includes(key(gid)) ? base.filter((k) => k !== key(gid)) : [...base, key(gid)]
    })

  const onDrop = (gid: string | null): void => {
    const name = dragName
    setDragName(null)
    setDropGid(undefined)
    if (name) void assign(name, gid)
  }

  // Allow a drop here and show the "move" cursor (without dropEffect the browser shows the
  // no-drop ⊘ sign even though onDrop fires). `notName` blocks dropping a row on itself.
  const dragOver = (e: DragEvent, gid: string | null, notName?: string): void => {
    if (dragName && dragName !== notName) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setDropGid(gid)
    }
  }

  const openAdd = (gid: string | null): void => {
    setF({ ...EMPTY, group_id: gid ?? '' })
    setAdding(true)
  }

  return (
    <div className="view pview">
      <div className="pmain">
        {/* Toolbar: what you look for and what you create on the left, the rarely-needed recompute
            parked on the right. Sticky, so a long list keeps its search box. */}
        <div className="ptool">
          <div className="psearch">
            <SearchIcon />
            <input
              value={query}
              placeholder="Search parameters…"
              disabled={!activeDb}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
            />
            {query ? (
              <button
                className="psearch-x"
                title="Clear search"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                ✕
              </button>
            ) : null}
          </div>
          {newGroup == null ? (
            <button className="btn sm" onClick={() => setNewGroup('')} disabled={!activeDb}>
              <AddIcon /> Group
            </button>
          ) : (
            <span className="pnewgrp">
              <input
                placeholder="Group name…"
                value={newGroup}
                autoFocus
                onChange={(e) => setNewGroup(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addGroup()
                  if (e.key === 'Escape') setNewGroup(null)
                }}
                onBlur={() => (newGroup.trim() ? void addGroup() : setNewGroup(null))}
              />
            </span>
          )}
          <button
            className="btn sm primary"
            onClick={() => (adding ? setAdding(false) : openAdd(null))}
            disabled={!activeDb}
          >
            <AddIcon /> Parameter
          </button>
          <span className="spacer" />
          <span className="recalc-hint">
            Rarely needed
            <span
              className="recalc-info"
              title="Values and formulas recalculate automatically whenever you edit a parameter. Use this only to force a refresh if something looks out of sync."
              aria-label="When is Recalculate needed?"
            >
              <InfoIcon />
            </span>
          </span>
          <button className="btn sm" onClick={recalc} disabled={!activeDb}>
            Recalculate
          </button>
        </div>

        {err ? (
          <div className="wb-error" onClick={() => setErr(null)}>
            {err}
          </div>
        ) : null}

        {!activeDb ? (
          <p className="empty" style={{ marginTop: 12 }}>
            Parameters belong to a model. Open or create a model to manage its parameters.
          </p>
        ) : (
          <>
            {/* New parameter — one panel with named fields, opened from the toolbar or from a group's
                own "+ Parameter" row (which pre-selects that group). */}
            {adding ? (
              <div className="pnew">
                <div className="pnew-grid">
                  <label className="pnew-f wide">
                    <span>Name</span>
                    <input
                      autoFocus
                      placeholder="e.g. mass_glass_bottle"
                      value={f.name}
                      onChange={(e) => setF({ ...f, name: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && f.name.trim() && !newViolation && void add()}
                    />
                  </label>
                  <label className="pnew-f">
                    <span>Value</span>
                    <input
                      className={`num${valueViolation ? ' refused' : ''}`}
                      inputMode="decimal"
                      placeholder="0"
                      value={f.amount}
                      disabled={!!f.formula}
                      aria-invalid={valueViolation ? true : undefined}
                      title={valueViolation ?? undefined}
                      onChange={(e) => setF({ ...f, amount: e.target.value })}
                    />
                  </label>
                  <label className="pnew-f">
                    <span>Unit</span>
                    <input
                      placeholder="kg"
                      value={f.unit}
                      onChange={(e) => setF({ ...f, unit: e.target.value })}
                    />
                  </label>
                  <label className="pnew-f wide">
                    <span>Or formula</span>
                    <FormulaInput
                      multiline={false}
                      className="mono"
                      placeholder="mass * 0.05"
                      value={f.formula}
                      params={paramNames}
                      self={f.name.trim() || undefined}
                      onChange={(v) => setF({ ...f, formula: v })}
                      // Enter adds, as it does in the Name field — unless the formula has a problem. A
                      // blur must not: tabbing on to the group field or to Cancel created the parameter
                      // before the author was done.
                      commitOnBlur={false}
                      onCommit={(problem) => {
                        if (!problem && f.name.trim()) void add()
                      }}
                    />
                  </label>
                  <label className="pnew-f sel">
                    <span>Group</span>
                    <select
                      className="search-sel"
                      value={f.group_id}
                      onChange={(e) => setF({ ...f, group_id: e.target.value })}
                    >
                      <option value="">— no group —</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <ParamRuleEditor rule={f.rule} onChange={(next) => setF({ ...f, rule: next })} />
                {valueViolation ? <p className="pc-refused pnew-refused">{valueViolation}</p> : null}
                <div className="pnew-acts">
                  <button
                    className="btn sm primary"
                    onClick={add}
                    disabled={!f.name.trim() || !!newViolation}
                  >
                    Add parameter
                  </button>
                  <button
                    className="btn sm"
                    onClick={() => {
                      setAdding(false)
                      setF({ ...EMPTY })
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {rows.length === 0 && groups.length === 0 ? (
              <div className="pblank">
                <p>No parameters yet.</p>
                <p className="hint-sm">
                  A parameter is a named value — a mass, a distance, a rate — that exchange formulas can
                  reference. Add one, then use its name in a formula on the canvas.
                </p>
              </div>
            ) : null}

            {q && hits === 0 ? <p className="empty">No parameter matches “{query}”.</p> : null}

            {visible.map((sec, i) => {
              const all = sec.all
              const secRows = sec.shown
              const g = groups.find((x) => x.id === sec.id)
              // Until the fold state has been seeded, the first section reads as open and the rest as
              // folded — so the seeding effect changes nothing you can see. A hit inside a folded group
              // unfolds it, otherwise the search would report matches you cannot get at.
              const folded = shut == null ? i > 0 : shut.includes(key(sec.id))
              const open = !folded || (!!q && secRows.length > 0)
              return (
                <section
                  className={`pgrp${open ? ' open' : ''}${dropGid === sec.id ? ' drop' : ''}`}
                  key={sec.id ?? 'ungrouped'}
                >
                  <div
                    className="pgrp-head"
                    onClick={() => toggleShut(sec.id)}
                    onDragOver={(e) => dragOver(e, sec.id)}
                    onDragLeave={() => setDropGid((d) => (d === sec.id ? undefined : d))}
                    onDrop={() => onDrop(sec.id)}
                  >
                    {/* The whole band toggles on click, but the caret is the real control — a div with
                        buttons inside it cannot be a button itself. */}
                    <button
                      className="pgrp-car"
                      aria-expanded={open}
                      aria-label={`${open ? 'Collapse' : 'Expand'} ${sec.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleShut(sec.id)
                      }}
                    >
                      <span className="car" aria-hidden="true">
                        <ChevronIcon />
                      </span>
                    </button>
                    {renameGid === sec.id && g ? (
                      <input
                        className="pgrp-rename"
                        defaultValue={g.name}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onBlur={(e) => void renameGroup(g.id, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                          if (e.key === 'Escape') setRenameGid(null)
                        }}
                      />
                    ) : (
                      <span
                        className="pgrp-name"
                        title={g ? undefined : 'Parameters that belong to no group'}
                      >
                        {sec.name}
                      </span>
                    )}
                    <span className="pgrp-n">{q ? `${secRows.length} of ${all.length}` : all.length}</span>
                    {/* Folded, the group still says what it holds — often that answers the question
                        without opening it. */}
                    {!open && all.length ? (
                      <span className="pgrp-sum">{all.map((p) => p.name).join(' · ')}</span>
                    ) : null}
                    {dragName ? <span className="pgrp-drop">drop here</span> : null}
                    <span className="pgrp-acts" onClick={(e) => e.stopPropagation()}>
                      <button
                        className="act-icon"
                        title="Add a parameter to this group"
                        aria-label="Add parameter to group"
                        onClick={() => openAdd(sec.id)}
                      >
                        <PlusIcon />
                      </button>
                      {g ? (
                        <>
                          <button
                            className="act-icon"
                            title="Rename group"
                            aria-label="Rename group"
                            onClick={() => setRenameGid(g.id)}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            className="act-icon danger"
                            title="Delete group (parameters kept)"
                            aria-label="Delete group"
                            onClick={() => deleteGroup(g)}
                          >
                            <TrashIcon />
                          </button>
                        </>
                      ) : null}
                    </span>
                  </div>

                  {open ? (
                    <>
                      <div className="prow prow-head">
                        <span>Parameter</span>
                        <span />
                        <span>Value</span>
                        <span>Description</span>
                        <span>Used by</span>
                        <span />
                      </div>
                      <div
                        className="pgrp-rows"
                        onDragOver={(e) => dragOver(e, sec.id)}
                        onDrop={() => dragName && onDrop(sec.id)}
                      >
                        {secRows.length === 0 ? (
                          <p className="empty pgrp-empty">
                            Empty — drag a parameter here, or add one from the heading.
                          </p>
                        ) : null}
                        {secRows.map((p) => (
                          <div
                            key={p.name}
                            className={`prow-item${editing === p.name ? ' editing' : ''}`}
                            draggable={editing !== p.name}
                            // Where the pointer went down, which is the only way to know: `dragstart` fires
                            // on the element carrying `draggable` — the row — so its target is never the
                            // grip, and checking it there meant nothing could be dragged at all.
                            onMouseDown={(e) => {
                              grabbed.current = !!(e.target as HTMLElement).closest('.pc-name')
                            }}
                            onDragStart={(e) => {
                              // The whole first column is the grab area: the six dots are the sign,
                              // but a 9px target is not one. `draggable` stays on the row so the drag image
                              // is the row rather than the grip, and a drag begun anywhere else — in the
                              // value field, on a chip, over the description — is cancelled.
                              if (!grabbed.current) {
                                e.preventDefault()
                                return
                              }
                              e.dataTransfer.effectAllowed = 'move'
                              e.dataTransfer.setData('text/plain', p.name)
                              setDragName(p.name)
                            }}
                            onDragEnd={() => {
                              setDragName(null)
                              setDropGid(undefined)
                            }}
                            onDragOver={(e) => dragOver(e, sec.id, p.name)}
                            onDrop={() => dragName && dragName !== p.name && onDrop(sec.id)}
                          >
                            <div className="prow">
                              <span className="pc-name" title={p.name}>
                                <span
                                  className="pdrag-handle"
                                  title="Drag the row to another group"
                                  aria-hidden="true"
                                >
                                  <i />
                                  <i />
                                  <i />
                                  <i />
                                  <i />
                                  <i />
                                </span>
                                <b>{p.name}</b>
                              </span>
                              <span className="pc-act">
                                <button
                                  className={`act-icon${editing === p.name ? ' on' : ''}`}
                                  title={editing === p.name ? 'Done editing' : 'Edit unit, formula & comment'}
                                  aria-label="Edit parameter"
                                  onClick={() => setEditing(editing === p.name ? null : p.name)}
                                >
                                  <PencilIcon />
                                </button>
                                <button
                                  className="act-icon danger"
                                  title="Delete parameter"
                                  aria-label="Delete parameter"
                                  onClick={() => del(p.name)}
                                >
                                  <TrashIcon />
                                </button>
                              </span>
                              <span className="pc-val">
                                <span className="pc-val-line">
                                  {p.formula ? (
                                    <span className="pc-computed">
                                      {/* A formula's result carries every digit the arithmetic produced —
                                          0.30000000000000004 is a normal answer — and printing it raw
                                          stretched the 128px value column past the rest of the row. The
                                          full number stays one hover away. */}
                                      <span title={p.amount == null ? undefined : String(p.amount)}>
                                        {p.amount == null ? '—' : fmtSig(p.amount, round.parameters)}
                                      </span>
                                      <span className="fx-badge" title={`Computed: = ${p.formula}`}>
                                        ƒ
                                      </span>
                                    </span>
                                  ) : ruleChoices(p.rule).length ? (
                                    // A rule that lists its values is a choice, so the field is a choice:
                                    // the allowed values as a dropdown rather than a number field
                                    // with chips under it. Nothing else can be typed, which is the rule.
                                    <select
                                      className="pc-pick"
                                      value={p.amount == null ? '' : String(p.amount)}
                                      onChange={(e) => patch(p, { amount: Number(e.target.value) })}
                                    >
                                      {p.amount == null || ruleChoices(p.rule).includes(p.amount) ? null : (
                                        // A value from before the rule — shown so the field never lies about
                                        // what the parameter holds. Picking any option replaces it.
                                        <option value={String(p.amount)}>{p.amount}</option>
                                      )}
                                      {p.amount == null ? <option value="">—</option> : null}
                                      {ruleChoices(p.rule).map((c) => (
                                        <option key={c} value={String(c)}>
                                          {c}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <CellInput
                                      initial={p.amount == null ? '' : String(p.amount)}
                                      idle={p.amount == null ? undefined : fmtSig(p.amount, round.parameters)}
                                      numeric
                                      check={(v) => ruleViolation(p.rule, v === '' ? 0 : toNumber(v))}
                                      onRefused={(why) => setRefused(why ? { name: p.name, why } : null)}
                                      onCommit={(v) => patch(p, { amount: v === '' ? 0 : Number(v) })}
                                    />
                                  )}
                                  {p.unit ? <span className="pc-unit">{p.unit}</span> : null}
                                </span>
                                {/* The other kinds are a condition, not a choice, so they print the
                                    condition. A list says what it allows by being the dropdown above. */}
                                {p.rule?.kind && !ruleChoices(p.rule).length ? (
                                  <span
                                    className="pc-rule"
                                    title={`This parameter's value must be ${describeRule(p.rule)}`}
                                  >
                                    {describeRule(p.rule)}
                                  </span>
                                ) : null}
                                {/* A computed value without its formula is a number you cannot argue
                                    with — so the formula is shown, not hidden behind the ƒ. */}
                                {p.formula ? (
                                  <span className="pc-formula mono" title={`= ${p.formula}`}>
                                    = {p.formula}
                                  </span>
                                ) : null}
                              </span>
                              <span className="pc-desc">
                                {p.description ? (
                                  <DescCell text={p.description} />
                                ) : (
                                  <button
                                    className="pc-desc-add"
                                    title="Add a comment"
                                    onClick={() => setEditing(p.name)}
                                  >
                                    Add a comment…
                                  </button>
                                )}
                              </span>
                              {/* Who depends on this number. Without it, changing a parameter is a blind
                                  edit and deciding whether one is still needed means reading every formula
                                  in the model by hand — and an unused parameter is worth seeing, because it
                                  is usually a leftover. One row per process, however many of its exchanges
                                  the formula drives. */}
                              <span className="pc-uses">
                                {p.used_by?.length
                                  ? [...new Map(p.used_by.map((u) => [u.activity_code, u])).values()].map(
                                      (u) => {
                                        const n = p.used_by!.filter(
                                          (x) => x.activity_code === u.activity_code
                                        ).length
                                        return (
                                          <button
                                            key={u.activity_code}
                                            className="pc-use"
                                            title={`Jump to “${u.activity_name}” on the canvas — drives ${n} ${n === 1 ? 'input' : 'inputs'} (${u.formula})`}
                                            disabled={!onJumpToProcess}
                                            onClick={() => onJumpToProcess?.(u.activity_code)}
                                          >
                                            <ModelIcon />
                                            <span className="t">{u.activity_name}</span>
                                            {n > 1 ? <span className="n">{n}×</span> : null}
                                          </button>
                                        )
                                      }
                                    )
                                  : null}
                                {/* A parameter behind another parameter drives no exchange of its own —
                                    a volume and a density behind a mass. Saying "No process" about it
                                    was true and read as "delete me". */}
                                {p.used_by_parameters?.map((u) => (
                                  <span
                                    key={u.name}
                                    className="pc-use pc-use-param"
                                    title={`${u.name} = ${u.formula}`}
                                  >
                                    <span className="t">{u.name}</span>
                                  </span>
                                ))}
                                {!p.used_by?.length && !p.used_by_parameters?.length ? (
                                  <span
                                    className="pc-use-none"
                                    title="No formula in this model references it"
                                  >
                                    Nothing
                                  </span>
                                ) : null}
                              </span>
                              {/* Under the field and across the rest of the row: a refusal is a sentence, and
                                  a sentence does not fit a value column. Below the rule's own phrase, which
                                  is where you look to find out what would have been allowed. */}
                              {refused?.name === p.name ? (
                                <span className="pc-refused">{refused.why}</span>
                              ) : null}
                            </div>
                            {editing === p.name ? (
                              <div className="prow-edit">
                                <label className="pedit-f">
                                  <span>Formula</span>
                                  <FormulaCell
                                    initial={p.formula ?? ''}
                                    params={paramNames}
                                    self={p.name}
                                    onCommit={(v) => patch(p, { formula: v })}
                                  />
                                </label>
                                <label className="pedit-f narrow">
                                  <span>Unit</span>
                                  <CellInput
                                    initial={p.unit ?? ''}
                                    placeholder="unit"
                                    onCommit={(v) => patch(p, { unit: v })}
                                  />
                                </label>
                                <label className="pedit-f">
                                  <span>Comment</span>
                                  <CellInput
                                    multiline
                                    initial={p.description ?? ''}
                                    placeholder="What this parameter means, and where the number comes from… (the assistant can read this)"
                                    onCommit={(v) => patch(p, { description: v })}
                                  />
                                </label>
                                {/* What the value is allowed to be. Refused where it is typed — here, in a
                                    scenario, and in an imported workbook, because the backend carries the
                                    same rule. */}
                                <ParamRuleEditor
                                  rule={p.rule}
                                  onChange={(next) => patch(p, { rule: next })}
                                />
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                </section>
              )
            })}
          </>
        )}
      </div>

      <aside className="pside">
        <div className="scen-help">
          <div className="rp-title">What are parameters?</div>
          <p>
            Named variables — a mass, a distance, a rate — that you define once and reference by name in
            exchange formulas (e.g. <code>mass * 2</code>). Change a parameter and every amount, and any
            formula that uses it, recomputes automatically.
          </p>
          <p>
            <b>When to use them</b>
          </p>
          <ul className="pside-list">
            <li>
              A figure that recurs across the model — product mass, transport distance, a loss or recycling
              rate. Edit it in one place instead of many.
            </li>
            <li>
              A quantity defined <i>relative</i> to another, via a formula — e.g. packaging =
              <code>mass * 0.05</code>.
            </li>
            <li>
              An assumption you'll want to vary — parameters are the knobs behind <b>Scenarios</b>.
            </li>
          </ul>
          <p className="hint-sm">
            Groups keep long lists tidy: a heading folds its group away, its buttons add a parameter to it,
            rename it or delete it — deleting keeps the parameters (they move to Ungrouped). Drag a row onto
            another heading to move it there. Add a comment so you — and the assistant — know what each number
            means and where it comes from.
          </p>
        </div>
        <AuditLog entries={audit} />
      </aside>

      {confirm ? <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} /> : null}
    </div>
  )
}
