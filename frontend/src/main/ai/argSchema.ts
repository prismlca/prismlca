/**
 * Tool arguments checked against the tool's own JSON Schema BEFORE the tool runs.
 *
 * The executor once only parsed the JSON and dispatched; whatever was wrong with the shape was
 * for each tool to notice — and most noticed late and said the wrong thing. The stringified array
 * (V277/V279: `"codes": "[\"a\",\"b\"]"`), the number sent as a string, the missing `steps`, the
 * action outside the enum: every one of them had been met by a hand-written diagnostic in ONE tool,
 * and reached the other fifty-two as a backend 422 or a silent default. Mature agent harnesses
 * validate every call against the declared schema and hand the model the failure in words; this is
 * that, generalised, in the doctrine the hand-written diagnostics established — say what is wrong
 * and what to send instead, never bend the schema to accept the wrong shape.
 *
 * Measured before it went in: 3 238 successful calls from stored chats and evaluation runs,
 * 5 of which this would have refused — four `edit_tags` with an explicit `value: null` (which the
 * tolerance below lets through, because "null" for an optional field is the same intent as leaving
 * it out, and the tool reads it that way), one `list_methods` whose queries were objects instead of
 * strings (and whose answer was the generic one — the refusal would have said why).
 *
 * The messages are read by a model, so they name the field, the expected shape and the shape that
 * arrived, in that order, with the one correction that ends the loop. Tested on a model with the
 * counter-case (CLAUDE.md), see argSchema.test.ts for the shapes.
 *
 * The one thing left to the caller: unknown top-level fields. `withUnknownFields` (execute.ts)
 * already appends them to any failure, and a second sentence about the same keys would be noise.
 */
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'

// `strict: false`: the specs carry `description`, `default` and `format` where they help the model,
// and strict mode would refuse to compile them. `allErrors`: a call with three faults gets one answer
// naming all three, not three rounds naming one each.
// `verbose`: errors carry their schema node, so a type fault can name the fields of the object it wanted.
const ajv = new Ajv({ strict: false, allErrors: true, verbose: true })
const compiled = new Map<string, ValidateFunction>()

/** At most this many faults in one answer; past that the call is wrong in shape, not in detail. */
const MAX_FAULTS = 3

type Schema = Record<string, unknown>

function validatorFor(name: string, schema: Schema): ValidateFunction | null {
  const hit = compiled.get(name)
  if (hit) return hit
  try {
    const v = ajv.compile(schema)
    compiled.set(name, v)
    return v
  } catch (e) {
    // A schema this library cannot compile is a defect of the spec, not of the call: log once and
    // let the call through, as it would have gone through before this module existed.
    console.log(
      `[prism-ai] schema of ${name} does not compile — not validated: ${e instanceof Error ? e.message : e}`
    )
    compiled.set(name, (() => true) as unknown as ValidateFunction)
    return null
  }
}

/**
 * `null` for a property the schema does not require reads as "not given". Models write
 * `"value": null` where the description says "omit value to clear", and the tools that take such a
 * field already treat null and absent alike. Top level only, and only where the key is optional: a
 * null in a required slot is a real fault and is reported as one.
 */
function withoutOptionalNulls(args: Record<string, unknown>, schema: Schema): Record<string, unknown> {
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  let copy: Record<string, unknown> | null = null
  for (const [k, v] of Object.entries(args)) {
    if (v !== null || required.has(k)) continue
    copy ??= { ...args }
    delete copy[k]
  }
  return copy ?? args
}

/** `/exchanges/1/amount` → `exchanges[1].amount`; the root → `the arguments`. */
function pathOf(instancePath: string): string {
  if (!instancePath) return ''
  return instancePath
    .split('/')
    .slice(1)
    .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((acc, seg) => (/^\d+$/.test(seg) ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : seg), '')
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return `an array of ${v.length}`
  if (typeof v === 'string') return `the string ${JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v)}`
  if (typeof v === 'object') return 'an object'
  return `${typeof v} ${JSON.stringify(v)}`
}

/** Resolve the value an error points at, for the sentence. */
function valueAt(args: unknown, instancePath: string): unknown {
  let cur: unknown = args
  for (const seg of instancePath.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg.replace(/~1/g, '/').replace(/~0/g, '~')]
  }
  return cur
}

/** Does this string look like a JSON array or object the model serialised into a string? */
function looksLikeJson(s: string): 'array' | 'object' | null {
  const t = s.trim()
  if (t.startsWith('[') && t.endsWith(']')) return 'array'
  if (t.startsWith('{') && t.endsWith('}')) return 'object'
  return null
}

