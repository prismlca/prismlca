/**
 * The RESEARCH ON RECORD section of the review dossier: what the research tools brought back for this model —
 * and what they could not settle — read from the model's research log, so the reviewer can hold a booked figure
 * against what was found.
 *
 * Without it the reviewer compared prose with prose: the bill-of-materials research had found 5 mm boards on one
 * retailer page and 4 mm on another, and 13, 14.1 and 24 kg for the whole rack; the model booked 4 mm and 13 kg,
 * and the reviewer could see neither the other figures nor that they disagreed.
 *
 * Bounded, and cut by rank rather than by position: the bill-of-materials checks first, then the part masses,
 * then every question as a line, and only then the findings per question — strongest source first, so a later
 * pass that went looking for a better source is not the part that falls away. What is left out is counted.
 */

/**
 * The section stays below this; the process list it is read beside is the larger part of the dossier. About
 * 12,500 characters of research and 2,300 of reading note: measured on nine test runs, that keeps every log whole
 * but the three largest, and those at five findings per question.
 */
const SECTION_CHARS = 14_900
/** Findings per web question, step by step, before questions themselves are folded together. */
const PER_QUESTION = [Infinity, 8, 5, 3, 0]
/** Part masses per product when even the folded questions do not make room. */
const PARTS_PER_PRODUCT = [Infinity, 12, 6, 0]
const QUESTION_CHARS = 150
const TOOL_LINE_CHARS = 200

const CLASS_RANK: Record<string, number> = { official: 0, industry: 1, media: 2, community: 3 }
const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

interface Finding {
  text: string
  sources?: string[]
  source_class?: string
  confidence?: string
  confidence_note?: string
  component?: string
  mass_kg?: number
  mass_range_kg?: [number, number]
  note?: string
  version?: string
  cited_by_search?: boolean
  unsourced?: boolean
  unsourced_kg?: number
}
interface BomCheck {
  summary?: string
  requests?: Array<{ component: string; status: string }>
  unresolved?: Array<{ component: string; reason: string; note?: string }>
  unsourced?: string[]
  totals?: Array<{ mass_kg: number; basis: string; version?: string; source?: string }>
  versions?: {
    conflict?: boolean
    used?: Array<{ version: string; entries: string[] }>
    seen?: Array<{
      version: string
      differs_by?: string
      mass_kg?: number
      sold_by?: string
      source?: string
    }>
  }
  recipe?: {
    of: string
    formulation?: string
    kind?: string
    closes?: boolean | null
    note?: string
    gap_pct?: number
    gap_kg?: number
    reachable_by_ranges?: boolean
    mass_kg?: number
    mass_source?: string
    missing_ingredients?: string[]
    split?: string[]
  }
}
interface Entry {
  question: string
  findings: Finding[]
  asked?: string
  context?: string
  bom_check?: BomCheck
}

const HEAD =
  'RESEARCH ON RECORD FOR THIS MODEL (what the research tools brought back — bill-of-materials and web ' +
  'research, Eurostat and distance look-ups — kept per model across chats, oldest first, each with the date ' +
  'it was asked; you cannot open the pages). Each finding carries the research’s own judgement [source ' +
  'class/confidence]; "source not returned by the search engine" marks a source the search did not bring ' +
  'back, and "NO SOURCE" a part mass the research counted with no page behind it. A bill-of-materials ' +
  'check says what was summed, which parts came back without a mass, every whole-product mass found and ' +
  'which version of the product each figure belongs to. Use it to check the ' +
  'figures that carry the result against what was found: a booked mass or rate outside every researched ' +
  'value or range; a whole-product mass or value picked from several found — quote the others beside it, ' +
  'with their version and scope, and say whether the model gives a reason for its pick; a figure that ' +
  'belongs to another version of the product than the one the goal & scope names; a ' +
  'part the check left open that the model fills with an unsourced estimate or with what remains of the ' +
  'total; a part mass found that the model books nowhere — not on its own, not inside another part, not ' +
  'split over several inputs or in another unit — and that the cut-off decisions do not name: say which ' +
  'exchanges you looked at. Where the health check remarks that a parameter holds a part’s mass and leads ' +
  'to no input, that is a lead to follow, not a finding by itself. Compare like with like — per piece or ' +
  'per set, per product or per kg of an intermediate, the same unit — and quote the researched figure and ' +
  'the exchange amount side by side. A comment that explains a deviation is evidence, not the end of the ' +
  'question: judge whether the reason carries the size of the gap. A low-confidence, media/community or ' +
  'unsourced finding is a lead, not a fact. Nothing follows from absence: research missing here may have ' +
  'been done in a way this log does not keep, a point the research did not cover is no evidence against the model, and a ' +
  'part the research could not settle may be settled by a figure the user gave or a source the model names.'

