/**
 * The PROCESSES section of the review dossier: every process of the model with its tags, comment and
 * exchanges, written compactly — and, when even that is too long, shortened comment by comment, never by
 * leaving a process out unannounced.
 *
 * The listing arrives as the API gives it to the editor: uids, codes, ISIC and CPC, read-only flags and a
 * sign note on every negative amount. A reviewer reads none of that. Capped as raw JSON it lost the
 * processes at the end of the alphabet — in one run the distribution, which the reviewer then reported as
 * missing, because "no quote, no finding" turns an absent process into a gap of the study. Comments are the
 * bulk of a listing (more than half in one run), so they give way first, the longest first; every cut is
 * named for the GAPS line, so the reviewer can tell "shortened here" from "not in the model".
 */

/** The process list stays below this; it is the part of the dossier the reviewer is asked to challenge. */
const SECTION_CHARS = 24_000

/** Comment lengths tried in turn (exchange comment, process comment), until the list fits. */
const LADDER: Array<[number, number]> = [
  [Infinity, Infinity],
  [400, Infinity],
  [200, Infinity],
  [100, Infinity],
  [100, 1_200],
  [100, 600],
  [0, 600],
  [0, 300],
  [0, 0]
]

export const CUT_MARK = '[cut]'

/** What the reviewer has to know to read the list — said once instead of on every exchange. */
const READING =
  'one entry per process of this model. "tags" on a process are its own (its life-cycle phase, its group); ' +
  '"tags" on an exchange belong to that input — the phase its burden is booked to, which may differ from the ' +
  'process\'s. "from" names the background database an input comes from; an input without it is another ' +
  'process of this model. A treatment dataset (waste going in) is supplied with a NEGATIVE technosphere ' +
  `amount — that is the convention here, not a credit. "${CUT_MARK}" marks a comment this dossier shortened ` +
  'for length — not a finding about the study; what was shortened is listed under GAPS IN THIS DOSSIER.'

interface Counts {
  exchangeComments: number
  processComments: number
}

const cut = (text: string, cap: number): string =>
  cap <= 0 ? CUT_MARK : `${text.slice(0, cap).trimEnd()}… ${CUT_MARK}`

const tagList = (tags: unknown): string[] | undefined => {
  if (!Array.isArray(tags) || !tags.length) return undefined
  return tags.map((t: any) => `${t?.dimension ?? '?'}: ${t?.value ?? '?'}`)
}

function compactExchange(e: any, db: string, cap: number, n: Counts): Record<string, unknown> {
  const out: Record<string, unknown> = { type: e?.type, amount: e?.amount }
  if (e?.formula) out.formula = e.formula
  if (e?.type !== 'production') {
    const input = e?.input ?? {}
    out.input = input.location ? `${input.name} [${input.location}]` : input.name
    if (input.unit) out.unit = input.unit
    if (input.database && input.database !== db) out.from = input.database
    if (e?.type === 'biosphere' && Array.isArray(input.categories) && input.categories.length)
      out.categories = input.categories.join('/')
  }
  const tags = tagList(e?.tags)
  if (tags) out.tags = tags
  const comment = typeof e?.comment === 'string' ? e.comment.trim() : ''
  if (comment) {
    if (comment.length > cap) n.exchangeComments++
    out.comment = comment.length > cap ? cut(comment, cap) : comment
  }
  return out
}

function compactProcess(
  a: any,
  db: string,
  [exCap, procCap]: [number, number],
  n: Counts,
  bare: boolean
): Record<string, unknown> {
  const out: Record<string, unknown> = { name: a?.name }
  if (a?.product && a.product !== a.name) out.product = a.product
  if (a?.location) out.location = a.location
  if (a?.unit) out.unit = a.unit
  const tags = tagList(a?.tags)
  if (tags) out.tags = tags
  const comment = typeof a?.comment === 'string' ? a.comment.trim() : ''
  if (comment) {
    if (comment.length > procCap) n.processComments++
    out.comment = comment.length > procCap ? cut(comment, procCap) : comment
  }
  const exchanges = Array.isArray(a?.exchanges) ? a.exchanges : []
  out.exchanges = bare
    ? `${exchanges.length} exchanges, not shown for length`
    : exchanges.map((e: any) => compactExchange(e, db, exCap, n))
  return out
}

const chars = (cap: number): string => cap.toLocaleString('en-US')

/** The section and what it had to shorten (for GAPS), or '' with no gap when there is no list. */
export function processesSection(activities: unknown, db: string): { text: string; gaps: string[] } {
  const acts: any[] = Array.isArray(activities)
    ? activities
    : Array.isArray((activities as any)?.activities)
      ? (activities as any).activities
      : []
  if (!acts.length) return { text: '', gaps: [] }
  const render = (step: [number, number], bareFrom: number): { text: string; n: Counts } => {
    const n: Counts = { exchangeComments: 0, processComments: 0 }
    const list = acts.map((a, i) => compactProcess(a, db, step, n, i >= bareFrom))
    return { text: `PROCESSES (with exchanges): ${READING}\n${JSON.stringify(list)}`, n }
  }
  let step = LADDER[0]
  let shown = render(step, acts.length)
  for (const next of LADDER.slice(1)) {
    if (shown.text.length <= SECTION_CHARS) break
    step = next
    shown = render(step, acts.length)
  }
  // The last resort, for a model no foreground study reaches: processes from the end of the list keep
  // their name, unit, tags and comment, and their exchanges are counted — each one named under GAPS.
  let bareFrom = acts.length
  while (shown.text.length > SECTION_CHARS && bareFrom > 0) {
    bareFrom--
    shown = render(step, bareFrom)
  }
  const parts: string[] = []
  if (shown.n.exchangeComments)
    parts.push(
      step[0] > 0
        ? `${shown.n.exchangeComments} exchange comments cut to ${chars(step[0])} characters`
        : `${shown.n.exchangeComments} exchange comments left out`
    )
  if (shown.n.processComments)
    parts.push(
      step[1] > 0
        ? `${shown.n.processComments} process comments cut to ${chars(step[1])} characters`
        : `${shown.n.processComments} process comments left out`
    )
  const left = acts.slice(bareFrom).map((a) => String(a?.name ?? '?'))
  if (left.length) parts.push(`${left.length} processes listed without their exchanges: ${left.join(', ')}`)
  if (!parts.length) return { text: shown.text, gaps: [] }
  // One entry of the GAPS line, which joins its entries with "; " — so no semicolon inside.
  return {
    text: shown.text,
    gaps: [
      `process list: ${left.length ? '' : 'no process left out, but '}shortened for length — ` +
        `${parts.join(', ')} (marked "${CUT_MARK}")`
    ]
  }
}
