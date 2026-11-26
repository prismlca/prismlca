/**
 * Scoring for the research eval (research-eval.test.ts): which gates one research result meets, how close the
 * parts that carry a reference product's climate result come to it, which findings the citation judge reads,
 * and the hit rate of every gate over repeated runs. Pure — no provider, no network — so the scoring is
 * tested offline (score.test.ts) and a paid run spends its money on the research alone.
 *
 * A gate is binary and answers one question about one run: met, missed, or not applicable to what came back.
 * Over repeats a gate has a hit rate, never an average of something else. `integrity` gates are what the code
 * promises whatever the model does (a figure names its page or says it has none, an open part keeps the
 * balance unjudged); a miss there is a defect and fails the run. Every other kind is the model's work and is
 * counted, not asserted.
 */
import type { BomItem } from '../bomAnswer'
import type { RecipeLineOut } from '../recipeBalance'
import type { BomResult } from '../researchBom'
import type { WebFinding } from '../subagent'

export type GateKind = 'integrity' | 'fact' | 'consistency' | 'uncertainty' | 'verdict' | 'citation'

/** One gate of one run: met (true), missed (false), or not applicable to what came back (null). */
export interface GateResult {
  id: string
  kind: GateKind
  label: string
  ok: boolean | null
}

/** A part of a reference product, with the values a result may give for it. */
export interface ReferencePart {
  id: string
  label: string
  /** Finds the part: a component name for `items`, an INCI name or a line's name for `recipe`. */
  match: RegExp
  where: 'items' | 'recipe'
  /** The part may be flagged as packaging (a refill pouch, a carton); other parts never take packaging. */
  packaging?: boolean
  /** Accepted values: kg for parts; for recipe lines percent of the mixture of the substance itself (active
   *  matter, a trade form booked as its constituents). */
  accept: Array<[number, number]>
  /** For a recipe line dosed as a trade form whose composition the result does not state (not split): the
   *  spans of the trade form as dosed — a 27-% surfactant solution at ≈ 31 %. Without it such a line is read
   *  against `accept`. A line that names the substance alone is read as the substance, never as a solution. */
  acceptAsDosed?: Array<[number, number]>
  /** `sourced`: a public page states the figure (or it follows from one by arithmetic); `estimate`: nothing
   *  public, the span is a reasoned estimate, and a different reasoned estimate inside it costs nothing. */
  basis: 'sourced' | 'estimate'
  /** Share of the reference's climate result (GWP100) the part carries, in percent: what a miss costs. */
  climateShare: number
  /** The reference value and where it comes from, as the report prints it. */
  note: string
}

/** What a result gave for one reference part. */
export interface PartValue {
  part: ReferencePart
  /** Sum over the matched entries; null when nothing matched (or no matched line has a share). */
  value: number | null
  items: BomItem[]
  lines: RecipeLineOut[]
  /** A matched line is dosed as a trade form whose composition the result does not state. */
  dosed: boolean
}

export type PartValues = Map<string, PartValue>

export interface ReferenceGate {
  id: string
  kind: 'fact' | 'consistency' | 'uncertainty'
  label: string
  check: (r: BomResult, parts: PartValues) => boolean | null
}

export const gate = (
  kind: ReferenceGate['kind'],
  id: string,
  label: string,
  check: ReferenceGate['check']
): ReferenceGate => ({ id, kind, label, check })

const RECIPE_GROUP = 'recipe'

/** The names a line, or one of its pieces, is written under — split where a leg wrote a blend as one line. */
const pieces = (text: string): string[] =>
  text
    .split(/[,;+&]|\(and\)| and | und /i)
    .map((x) => x.trim())
    .filter(Boolean)

/** A trade form booked as its constituents, each with its share of the mixture. */
const splitConstituents = (line: RecipeLineOut): Array<{ name: string; share_pct?: number }> =>
  line.trade_form?.split ? (line.trade_form.constituents ?? []) : []

