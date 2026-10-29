/**
 * The repeat guard the chat agent and the chapter writer share.
 *
 * Some models get stuck re-sending a call byte-for-byte — after a rejection they ignore, or after a
 * success whose result they do not accept. Measured across the built-in models: from 3 up to 13
 * identical calls in one turn, burning the whole round budget. Repeating the same arguments cannot
 * produce a different answer, so stop executing it and say why; CHANGING the message is what breaks
 * the loop (repeating the same rejection demonstrably does not).
 *
 * Extracted from the agent loop so the chapter writer has the same protection: its
 * lookup budget bounded the damage — an identical lookup still cost one of the chapter's few paid
 * lookups — but bounding waste is not preventing it. Only the escape clause differs per caller: the
 * agent tells the model to answer the user, the writer tells it to write the chapter.
 */
export const REPEAT_LIMIT = 3

export interface RepeatGuard {
  /** Files the call and returns the block message once the same bytes exceed the limit, else null. */
  block(name: string, args: string | undefined): string | null
  /** Forget everything — after a successful mutation the model state moved on, and re-reading the
   *  same thing is legitimate again. */
  clear(): void
}

/**
 * The arguments in a canonical spelling, so two calls count as the same call when they MEAN the
 * same thing: keys sorted, whitespace gone, `1.0` and `1` the same number. Byte identity missed the
 * near-duplicates a model produces while "trying something else" — the same fields in another order,
 * a reformatted number — and let it burn rounds on a call that could not come out differently.
 * Unparseable arguments fall back to their bytes, which is what the guard compared before.
 */
export function canonicalArgs(args: string | undefined): string {
  if (!args) return ''
  try {
    return canonical(JSON.parse(args))
  } catch {
    return args
  }
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

export function makeRepeatGuard(escape: string, limit: number = REPEAT_LIMIT): RepeatGuard {
  const repeats = new Map<string, number>()
  return {
    block(name, args) {
      const signature = `${name}:${canonicalArgs(args)}`
      const times = (repeats.get(signature) ?? 0) + 1
      repeats.set(signature, times)
      if (times <= limit) return null
      return (
        `Blocked: you have already called ${name} with these same arguments ${limit} times and the ` +
        'result will not change. Do not send it again. Either call it with different arguments — a required one ' +
        `for this action may be missing — or ${escape}`
      )
    },
    clear() {
      repeats.clear()
    }
  }
}

/** An XML/HTML-looking tag: `<activity_code>`, `</input_database>`, `<item>`. */
const XML_TAG = /<\/?[A-Za-z_][\w-]*\s*\/?>/

/**
 * Tool arguments whose STRING values carry XML tags — the shape MiniMax M3 produced four times in a
 * row (V326): `"activity_database": "zz-…</activity_code>0174…</activity_code><input_database>…"`,
 * a whole call's fields glued into one value with the tags of a different serialisation. The JSON is
 * valid, so nothing else notices; the tool then rejects a missing field, which is true but not the
 * cause. Naming the cause is what makes the retry land (the same doctrine as the stringified arrays,
 * V277/V279/V324). Returns the diagnostic, or null when the arguments are clean.
 */
export function xmlInArgs(args: unknown, path = ''): string | null {
  const hits = xmlHits(args, path)
  if (!hits.length) return null
  const corrupted = hits.find((h) => h.key !== undefined)
  if (corrupted) {
    const k = corrupted.key ?? ''
    return (
      `Your arguments arrived corrupted: a field NAME contains "${corrupted.tag}" ` +
      `(key "${k.length > 60 ? `${k.slice(0, 60)}…` : k}"${corrupted.path ? ` under ${corrupted.path}` : ''}). ` +
      'Resend the same call as plain JSON — every field its own key with its own value, no <tag> markup.'
    )
  }
  // Every offending field in ONE message (V436): the model fixed the one field named,
  // resent, and fell over the next one — a round lost for a list this already had.
  const where = hits.map((h) => `${h.path || 'argument'} holds "${h.tag}"`).join('; ')
  return (
    `Your arguments contain XML tags inside a JSON string (${where}). ` +
    'Send plain JSON: every field is its own key with its own value — no <tag>…</tag> markup, no fields ' +
    'concatenated into one string, no {"item": …} wrappers around arrays.'
  )
}

function xmlHits(args: unknown, path: string): { path: string; tag: string; key?: string }[] {
  if (typeof args === 'string') {
    const m = XML_TAG.exec(args)
    return m ? [{ path, tag: m[0] }] : []
  }
  if (Array.isArray(args)) return args.flatMap((v, i) => xmlHits(v, `${path}[${i}]`))
  if (args && typeof args === 'object') {
    const out: { path: string; tag: string; key?: string }[] = []
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      // The tag in the KEY — GLM 5.3 Flash's shape (V356): `"note</arg_key> "0.09…",
      // "status": "completed"</arg_value><arg_key>steps": [...]` — three fields and their serialiser's
      // markers fused into one key, the required `steps` gone from the top level. The schema
      // diagnosis that followed ("steps must be an ARRAY") was true and pointed the wrong way.
      const inKey = XML_TAG.exec(k)
      if (inKey) return [{ path, tag: inKey[0], key: k }]
      out.push(...xmlHits(v, path ? `${path}.${k}` : k))
    }
    return out
  }
  return []
}