function sentence(err: ErrorObject, args: unknown): string | null {
  const path = pathOf(err.instancePath)
  const where = path ? `"${path}"` : 'the arguments'
  const p = err.params as Record<string, unknown>
  switch (err.keyword) {
    case 'required': {
      const field = String(p.missingProperty)
      const under = path ? ` inside "${path}"` : ''
      return `Missing required argument "${field}"${under}.`
    }
    case 'type': {
      const want = String(p.type)
      const got = valueAt(args, err.instancePath)
      // An empty list that arrived as the string "[]" says nothing and is a leftover: in one run
      // Sonnet 5.5 followed the single-value exit below but kept `queries: []` beside `query` — four
      // more refusals for a field it did not need (V417b). The exit here is to drop it, not to fix it.
      if (want === 'array' && typeof got === 'string' && got.trim() === '[]')
        return (
          `${where} arrived as "[]" — an empty list says nothing. Drop the field entirely; the ` +
          `single-value field already carries the request.`
        )
      if (want === 'array' && typeof got === 'string' && looksLikeJson(got) === 'array')
        // The second sentence is for the call that WAS an array when it left the model: in one run
        // Sonnet 5.5 sent eight real arrays through an OpenRouter route that re-encoded each as a string,
        // and this message — true, but about the wrong party — sent it round seven times before it
        // worked out the single-query fallback on its own (V397). A model that really stringified
        // still reads the first sentence and resends the array (measured on gemini-3.7-flash with both
        // cases); one that did not now has the exit named instead of the same wall again.
        return (
          `${where} must be a JSON array, but it arrived as ONE string containing the array — ` +
          `send the array itself as the value, without quotes around it. If your call already carried ` +
          `a real array, the route to the model re-encoded it in transit and the same shape will fail ` +
          `again: switch to the tool's single-value field (one call per item, several calls in parallel) ` +
          `instead of resending.`
        )
      if (want === 'object' && typeof got === 'string' && looksLikeJson(got) === 'object')
        return (
          `${where} must be a JSON object, but it arrived as ONE string containing the object — ` +
          `send the object itself as the value, without quotes around it.`
        )
      if (
        (want === 'number' || want === 'integer') &&
        typeof got === 'string' &&
        got.trim() &&
        !isNaN(Number(got))
      )
        return `${where} must be a ${want}, not the string "${got}" — send ${Number(got)} without quotes.`
      if (want === 'array' && got !== undefined && !Array.isArray(got))
        return `${where} must be an array (a JSON list), you sent ${describe(got)} — wrap the value in [ ].`
      if (want === 'object') {
        // Name the fields, or the next attempt is a guess: "must be an object" after "must be an
        // array" cost an external agent two rounds on model_info's limitations.
        const schema = (err.parentSchema ?? {}) as {
          properties?: Record<string, unknown>
          required?: string[]
        }
        const keys = Object.keys(schema.properties ?? {})
        if (keys.length) {
          const req = new Set(schema.required ?? [])
          const fields = keys.map((k) => (req.has(k) ? `${k} (required)` : k)).join(', ')
          return `${where} must be an object with the fields ${fields}; you sent ${describe(got)}.`
        }
      }
      return `${where} must be ${/^[aeiou]/.test(want) ? 'an' : 'a'} ${want}, you sent ${describe(got)}.`
    }
    case 'enum': {
      const allowed = Array.isArray(p.allowedValues) ? (p.allowedValues as unknown[]) : []
      const got = valueAt(args, err.instancePath)
      return `${where} must be one of ${allowed.map((a) => JSON.stringify(a)).join(', ')}; you sent ${JSON.stringify(got)}.`
    }
    case 'minItems':
      return `${where} needs at least ${p.limit} item${p.limit === 1 ? '' : 's'}.`
    case 'maxItems':
      return `${where} takes at most ${p.limit} item${p.limit === 1 ? '' : 's'}.`
    case 'minLength':
      return `${where} must not be empty.`
    case 'maxLength':
      return `${where} is longer than ${p.limit} characters.`
    case 'minimum':
    case 'exclusiveMinimum':
      return `${where} must be ${err.keyword === 'minimum' ? 'at least' : 'above'} ${p.limit}.`
    case 'maximum':
    case 'exclusiveMaximum':
      return `${where} must be ${err.keyword === 'maximum' ? 'at most' : 'below'} ${p.limit}.`
    case 'additionalProperties':
      return `${where} has no field "${p.additionalProperty}".`
    case 'pattern':
      return `${where} does not match the expected pattern ${p.pattern}.`
    case 'const':
      return `${where} must be ${JSON.stringify(p.allowedValue)}.`
    // The summary of an alternative: its branches have already said what each wanted.
    case 'anyOf':
    case 'oneOf':
    case 'if':
      return null
    default:
      return `${where} ${err.message ?? 'is not valid'}.`
  }
}

/**
 * Validate `args` against the tool's parameter schema. Returns null when they pass, otherwise the
 * diagnostic the model gets as the tool's error — one to three sentences, each naming a field.
 */
export function validateToolArgs(
  name: string,
  schema: Schema | undefined,
  args: Record<string, unknown>
): string | null {
  if (!schema || typeof schema !== 'object') return null
  const v = validatorFor(name, schema)
  if (!v) return null
  const checked = withoutOptionalNulls(args, schema)
  if (v(checked)) return null
  const all: string[] = []
  for (const err of v.errors ?? []) {
    const s = sentence(err, checked)
    if (s && !all.includes(s)) all.push(s)
  }
  if (!all.length) {
    // Only alternative summaries fired (every branch of an anyOf failed in its own way): say that.
    const first = v.errors?.[0]
    const where = first?.instancePath ? `"${pathOf(first.instancePath)}"` : 'the arguments'
    all.push(`${where} match none of the accepted shapes for ${name}.`)
  }
  const faults = all.slice(0, MAX_FAULTS)
  const more = all.length > faults.length ? ` (${all.length - faults.length} more)` : ''
  return `Invalid arguments for ${name}: ${faults.join(' ')}${more} Fix these and send the call again.`
}