/**
 * Assign the result's entries to the reference parts: each entry to the first part it matches, in the order
 * the reference lists them (the wheel before the small parts, so "Rad mit Kugellager" is the wheel), and the
 * matched masses or shares summed — a leg that splits one requested part into two entries still gives one value.
 *
 * Recipe lines: a trade form booked as its constituents gives each constituent to its own part. Any other line
 * belongs to a part only when everything it names is that part: a blend written as one line ("Sodium Laureth
 * Sulfate, Cocamidopropyl Betaine", 8 %) says how much of the blend there is, not how much of either.
 */
export function partValues(parts: ReferencePart[], r: BomResult): PartValues {
  const out: PartValues = new Map(
    parts.map((p) => [p.id, { part: p, value: null, items: [], lines: [], dosed: false }])
  )
  const add = (v: PartValue, n: number): void => {
    v.value = Number(((v.value ?? 0) + n).toFixed(6))
  }
  for (const item of r.items) {
    if (item.group === RECIPE_GROUP) continue
    const p = parts.find(
      (p) =>
        p.where === 'items' && (item.packaging ? p.packaging === true : true) && p.match.test(item.component)
    )
    if (!p) continue
    const v = out.get(p.id)!
    v.items.push(item)
    add(v, item.mass_kg)
  }
  const recipeParts = parts.filter((p) => p.where === 'recipe')
  for (const line of r.recipe?.lines ?? []) {
    const constituents = splitConstituents(line)
    if (constituents.length) {
      for (const p of recipeParts) {
        const hit = constituents.filter((c) => p.match.test(c.name) && typeof c.share_pct === 'number')
        if (!hit.length) continue
        const v = out.get(p.id)!
        v.lines.push(line)
        add(
          v,
          hit.reduce((s, c) => s + (c.share_pct ?? 0), 0)
        )
      }
      continue
    }
    const names = pieces(line.inci || line.name)
    const p = recipeParts.find((p) => names.length > 0 && names.every((n) => p.match.test(n)))
    if (!p || typeof line.share_pct !== 'number') continue
    const v = out.get(p.id)!
    v.lines.push(line)
    if (line.trade_form) v.dosed = true
    add(v, line.share_pct)
  }
  return out
}

/** 1 inside the span; falling linearly to 0 at half the bound's value beyond it. */
function spanScore(v: number, [lo, hi]: [number, number]): number {
  if (v >= lo && v <= hi) return 1
  const dev = v < lo ? (lo - v) / lo : (v - hi) / hi
  return Math.max(0, 1 - 2 * dev)
}

export interface PartScore {
  id: string
  basis: ReferencePart['basis']
  climateShare: number
  value: number | null
  /** Read as a trade form dosed whole (`acceptAsDosed`). */
  dosed?: boolean
  score: number
}

/**
 * Accuracy weighted by what each part carries of the climate result: a frame 30 % off costs far more than
 * handles twice their weight. A part that did not come back scores 0 — its share of the result is missing,
 * however honestly it was left open (honesty has its own gate). Returns 0–1 with each part's score.
 */
export function accuracy(values: PartValues): { score: number; parts: PartScore[] } {
  const parts: PartScore[] = [...values.values()].map(({ part, value, dosed }) => {
    const spans = dosed && part.acceptAsDosed ? part.acceptAsDosed : part.accept
    return {
      id: part.id,
      basis: part.basis,
      climateShare: part.climateShare,
      value,
      ...(dosed ? { dosed } : {}),
      score: value === null ? 0 : Math.max(...spans.map((span) => spanScore(value, span)))
    }
  })
  const weight = parts.reduce((s, p) => s + p.climateShare, 0)
  const score = weight ? parts.reduce((s, p) => s + p.climateShare * p.score, 0) / weight : 0
  return { score: Number(score.toFixed(3)), parts }
}

// --- Gates every research_bom result has to meet -------------------------------------------------------------