/**
 * Strip a closing tag that merely echoes the field's own name at the end of its value — the leak of
 * a route that translates Anthropic's XML tool calls into JSON (`"cutoff_criteria": "… 1 % Mehreinsatz.
 * </cutoff_criteria>"`, Sonnet 5.5 over OpenRouter's server-tool wrapper, V436). The tag is
 * unambiguous — it names the very field it sits in and nothing follows it — so the value is repaired
 * in place and the names of the repaired fields are returned for the log. Anything else (a tag of
 * another field, a tag with content after it: `</system_allocation>\n<parameter name="add_limitations">…`)
 * is left for `xmlInArgs` to refuse, because there the rest of the value is not the field's own.
 */
export function stripOwnClosingTags(args: unknown, path = ''): string[] {
  const repaired: string[] = []
  if (Array.isArray(args)) {
    args.forEach((v, i) => repaired.push(...stripOwnClosingTags(v, `${path}[${i}]`)))
    return repaired
  }
  if (!args || typeof args !== 'object') return repaired
  const rec = args as Record<string, unknown>
  for (const [k, v] of Object.entries(rec)) {
    const here = path ? `${path}.${k}` : k
    if (typeof v === 'string') {
      const own = new RegExp(`\\s*</${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>\\s*$`)
      if (own.test(v)) {
        rec[k] = v.replace(own, '')
        repaired.push(here)
      }
    } else if (v && typeof v === 'object') repaired.push(...stripOwnClosingTags(v, here))
  }
  return repaired
}

/** The argument fields whose text a report prints: parameter and scenario comments, process notes, the
 *  study's own prose and limitations. Everything else (codes, names, actions) is addressed to the app. */
const PRINTED_TEXT_FIELDS = new Set([
  'comment',
  'description',
  'notes',
  'goal',
  'scope',
  'functional_unit',
  'geography',
  'reference_year',
  'system_boundaries',
  'cutoff_criteria',
  'allocation',
  'system_allocation',
  'limitations',
  'text',
  'reason',
  'critical_review'
])

/**
 * PrismLCA tool names inside text a report will print — `"… 2,8 kg (idealo-Listing, über research_bom
 * ermittelt)"` in a parameter comment, `"(Distanzwerkzeug)"` in a scenario description
 * (V408b). The tools' doctrine says the report never names the software; the writer obeys it, but the
 * parameter table and the limitations print these fields as they are. The call goes through — a remark
 * in the answer, not a refusal — because the number in it is right and only its provenance is phrased
 * for the wrong reader. Returns the sentence for the answer's `warnings`, or null.
 */
export function toolNamesInArgs(args: unknown, toolNames: Iterable<string>): string | null {
  const names = [...toolNames].filter((n) => n.includes('_'))
  if (!names.length) return null
  const pattern = new RegExp(
    `(?<![\\w])(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w])`
  )
  const hits = new Map<string, string>()
  const walk = (v: unknown, key: string): void => {
    if (typeof v === 'string') {
      if (!PRINTED_TEXT_FIELDS.has(key)) return
      const m = pattern.exec(v)
      if (m) hits.set(m[1], key)
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item, key)
    } else if (v && typeof v === 'object') {
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) walk(item, k)
    }
  }
  walk(args, '')
  if (!hits.size) return null
  const list = [...hits.entries()].map(([tool, field]) => `${tool} (in "${field}")`).join(', ')
  return (
    `The text names PrismLCA tools — ${list}. These fields print in the report (parameter table, ` +
    'study chapters, limitations), and a reader there has no tools: write the source or the method ' +
    'instead — the listing, the data sheet, the statistic, the routed distance — never the tool that ' +
    'fetched it. The value was stored; rewrite the text with another call.'
  )
}