const day = (asked?: string): string => (asked ? asked.slice(0, 10) : 'undated')
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const cap = (s: string, n: number): string => {
  const t = oneLine(s)
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`
}

/** Host plus the last path segment: two articles on one retailer's site are two sources, not one. */
export function sourceId(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const last = u.pathname.split('/').filter(Boolean).pop()
    return last ? `${host}/${decodeURIComponent(last).slice(0, 40)}` : host
  } catch {
    return url.slice(0, 40)
  }
}

/** How a part's text ends when it still carries its mass ("… (5 pieces): 7.65 kg"). */
const ENDS_ON_MASS = /:\s*[0-9.eE+-]+\s*kg\s*$/

function findingLine(f: Finding): string {
  const judged = [f.source_class, f.confidence].filter(Boolean).join('/')
  const ids = [...new Set((f.sources ?? []).map(sourceId))].join(', ')
  // The log keeps 400 characters of a text, and a part's mass stands at its end: a long material description
  // pushes it off. The stored figure says it then — a part without its mass is no row to hold a model against.
  const cutMass =
    f.component && typeof f.mass_kg === 'number' && !ENDS_ON_MASS.test(f.text) ? ` …: ${f.mass_kg} kg` : ''
  return [
    `- ${oneLine(f.text)}${cutMass}`,
    f.mass_range_kg ? ` (range ${f.mass_range_kg[0]}–${f.mass_range_kg[1]} kg)` : '',
    f.version ? ` (version: ${oneLine(f.version)})` : '',
    judged ? ` [${judged}]` : '',
    f.confidence_note ? ` (${oneLine(f.confidence_note)})` : '',
    f.note ? ` Note: ${oneLine(f.note)}` : '',
    ids ? ` — ${ids}` : '',
    f.cited_by_search === false ? ' (source not returned by the search engine)' : '',
    f.unsourced
      ? ' — NO SOURCE'
      : typeof f.unsourced_kg === 'number'
        ? ` — NO SOURCE for ${f.unsourced_kg} kg of it`
        : ''
  ].join('')
}

const strength = (f: Finding): number =>
  (CLASS_RANK[f.source_class ?? ''] ?? 4) * 10 + (CONFIDENCE_RANK[f.confidence ?? ''] ?? 3)

/** "3 media, 1 community" — what was left out, by the kind of source it rested on. */
function byClass(findings: Finding[]): string {
  const n = new Map<string, number>()
  for (const f of findings)
    n.set(f.source_class ?? 'unclassed', (n.get(f.source_class ?? 'unclassed') ?? 0) + 1)
  return [...n].map(([k, v]) => `${v} ${k}`).join(', ')
}

type Total = NonNullable<BomCheck['totals']>[number]

const totalText = (t: Total): string =>
  `${t.mass_kg} kg ${t.basis === 'unknown' ? 'scope not stated' : t.basis}` +
  `${t.version ? `, ${t.version}` : ''}${t.source ? ` — ${sourceId(t.source)}` : ''}`

function checkLines(check: BomCheck): string[] {
  const lines: string[] = []
  if (check.requests?.length)
    lines.push(`  Requested: ${check.requests.map((r) => `${r.component} ${r.status}`).join(' · ')}`)
  if (check.unresolved?.length)
    lines.push(
      `  Left open: ${check.unresolved
        .map((u) => `${u.component} (${u.reason}${u.note ? `: ${oneLine(u.note)}` : ''})`)
        .join('; ')}`
    )
  if (check.unsourced?.length) lines.push(`  Counted with NO SOURCE: ${check.unsourced.join('; ')}`)
  if (check.totals?.length)
    lines.push(
      `  Whole-product masses found${new Set(check.totals.map((t) => t.mass_kg)).size > 1 ? ' (they differ)' : ''}: ` +
        check.totals.map(totalText).join('; ')
    )
  const m = check.recipe
  // A recipe that does not close is an open point like a part without a mass: said as such, with its gap.
  if (m) {
    const gap =
      typeof m.gap_pct === 'number'
        ? ` (${Math.abs(m.gap_pct)} %${typeof m.gap_kg === 'number' ? `, ${Math.abs(m.gap_kg)} kg` : ''} ${m.gap_pct >= 0 ? 'unaccounted' : 'over'})`
        : ''
    const whose =
      m.kind === 'frame'
        ? ', a frame formulation'
        : m.kind === 'product'
          ? ''
          : ", not said whether the product's own"
    lines.push(
      `  Recipe of ${m.of}${m.formulation ? ` ("${m.formulation}"${whose})` : ''}: ` +
        (m.closes === true
          ? `closes${gap}`
          : m.closes === false
            ? `does NOT close${gap} — not settled`
            : `closure not checked${m.note ? ` (${oneLine(m.note)})` : ''} — not settled`) +
        (m.reachable_by_ranges !== undefined
          ? `; its ranges ${m.reachable_by_ranges ? 'can' : 'cannot'} reach the total`
          : '') +
        (m.missing_ingredients?.length
          ? `; lacks ingredients known from the product: ${m.missing_ingredients.join(', ')}`
          : '') +
        (typeof m.mass_kg === 'number'
          ? `; scaled to ${m.mass_kg} kg (${m.mass_source ?? 'source not stated'})`
          : '; shares only, no kg')
    )
  }
  const v = check.versions
  // One line per version: run together, a reader attached the boards to the version named after them.
  if (v?.conflict && v.used?.length)
    lines.push(
      '  Versions: the figures rest on DIFFERENT versions of the product:',
      ...v.used.map((u) => `    - ${u.version}: ${u.entries.join('; ')}`)
    )
  if (v?.seen?.length)
    lines.push(
      `  Other versions the sources showed: ${v.seen
        .map(
          (s) =>
            `${s.version}${s.differs_by ? ` (${oneLine(s.differs_by)})` : ''}` +
            `${typeof s.mass_kg === 'number' ? ` ${s.mass_kg} kg` : ''}${s.sold_by ? `, ${s.sold_by}` : ''}` +
            `${s.source ? ` — ${sourceId(s.source)}` : ''}`
        )
        .join('; ')}`
    )
  return lines
}

interface Product {
  name: string
  entries: Entry[]
}

/** One product's bill-of-materials record: the latest check whole, earlier ones a line each, then the parts. */
function productBlock(p: Product, parts: number): string[] {
  const checks = p.entries.filter((e) => e.bom_check)
  const latest = checks[checks.length - 1]
  const lines = [`BILL OF MATERIALS: ${cap(p.name, QUESTION_CHARS)}`]
  if (latest) {
    lines.push(`Check of ${day(latest.asked)}: ${oneLine(latest.bom_check!.summary ?? '(no summary)')}`)
    if (latest.context) lines.push(`  Given to the research: ${oneLine(latest.context)}`)
    lines.push(...checkLines(latest.bom_check!))
    // An earlier check keeps the whole-product masses the latest one did not find again: a later call for one
    // part says nothing about the totals, and without them the reviewer cannot set the picked one beside them.
    const known = new Set((latest.bom_check!.totals ?? []).map(totalText))
    for (const e of checks.slice(0, -1)) {
      const others = (e.bom_check!.totals ?? []).map(totalText).filter((t) => !known.has(t))
      lines.push(
        `Earlier check of ${day(e.asked)}: ${cap(e.bom_check!.summary ?? '(no summary)', 220)}` +
          (e.context && e.context !== latest.context ? ` Given: ${cap(e.context, 160)}` : '') +
          (others.length ? ` Whole-product masses it found: ${others.join('; ')}` : '')
      )
    }
  }
  const all = p.entries.flatMap((e) => e.findings)
  if (all.length) {
    // The newest calls' parts when not all fit: a later call is the one the model most likely built on.
    const shown = parts >= all.length ? all : all.slice(all.length - parts)
    const asked = [...new Set(p.entries.filter((e) => e.findings.length).map((e) => day(e.asked)))]
    lines.push(
      `Part masses found (asked ${asked.join(', ')}${asked.length > 1 ? '; oldest first' : ''}):`,
      ...shown.map(findingLine)
    )
    if (shown.length < all.length)
      lines.push(
        `  (+${all.length - shown.length} earlier part masses: ${byClass(all.slice(0, all.length - shown.length))})`
      )
  }
  return lines
}

interface Question {
  question: string
  dates: string[]
  contexts: string[]
  findings: Finding[]
}

function questionLines(q: Question, perQuestion: number, contextBefore: string | undefined): string[] {
  const lines = [`Q (${q.dates.join(', ')}): ${cap(q.question, QUESTION_CHARS)}`]
  const ordered = [...q.findings].sort((a, b) => strength(a) - strength(b))
  const shown = ordered.slice(0, perQuestion)
  if (perQuestion > 0 && q.contexts.length) {
    const ctx = q.contexts.join(' | ')
    lines.push(`  Given: ${ctx === contextBefore ? 'as above' : ctx}`)
  }
  lines.push(...shown.map(findingLine))
  const cut = ordered.slice(shown.length)
  if (cut.length)
    lines.push(
      perQuestion > 0
        ? `  (+${cut.length} more: ${byClass(cut)})`
        : `  (${cut.length} finding${cut.length === 1 ? '' : 's'}: ${byClass(cut)})`
    )
  return lines
}

const EUROSTAT = 'Eurostat end-of-life statistics:'
const DISTANCE = /^(Road|Sea|Air|Rail) distance /

/** A Eurostat or distance look-up on one line: its table and year, or its route and kilometres. */
function toolLine(e: Entry): string {
  if (e.question.startsWith(EUROSTAT)) {
    const provisional = e.findings.some((f) => /\bNOT final\b/.test(f.text))
    return `- Eurostat ${e.question.slice(EUROSTAT.length).trim()}${provisional ? ' — NOT all values final' : ''}`
  }
  // The figure is the first sentence of each finding; the attribution after it is the tool's, not the route's.
  const legs = e.findings.map((f) => f.text.split(/;\s|\.\s/)[0]).filter(Boolean)
  const doubt = e.findings.map((f) => f.confidence_note).filter(Boolean)
  return `- ${cap(`${e.question}: ${legs.join('; ')}${doubt.length ? ` (${doubt.join('; ')})` : ''}`, TOOL_LINE_CHARS)}`
}

const isEntry = (e: unknown): e is Entry =>
  !!e &&
  typeof e === 'object' &&
  typeof (e as Entry).question === 'string' &&
  Array.isArray((e as Entry).findings)

/** The dossier section, or '' when nothing was researched for the model. */
export function researchSection(log: unknown): string {
  const entries = (Array.isArray(log) ? log : []).filter(isEntry)
  if (!entries.length) return ''
  const products: Product[] = []
  const questions: Question[] = []
  const tools: Entry[] = []
  for (const e of entries) {
    if (e.bom_check || e.question.startsWith('Bill of materials:')) {
      const name = e.question.replace(/^Bill of materials:\s*/, '')
      const p = products.find((x) => x.name === name)
      if (p) p.entries.push(e)
      else products.push({ name, entries: [e] })
    } else if (e.question.startsWith(EUROSTAT) || DISTANCE.test(e.question)) tools.push(e)
    else {
      // One question asked with two contexts (two products, two countries) is two questions: merged, a
      // finding could no longer be told apart from the other product's.
      const context = e.context ? oneLine(e.context) : ''
      const q = questions.find((x) => x.question === e.question && (x.contexts[0] ?? '') === context)
      const target = q ?? { question: e.question, dates: [], contexts: [], findings: [] }
      if (!q) questions.push(target)
      if (!target.dates.includes(day(e.asked))) target.dates.push(day(e.asked))
      if (context && !target.contexts.length) target.contexts.push(context)
      target.findings.push(...e.findings)
    }
  }

  const render = (perQuestion: number, folded: number, toolsFolded: boolean, parts: number): string => {
    const lines = [HEAD, ...products.flatMap((p) => productBlock(p, parts))]
    if (questions.length) lines.push('WEB RESEARCH:')
    if (folded) {
      // A question asked again later keeps its first place, so the folded ones need not be in date order.
      const dates = [...new Set(questions.slice(0, folded).flatMap((q) => q.dates))].sort()
      const span = [...new Set([dates[0], dates[dates.length - 1]])].join(' – ')
      lines.push(`- ${folded} earlier question${folded === 1 ? '' : 's'} not shown (asked ${span})`)
    }
    let before: string | undefined
    for (const q of questions.slice(folded)) {
      lines.push(...questionLines(q, perQuestion, before))
      before = q.contexts.join(' | ') || undefined
    }
    if (tools.length) {
      lines.push('LOOK-UPS (Eurostat, distances):')
      lines.push(...(toolsFolded ? [`- ${tools.length} look-ups not shown`] : tools.map(toolLine)))
    }
    return lines.join('\n')
  }

  // The ladder, mildest step first: fewer findings per question, then the oldest questions folded into one
  // line, then the look-ups, then fewer part masses. The first rendering that fits is the section.
  for (const n of PER_QUESTION) {
    const text = render(n, 0, false, Infinity)
    if (text.length <= SECTION_CHARS) return text
  }
  for (let folded = 1; folded <= questions.length; folded++) {
    const text = render(0, folded, false, Infinity)
    if (text.length <= SECTION_CHARS) return text
  }
  for (const parts of PARTS_PER_PRODUCT) {
    const text = render(0, questions.length, true, parts)
    if (text.length <= SECTION_CHARS) return text
  }
  // Only a log of many long bill-of-materials checks gets here: whole lines go, counted, never half a finding.
  const lines = render(0, questions.length, true, 0).split('\n')
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    if (size + line.length + 1 > SECTION_CHARS - 60) break
    kept.push(line)
    size += line.length + 1
  }
  return `${kept.join('\n')}\n[${lines.length - kept.length} more lines not shown]`
}

/** The health check's entry on the bill-of-materials research (`engine/health_bom.py`). */
const ON_RECORD = 'bom_research_on_record'
/** What a section that lists part masses contains (`productBlock`). */
const PARTS_LISTED = 'Part masses found'
/** What it says where it could not list all of them. */
const PARTS_LEFT_OUT = 'earlier part masses:'

/**
 * The health check as the dossier prints it. Where the research section lists the part masses, the health check's
 * own list of them is cut to what only it knows: how many are on record, that it compared none of them with the
 * model, and its remarks on parameters that hold a part's mass and lead to no input. Twice in one dossier, the rows
 * would take room the health check is cut for, and the section's rows are the fuller ones — each with its
 * version, its derivation and the check it came from.
 */
export function healthBesideResearch(health: unknown, section: string): unknown {
  // A section that had to leave part masses out (`productBlock` counts them) is no place to send the reader.
  if (!section.includes(PARTS_LISTED) || section.includes(PARTS_LEFT_OUT)) return health
  if (!health || typeof health !== 'object') return health
  const findings = (health as { findings?: unknown }).findings
  if (!Array.isArray(findings)) return health
  return {
    ...health,
    findings: findings.map((f: { code?: string; parts?: number; remarks?: unknown }) => {
      if (f?.code !== ON_RECORD) return f
      const remarks = Array.isArray(f.remarks) ? f.remarks.filter((r) => typeof r === 'string') : []
      const { remarks: _listed, ...rest } = f
      return {
        ...rest,
        message:
          `The bill-of-materials research has ${f.parts === 1 ? '1 part mass' : `${f.parts ?? 'several'} part masses`} ` +
          `on record, listed under RESEARCH ON RECORD ("${PARTS_LISTED}"). The health check compares none of ` +
          'them with the model. ' +
          (remarks.length
            ? `Its remarks say where a parameter leads, not that a part is missing: ${remarks.join(' ')}`
            : 'It has no remark on any of them.')
      }
    })
  }
}