/** What the code promises for any bill of materials, whatever the model wrote. A miss here is a defect. */
export function bomIntegrity(r: BomResult): GateResult[] {
  const unsourced = r.items.filter((i) => i.unsourced)
  return [
    {
      id: 'sourced',
      kind: 'integrity',
      label: 'every figure names its page or is marked unsourced, and all_sourced agrees',
      ok:
        r.items.every((i) => !!i.source_url || i.unsourced === true) &&
        (r.all_sourced === undefined || r.all_sourced === (unsourced.length === 0))
    },
    {
      id: 'no-ghosts',
      kind: 'integrity',
      label: 'no entry with a zero or negative mass',
      ok: r.items.every((i) => i.mass_kg > 0)
    },
    {
      id: 'honest-balance',
      kind: 'integrity',
      label: 'a list with open parts is not judged (balance_ok null)',
      ok: r.unresolved.length ? r.balance_ok === null : null
    }
  ]
}

/** Whether the balance judged at all. Counted, not asserted: an unjudged list can be the honest answer. */
export function balanceJudged(r: BomResult): GateResult {
  return { id: 'judged', kind: 'verdict', label: 'the balance gave a verdict', ok: r.balance_ok !== null }
}

/** Parts nothing public states must not come back as certain: no entry of an estimate part with confidence high. */
export function estimatesHedged(values: PartValues): GateResult {
  const items = [...values.values()].filter((v) => v.part.basis === 'estimate').flatMap((v) => v.items)
  return {
    id: 'estimates-hedged',
    kind: 'uncertainty',
    label: 'no figure for a part nothing public states claims high confidence',
    ok: items.length ? items.every((i) => i.confidence !== 'high') : null
  }
}

/** All gates of a reference product's run, integrity first. */
export function referenceGates(gates: ReferenceGate[], r: BomResult, values: PartValues): GateResult[] {
  return [
    ...bomIntegrity(r),
    ...gates.map((g) => ({ id: g.id, kind: g.kind, label: g.label, ok: g.check(r, values) })),
    estimatesHedged(values),
    balanceJudged(r)
  ]
}

// --- Checks the reference products are built from ------------------------------------------------------------

const within = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi

/** The part came back inside [lo, hi]; missed when it did not come back at all — the figure is public. */
export const partWithin =
  (id: string, lo: number, hi: number): ReferenceGate['check'] =>
  (_r, values) => {
    const v = values.get(id)?.value
    return v === null || v === undefined ? false : within(v, lo, hi)
  }

/** Every entry of the part names a material matching `yes` and none matching `no`; n/a when it did not come back. */
export const materialOf =
  (id: string, yes: RegExp, no: RegExp): ReferenceGate['check'] =>
  (_r, values) => {
    const items = values.get(id)?.items ?? []
    return items.length ? items.every((i) => yes.test(i.material) && !no.test(i.material)) : null
  }

/** A whole-product mass in [lo, hi] is among those the research found. */
export const totalFound =
  (lo: number, hi: number): ReferenceGate['check'] =>
  (r) =>
    (r.totals_found ?? []).some((t) => within(t.mass_kg, lo, hi))

/** The whole-product mass the balance used, when it used one, lies in [lo, hi]; n/a when none was used. */
export const totalUsedWithin =
  (lo: number, hi: number): ReferenceGate['check'] =>
  (r) =>
    r.total_used ? within(r.total_used.mass_kg, lo, hi) : null

/**
 * The other version stays the other version: nothing of it is used — no entry is taken from it (its reference
 * names it, `other`) and the whole-product mass the balance used is not its (a mass in [lo, hi] or a reference
 * naming it) — and where its mass is among the whole-product masses found, the reference says whose it is. N/a
 * when the other version shows up nowhere.
 */
export const otherVersionKeptApart =
  (lo: number, hi: number, other: RegExp): ReferenceGate['check'] =>
  (r) => {
    const names = (v?: string): boolean => !!v && other.test(v)
    const used = r.total_used
    if (r.items.some((i) => names(i.version))) return false
    if (used && (names(used.version) || within(used.mass_kg, lo, hi))) return false
    const totals = (r.totals_found ?? []).filter((t) => within(t.mass_kg, lo, hi))
    const seen = (r.versions?.seen ?? []).filter(
      (s) => names(s.version) || (typeof s.mass_kg === 'number' && within(s.mass_kg, lo, hi))
    )
    const named = (r.totals_found ?? []).some((t) => names(t.version))
    if (!totals.length && !seen.length && !named) return null
    return totals.every((t) => names(t.version))
  }

