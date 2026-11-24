import { useState } from 'react'
import { api, ApiError } from '../lib/api'
import ParamRuleEditor, { ruleViolation, toNumber, type ParamRule } from '../components/ParamRule'
import { parseAmount } from '../lib/numberFormat'
import FormulaInput from '../components/FormulaInput'
import { lintFormula, type ParamName } from '../lib/formula'

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

/**
 * The Parameters page's "New parameter" panel: one parameter per Add, the panel staying open for the next.
 *
 * It creates and never edits. A name the model already has is refused here, where it is typed, and again
 * by the backend (`create: true`), which catches a parameter another writer added since the list was read.
 * The route behind it is an upsert, so before that an existing `mass` lost its value and its rule to
 * whatever the form held.
 */
export default function NewParameterPanel({
  database,
  params,
  groups,
  group,
  run,
  onTaken,
  onClose
}: {
  database: string
  /** Every parameter of the model — what the formula completes against, and the names that are taken. */
  params: ParamName[]
  groups: { id: string; name: string }[]
  /** The group the panel opens with ('' = none): a group heading's "+" pre-selects its own. */
  group: string
  /** The page's mutation runner: its banner shows a failure, and a success reloads the page. */
  run: (fn: () => Promise<unknown>) => Promise<void>
  /** The backend refused a name the list on screen did not have yet — reload it, and the field says why. */
  onTaken: () => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [f, setF] = useState({ ...EMPTY, group_id: group })

  const name = f.name.trim()
  const taken = name && params.some((p) => p.name === name) ? name : null
  const nameViolation = taken
    ? `“${taken}” already exists — edit it in its row, or choose another name.`
    : null
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
  const newViolation =
    nameViolation ??
    (f.formula
      ? (lintFormula(f.formula, params, { self: name || undefined })?.message ?? null)
      : valueViolation)

  const add = (): Promise<void> =>
    run(async () => {
      if (!name) return
      // Unreadable text is not a zero: "abc" used to become 0 on the Enter path, which skipped the
      // button's own check.
      if (!f.formula && f.amount.trim() && parseAmount(f.amount) === null)
        throw new Error('The value is not a number — use 0.5 or 0,5.')
      if (newViolation) throw new Error(newViolation)
      try {
        await api('POST', '/api/v1/params', {
          database,
          name,
          amount: f.formula ? undefined : (parseAmount(f.amount) ?? 0),
          formula: f.formula || undefined,
          unit: f.unit || undefined,
          description: f.description || undefined,
          group_id: f.group_id || undefined,
          rule: f.rule,
          create: true
        })
      } catch (e) {
        if (e instanceof ApiError && e.code === 'param_exists') await onTaken()
        throw e
      }
      setF({ ...EMPTY })
    })

  return (
    <div className="pnew">
      <div className="pnew-grid">
        <label className="pnew-f wide">
          <span>Name</span>
          <input
            autoFocus
            className={nameViolation ? 'refused' : undefined}
            placeholder="e.g. mass_glass_bottle"
            value={f.name}
            aria-invalid={nameViolation ? true : undefined}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && name && !newViolation && void add()}
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
          <input placeholder="kg" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
        </label>
        <label className="pnew-f wide">
          <span>Or formula</span>
          <FormulaInput
            multiline={false}
            className="mono"
            placeholder="mass * 0.05"
            value={f.formula}
            params={params}
            self={name || undefined}
            onChange={(v) => setF({ ...f, formula: v })}
            // Enter adds, as it does in the Name field — unless the formula has a problem. A
            // blur must not: tabbing on to the group field or to Cancel created the parameter
            // before the author was done.
            commitOnBlur={false}
            onCommit={(problem) => {
              if (!problem && name && !nameViolation) void add()
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
      {nameViolation ? <p className="pc-refused pnew-refused">{nameViolation}</p> : null}
      {valueViolation ? <p className="pc-refused pnew-refused">{valueViolation}</p> : null}
      <div className="pnew-acts">
        <button className="btn sm primary" onClick={add} disabled={!name || !!newViolation}>
          Add parameter
        </button>
        <button className="btn sm" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}
