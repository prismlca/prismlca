/**
 * Empty optional arguments read as "not given": one rule for every tool, applied by the executor after
 * the arguments have passed their schema (argSchema.ts), so every tool, the model fence and the approval
 * card see the same arguments.
 *
 * Some models fill every optional field they do not use with an empty value — `""`, `[]`, `{}`,
 * `{"dimension": "", "value": ""}`, `0` in a count. Each tool used to read that its own way: `??` let
 * `""` through where `||` would not, an empty object passed an existence check and filtered every flow
 * away (V480), `year: 0` was refused three times in a row (V464), `limit: 0` asked for one hit. The hand
 * repairs in single tools (V286, V287, V288/V292, V335) covered the tools where it had already hurt.
 *
 * The rule, in an OPTIONAL field:
 * - `""` (also whitespace only), `[]`, `{}` and an object whose declared fields are all empty are dropped,
 *   as if the field had been left out; so is `null`;
 * - `0` is dropped only in a count or a year (`EMPTY_ZERO`) — elsewhere it is a number (`amount`,
 *   `value`, `cutoff`);
 * - inside list items the rule follows the item schema (`exchanges[]`, `filtered_queries[]`), but an
 *   ITEM is never dropped and a list never shortened: `scenarios: [""]` is the baseline;
 * - a free-form map (`overrides`, `tags`) is empty only as `{}` — its keys say something;
 * - fields the schema does not declare are left as they came.
 * Required fields are never touched: the tool's own check names what is missing. `KEEP_EMPTY` lists the
 * fields where an empty value is an instruction today, per tool, action and field path.
 *
 * Invalid shapes are not repaired here — the schema check before this has already refused them.
 */
import { ACTION_PARAM } from './tools/effects'

type Schema = Record<string, any>

/** Optional numeric fields in which 0 means "not given": a count of results or a year. */
const EMPTY_ZERO = new Set(['limit', 'top_n', 'max_components', 'year'])

/** The actions an exception holds for; '*' = every call of the tool. */
type Actions = readonly string[] | '*'

/** `set_amount`/`set_formula` also take a comment, and `""` there removes it — the same as `set_comment`. */
const EXCHANGE_EDITS = ['set_formula', 'set_comment', 'set_amount'] as const

/**
 * Where an empty value is an instruction, not padding: tool → field path → actions. A path names a field
 * inside list items as `list[].field`. Each one has a test in emptyArgs.test.ts.
 */
export const KEEP_EMPTY: Record<string, Record<string, Actions>> = {
  // `formula: ""` detaches the formula and keeps the number; `comment: ""` removes the comment. On
  // "replace_input" an empty one is padding: it would drop the formula and comment the call carries over.
  edit_exchange: {
    formula: EXCHANGE_EDITS,
    comment: EXCHANGE_EDITS,
    'exchanges[].formula': EXCHANGE_EDITS,
    'exchanges[].comment': EXCHANGE_EDITS
  },
  // `unit: ""` / `comment: ""` clear the label or the note (the backend stores what it is given; an
  // absent field leaves it as it is). "set" is the only action that takes them.
  edit_parameter: { unit: '*', comment: '*', 'parameters[].unit': '*', 'parameters[].comment': '*' },
  // `split_by: ""` puts the stacked split back to automatic (the model's tag family).
  setup_results: { split_by: '*' },
  // `description: ""` clears the family's description; an absent one leaves it.
  edit_lcia_method: { description: ['create', 'duplicate'] },
  // An empty per-query filter lifts the call-level one for that query.
  search_background: { 'filtered_queries[].geographies': '*', 'filtered_queries[].activity_types': '*' }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const named = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

function keeps(tool: string, path: string, action: string | undefined): boolean {
  const table = Object.hasOwn(KEEP_EMPTY, tool) ? KEEP_EMPTY[tool] : undefined
  const rule = table && Object.hasOwn(table, path) ? table[path] : undefined
  if (!rule) return false
  return rule === '*' || (action !== undefined && rule.includes(action))
}

/** Empty in the sense above. A free-form map (no declared fields) is empty only without keys. */
function isEmpty(v: unknown, schema: Schema | undefined): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return !v.trim()
  if (Array.isArray(v)) return v.length === 0
  if (isPlainObject(v)) {
    const entries = Object.entries(v)
    if (!entries.length) return true
    const props = schema?.properties as Schema | undefined
    if (!props) return false
    return entries.every(([k, x]) => isEmpty(x, Object.hasOwn(props, k) ? props[k] : undefined))
  }
  return false
}

const isNumberSchema = (s: Schema | undefined): boolean => s?.type === 'number' || s?.type === 'integer'

interface Walk {
  tool: string
  /** The tool's action parameter (`action`, `mode`, `kind`), when it has one. */
  param: string | undefined
}

function walkValue(w: Walk, schema: Schema | undefined, v: unknown, path: string, action?: string): unknown {
  if (Array.isArray(v)) {
    const items = schema?.items as Schema | undefined
    if (!items?.properties) return v
    let changed = false
    const out = v.map((item) => {
      const next = walkObject(w, items, item, `${path}[]`, action)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : v
  }
  if (isPlainObject(v) && schema?.properties) return walkObject(w, schema, v, path, action)
  return v
}

function walkObject(w: Walk, schema: Schema, obj: unknown, path: string, inherited?: string): unknown {
  const props = schema.properties as Schema | undefined
  if (!props || !isPlainObject(obj)) return obj
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  // A batch item's own action wins over the call's (edit_exchange items).
  const action = (w.param ? named(obj[w.param]) : undefined) ?? inherited
  let out: Record<string, unknown> | null = null
  for (const [k, v] of Object.entries(obj)) {
    if (!Object.hasOwn(props, k)) continue
    const here = path ? `${path}.${k}` : k
    if (keeps(w.tool, here, action)) continue
    const sub = props[k] as Schema | undefined
    const next = walkValue(w, sub, v, here, action)
    const drop =
      !required.has(k) && (isEmpty(next, sub) || (next === 0 && EMPTY_ZERO.has(k) && isNumberSchema(sub)))
    if (drop) {
      out ??= { ...obj }
      delete out[k]
    } else if (next !== v) {
      out ??= { ...obj }
      out[k] = next
    }
  }
  return out ?? obj
}

/**
 * The arguments with every empty optional field dropped (see the module comment). Returns the SAME
 * object when nothing was empty, and never changes the one it was given.
 */
export function withoutEmptyArgs(
  tool: string,
  schema: Schema | undefined,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (!schema?.properties) return args
  const param = Object.hasOwn(ACTION_PARAM, tool) ? ACTION_PARAM[tool] : undefined
  return walkObject({ tool, param }, schema, args, '') as Record<string, unknown>
}