/** No part and no whole-product mass at or above `kg` — a load rating read as a mass. */
export const noMassAbove =
  (kg: number): ReferenceGate['check'] =>
  (r) =>
    r.items.every((i) => i.mass_kg < kg) && (r.totals_found ?? []).every((t) => t.mass_kg < kg)

/**
 * The parts (packaging and recipe aside) add up to [lo, hi]. Above `hi` is a miss even with parts still open —
 * open parts only add; below `lo` counts only when nothing is open.
 */
export const partsSumWithin =
  (lo: number, hi: number): ReferenceGate['check'] =>
  (r) => {
    const sum = r.items
      .filter((i) => !i.packaging && i.group !== RECIPE_GROUP)
      .reduce((s, i) => s + i.mass_kg, 0)
    if (sum > hi) return false
    if (r.unresolved.length) return null
    return sum >= lo
  }

/** The researched recipe closes on its denominator; missed when no recipe came back. */
export const recipeCloses = (): ReferenceGate['check'] => (r) => (r.recipe ? r.recipe.closes === true : false)

/** The formulation is not passed off as the product's own — its real shares are not public. */
export const formulationNotOwn = (): ReferenceGate['check'] => (r) => {
  const kind = r.recipe?.formulation?.kind
  return kind ? kind !== 'product' : null
}

/** An ingredient name as a comparison reads it: upper case, words only. */
export const inciKey = (s: string): string =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()

/**
 * What a recipe line is made of, by name: the constituents of a trade form when the result lists them, else the
 * line's INCI name or name, split where a leg wrote a blend as one line. `share` is each name's percent of the
 * mixture where the result states it — a constituent's own share, or the line's when it names one substance.
 */
const lineContents = (line: RecipeLineOut): Array<{ key: string; share?: number }> => {
  const constituents = line.trade_form?.constituents ?? []
  if (constituents.length)
    return constituents.map((c) => ({
      key: inciKey(c.name),
      ...(line.trade_form?.split && typeof c.share_pct === 'number' ? { share: c.share_pct } : {})
    }))
  const names = pieces(line.inci || line.name).map(inciKey)
  return names.length === 1 && typeof line.share_pct === 'number'
    ? [{ key: names[0], share: line.share_pct }]
    : names.map((key) => ({ key }))
}

/**
 * The printed ingredient list was found: at least `min` of its names are accounted for, as (a constituent of) a
 * line of the recipe or among the ingredients the result names as missing (which it can only name from a list it
 * read).
 */
export const labelFound =
  (printed: string[], min: number): ReferenceGate['check'] =>
  (r) => {
    const seen = new Set([
      ...(r.recipe?.lines ?? []).flatMap((l) => lineContents(l).map((c) => c.key)),
      ...(r.recipe?.missing_ingredients ?? []).map(inciKey)
    ])
    const keys = printed.map(inciKey)
    return keys.filter((k) => seen.has(k)).length / keys.length >= min
  }

/**
 * The formulation fits the printed list: its main ingredients are in it (as lines or constituents), and what the
 * label does not name holds at most `maxForeignPct` of the mixture — a frame recipe's extra surfactant is not this
 * product's. A blend line that mixes listed and unlisted names, or an unlisted line without a share, leaves the
 * foreign share unknown: then the gate is missed only when the known part already passes the limit, else n/a.
 * N/a without a recipe.
 */
