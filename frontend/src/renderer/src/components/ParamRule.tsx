/**
 * What a parameter's value is allowed to be — Excel's data validation, for parameters.
 *
 * Two halves, both here so they cannot drift apart: the **editor**, which sets the rule on a parameter, and
 * the small functions the value fields use to refuse a value *before* it is written. The backend enforces the
 * same rule on every path (the parameter, a formula's result, a scenario override, every cell of a scenario
 * workbook) — this side exists so that a wrong value is refused where it is typed, with the field still on
 * screen, rather than coming back as a message about a page you have left.
 *
 * The list rule is written as `0.25; 0.5; 0.75` and shows what it parsed as chips right under the field: the
 * semicolons are a syntax, and a syntax you cannot see the result of is a syntax you get wrong. They are only
 * a drawing of the numbers — no relation to the model's tags, which are a different thing entirely.
 */
import { useEffect, useRef, useState } from 'react'
import { parseAmount } from '../lib/numberFormat'

export type ParamRule =
  | Record<string, never>
  | { kind: 'positive' }
  | { kind: 'negative' }
  | { kind: 'range'; min?: number; max?: number }
  | { kind: 'list'; values: number[] }

export const RULE_KINDS = [
  { id: '', label: 'Any number' },
  { id: 'positive', label: 'Only positive' },
  { id: 'negative', label: 'Only negative' },
  { id: 'range', label: 'Range' },
  { id: 'list', label: 'From a list' }
] as const

/** A number as short as it is exact — `0.5`, not `0.5000000000000001`; `2` rather than `2.0`. */
const num = (v: number): string => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12))))

/** Accepts a comma decimal: the field is typed by hand, and half of Europe types `0,5`. One parser
 *  for the whole app — a rule bound here has to read a number the same way the amount fields do,
 *  or a value passes the rule in one field and fails it in the next. */
export const toNumber = (raw: string): number | null => parseAmount(raw)

/** The rule as the phrase the backend uses, so both sides say the same thing. */
export function describeRule(rule?: ParamRule): string {
  const r = rule as { kind?: string; min?: number; max?: number; values?: number[] } | undefined
  if (!r?.kind) return 'any number'
  if (r.kind === 'positive') return 'greater than 0'
  if (r.kind === 'negative') return 'less than 0'
  if (r.kind === 'range') {
    if (r.min != null && r.max != null) return `between ${num(r.min)} and ${num(r.max)}`
    if (r.min != null) return `at least ${num(r.min)}`
    if (r.max != null) return `at most ${num(r.max)}`
    return 'any number'
  }
  if (r.kind === 'list') return `one of ${(r.values ?? []).map(num).join(', ')}`
  return 'any number'
}

/** Floats do not compare exactly — the same tolerance the backend applies. */
const EPS = 1e-9

/** Why this value breaks the rule, or null. `null` value = nothing typed yet, which is not a violation. */
export function ruleViolation(rule: ParamRule | undefined, value: number | null): string | null {
  const r = rule as { kind?: string; min?: number; max?: number; values?: number[] } | undefined
  if (!r?.kind || value == null) return null
  if (r.kind === 'positive' && !(value > 0)) return 'must be greater than 0'
  if (r.kind === 'negative' && !(value < 0)) return 'must be less than 0'
  if (r.kind === 'range') {
    if (r.min != null && value < r.min - EPS) return `must be ${describeRule(rule)}`
    if (r.max != null && value > r.max + EPS) return `must be ${describeRule(rule)}`
  }
  if (r.kind === 'list') {
    const ok = (r.values ?? []).some((a) => Math.abs(value - a) <= EPS * Math.max(1, Math.abs(a)))
    if (!ok) return `must be ${describeRule(rule)}`
  }
  return null
}

/** The allowed values of a list rule, for the chips the value field offers. Empty for every other kind. */
export function ruleChoices(rule?: ParamRule): number[] {
  const r = rule as { kind?: string; values?: number[] } | undefined
  return r?.kind === 'list' ? (r.values ?? []) : []
}

/**
 * The editor: a kind, and whatever that kind needs.
 *
 * Committed on blur or Enter like every other field on this page, and written straight through — there is no
 * Save button anywhere in this app. A rule the current value breaks is refused by the backend naming both
 * numbers, which is the honest order: the parameter must not end up unable to save itself.
 */