export const fitsLabel =
  (printed: string[], main: string[], maxForeignPct: number): ReferenceGate['check'] =>
  (r) => {
    const lines = r.recipe?.lines
    if (!lines?.length) return null
    const label = new Set(printed.map(inciKey))
    const contents = lines.map(lineContents)
    const names = new Set(contents.flat().map((c) => c.key))
    if (!main.every((m) => names.has(inciKey(m)))) return false
    let foreign = 0
    let unknown = false
    lines.forEach((line, i) => {
      const off = contents[i].filter((c) => !label.has(c.key))
      if (!off.length) return
      if (off.every((c) => typeof c.share === 'number'))
        foreign += off.reduce((s, c) => s + (c.share ?? 0), 0)
      else if (off.length === contents[i].length && typeof line.share_pct === 'number')
        foreign += line.share_pct
      else unknown = true
    })
    if (foreign > maxForeignPct) return false
    return unknown ? null : true
  }

// --- What the citation judge reads ---------------------------------------------------------------------------

/** A claim for the judge, with the leg's own words on where the figure comes from. */
const claimOf = (text: string, note?: string): string =>
  note?.trim() ? `${text}. The researcher's note: ${note.trim().slice(0, 400)}` : text

/**
 * The findings a reference product's result rests on: per part that came back, in order of the climate share it
 * carries, the heaviest matched entry (or line), with the page it names — a line of the formulation names none of
 * its own and stands on the formulation's. The judge reads these — not whichever came first. A carrying part with
 * no page at all is handed on with no source, so the run says what could not be checked.
 */
export function carryingFromParts(values: PartValues, r: BomResult, max = 3): WebFinding[] {
  const out: WebFinding[] = []
  const formulation = r.recipe?.formulation?.source_url
  const ranked = [...values.values()]
    .filter((v) => v.value !== null)
    .sort((a, b) => b.part.climateShare - a.part.climateShare)
  for (const v of ranked.slice(0, max)) {
    const item = [...v.items].sort(
      (a, b) => (b.source_url ? 1 : 0) - (a.source_url ? 1 : 0) || b.mass_kg - a.mass_kg
    )[0]
    if (item) {
      out.push({
        text: claimOf(`${item.component} (${item.material}): ${item.mass_kg} kg`, item.note),
        sources: item.source_url ? [item.source_url] : []
      })
      continue
    }
    const line = v.lines[0]
    if (!line) continue
    const source = line.source_url ?? formulation
    out.push({
      text: claimOf(
        `${line.inci ?? line.name}: ${v.value} % of the mixture` +
          (line.trade_form ? ` (dosed as ${line.trade_form.name})` : '') +
          (r.recipe?.formulation?.name ? `, from the formulation "${r.recipe.formulation.name}"` : ''),
        line.note
      ),
      sources: source ? [source] : []
    })
  }
  return out
}

/** Without a reference: the heaviest entries that name a page. */
export function carryingByMass(items: BomItem[], max = 3): WebFinding[] {
  return [...items]
    .filter((i) => i.source_url)
    .sort((a, b) => b.mass_kg - a.mass_kg)
    .slice(0, max)
    .map((i) => ({
      text: claimOf(`${i.component} (${i.material}): ${i.mass_kg} kg`, i.note),
      sources: [i.source_url!]
    }))
}

/** For a web question: the findings that carry a figure, in the order the leg gave them; else the first ones. */
export function carryingFindings(findings: WebFinding[], max = 3): WebFinding[] {
  const sourced = findings.filter((f) => f.sources[0])
  const figures = sourced.filter((f) => /\d/.test(f.text))
  return (figures.length ? figures : sourced).slice(0, max)
}

/** A carrying finding the judge did not read because the run's budget was spent. */
export const SKIPPED_FOR_BUDGET = 'skipped_budget'

/**
 * The judge's verdicts as one gate: every readable check supports the claim (at least in part). N/a when nothing
 * was readable, and when the budget cut the judging short — a part-read run would pass on what it happened to read.
 */
export function citationGate(verdicts: string[]): GateResult {
  const read = verdicts.filter((v) => ['supports', 'partly', 'contradicts', 'not_on_page'].includes(v))
  return {
    id: 'carries',
    kind: 'citation',
    label: 'the cited pages carry the findings the result rests on',
    ok:
      read.length && !verdicts.includes(SKIPPED_FOR_BUDGET)
        ? read.every((v) => v === 'supports' || v === 'partly')
        : null
  }
}

// --- Web lookups and the tally over repeats ------------------------------------------------------------------

/** One request's web lookups by tool: the cap holds for each tool on its own (OpenRouter and Anthropic alike). */
export interface WebRequest {
  search: number
  fetch: number
}

/**
 * The provider's web lookups in one request's usage report. Anthropic, OpenAI and Google report them as
 * `server_tool_use`; OpenRouter passes its own report through as `server_tool_use_details`, which counts searches
 * only. Null when the report has neither.
 */
export function lookupsIn(usage: Record<string, unknown>): WebRequest | null {
  const counters = [usage.server_tool_use, usage.server_tool_use_details].find(
    (c): c is Record<string, unknown> => !!c && typeof c === 'object'
  )
  if (!counters) return null
  const count = (k: string): number => {
    const n = Number(counters[k])
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  return { search: count('web_search_requests'), fetch: count('web_fetch_requests') }
}

export interface RunRecord {
  scenario: string
  /** The lookup cap the run used; 0 = none of ours. */
  lookups: number
  repeat: number
  ms: number
  usd: number
  judgeUsd: number
  /** Each web-searching request of the run, its lookups by tool as the provider reported them. */
  webRequests: WebRequest[]
  gates: GateResult[]
  accuracy?: number
  /** Why the run has no gates: stopped at its spend ceiling, or failed. */
  error?: string
}

export interface VariantSummary {
  scenario: string
  lookups: number
  runs: number
  errors: number
  gates: Array<{ id: string; kind: GateKind; label: string; hits: number; of: number }>
  accuracy?: { mean: number; min: number; max: number }
  usdMean: number
  msMedian: number
  /** The most lookups one tool ran in one request, and how many requests had a tool reach the cap — a cap no
   *  request reaches decides nothing. */
  lookupsMax: number
  atCap: { requests: number; of: number }
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** One line per scenario and cap: the hit rate of each gate over the runs that got as far as being scored. */
export function summarise(runs: RunRecord[]): VariantSummary[] {
  const groups = new Map<string, RunRecord[]>()
  for (const r of runs) {
    const k = `${r.scenario}\u0000${r.lookups}`
    groups.set(k, [...(groups.get(k) ?? []), r])
  }
  return [...groups.values()].map((rs) => {
    const scored = rs.filter((r) => !r.error)
    const gates = new Map<string, VariantSummary['gates'][number]>()
    for (const g of scored.flatMap((r) => r.gates)) {
      const t = gates.get(g.id) ?? { id: g.id, kind: g.kind, label: g.label, hits: 0, of: 0 }
      if (g.ok !== null) {
        t.of += 1
        if (g.ok) t.hits += 1
      }
      gates.set(g.id, t)
    }
    const acc = scored.map((r) => r.accuracy).filter((a): a is number => typeof a === 'number')
    const web = rs.flatMap((r) => r.webRequests)
    const cap = rs[0].lookups
    return {
      scenario: rs[0].scenario,
      lookups: cap,
      runs: rs.length,
      errors: rs.length - scored.length,
      gates: [...gates.values()],
      ...(acc.length
        ? {
            accuracy: {
              mean: Number((acc.reduce((s, a) => s + a, 0) / acc.length).toFixed(3)),
              min: Math.min(...acc),
              max: Math.max(...acc)
            }
          }
        : {}),
      usdMean: Number((rs.reduce((s, r) => s + r.usd + r.judgeUsd, 0) / rs.length).toFixed(4)),
      msMedian: median(rs.map((r) => r.ms)),
      lookupsMax: Math.max(0, ...web.map((w) => Math.max(w.search, w.fetch))),
      atCap: {
        requests: cap > 0 ? web.filter((w) => w.search >= cap || w.fetch >= cap).length : 0,
        of: web.length
      }
    }
  })
}