export default function ParamRuleEditor({
  rule,
  onChange
}: {
  rule: ParamRule | undefined
  onChange: (next: ParamRule) => void
}): JSX.Element {
  const r = (rule ?? {}) as { kind?: string; min?: number; max?: number; values?: number[] }
  // The chosen kind is local, and only a *complete* rule is written. "From a list" has no valid empty form —
  // a list rule with no values accepts nothing, and the backend refuses it — but the kind has to be chosen
  // before the values can be typed. Writing on every keystroke of the select was the first version: picking
  // "From a list" put an error on the page and left the select back on "Any number".
  const [kind, setKindLocal] = useState<string>(r.kind ?? '')
  const abandoned = useRef(false) // Escape beats the blur it triggers; see `commitList`
  // Follow the rule when it changes from outside (another edit, a reload) without fighting the local choice.
  useEffect(() => setKindLocal(r.kind ?? ''), [r.kind])
  // What the list field holds while it is being typed. Outside the committed rule, so a half-written
  // "0.25; 0." is not a rule anybody is enforcing yet.
  const [draft, setDraft] = useState<string | null>(null)
  const listText = (r.values ?? []).map(num).join('; ')

  const setKind = (next: string): void => {
    if (next === kind) return
    setKindLocal(next)
    if (next === '') return onChange({})
    // Neither Range nor List has a valid empty form — a range with no end and a list with no value accept
    // nothing, and the backend refuses both — so choosing the kind writes nothing and the fields below do.
    // The first version pre-filled a range with `min: 0`, which meant that setting only an upper bound left
    // a lower one nobody typed: "at most 1" silently became "between 0 and 1".
    if (next === 'range') {
      if (r.min != null || r.max != null) onChange({ kind: 'range', min: r.min, max: r.max })
      else if (r.kind) onChange({})
      return
    }
    if (next === 'list') {
      if (r.values?.length) onChange({ kind: 'list', values: r.values })
      else if (r.kind) onChange({})
      return
    }
    onChange({ kind: next } as ParamRule)
  }

  const setEnd = (which: 'min' | 'max', raw: string): void => {
    const n = toNumber(raw)
    const next: { kind: 'range'; min?: number; max?: number } = { kind: 'range', min: r.min, max: r.max }
    if (n == null) delete next[which]
    else next[which] = n
    // A range with neither end is no rule at all — say that rather than writing something the backend refuses.
    if (next.min == null && next.max == null) return onChange({})
    onChange(next)
  }

  const commitList = (raw: string): void => {
    // Escape sets the draft aside and blurs; the blur then handed this the DOM's text — the very
    // values the user had just abandoned — and wrote them as the rule.
    if (abandoned.current) {
      abandoned.current = false
      return
    }
    const values: number[] = []
    for (const part of raw.split(/[;\n]/)) {
      const n = toNumber(part)
      if (n != null && !values.includes(n)) values.push(n)
    }
    setDraft(null)
    if (!values.length) {
      // Nothing parsed: clear the rule only if there was one. Otherwise this is an empty field under a
      // freshly picked kind, and clearing would fight the choice that is still being made.
      if (r.kind === 'list') onChange({})
      return
    }
    onChange({ kind: 'list', values })
  }

  return (
    <div className="prule">
      <label className="pedit-f narrow">
        <span>Allowed</span>
        <select className="search-sel" value={kind} onChange={(e) => setKind(e.target.value)}>
          {RULE_KINDS.map((k) => (
            <option key={k.id} value={k.id}>
              {k.label}
            </option>
          ))}
        </select>
      </label>

      {kind === 'range' ? (
        <>
          <label className="pedit-f narrow">
            <span>At least</span>
            <input
              className="num"
              defaultValue={r.min != null ? num(r.min) : ''}
              key={`min:${r.min ?? ''}`}
              placeholder="—"
              onBlur={(e) => setEnd('min', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </label>
          <label className="pedit-f narrow">
            <span>At most</span>
            <input
              className="num"
              defaultValue={r.max != null ? num(r.max) : ''}
              key={`max:${r.max ?? ''}`}
              placeholder="—"
              onBlur={(e) => setEnd('max', e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </label>
          {/* One side alone *is* the "at least" / "at most" rule — said here so nobody looks for that kind. */}
          <p className="hint-sm prule-hint">
            Fill one side only for “at least” or “at most” — an empty side is no bound, not zero.
          </p>
        </>
      ) : null}

      {kind === 'list' ? (
        <div className="prule-list">
          <label className="pedit-f">
            <span>Values, separated by ;</span>
            <input
              value={draft ?? listText}
              placeholder="0.25; 0.5; 0.75"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={(e) => commitList(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  abandoned.current = true
                  setDraft(null)
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
            />
          </label>
          {/* What the semicolons became. Only a drawing of the numbers — nothing to do with model tags. */}
          {(r.values ?? []).length ? (
            <div className="prule-chips" aria-label="Allowed values">
              {(r.values ?? []).map((v) => (
                <span className="prule-chip" key={v}>
                  {num(v)}
                  <button
                    title={`Remove ${num(v)}`}
                    aria-label={`Remove ${num(v)}`}
                    onClick={() => {
                      const left = (r.values ?? []).filter((x) => x !== v)
                      onChange(left.length ? { kind: 'list', values: left } : {})
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="hint-sm prule-hint">Write the values with semicolons between them.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}
