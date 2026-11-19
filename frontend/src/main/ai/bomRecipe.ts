/**
 * The recipe leg of a bill-of-materials research: the instruction its researcher works under, the question it is
 * asked, and its answer read — one named formulation with every ingredient as the source doses it, the trade forms
 * with the constituents their datasheets state, the product's own declared ingredient list and the mass of the
 * mixture in the product. Validation only: nothing here sums, closes or converts (recipeBalance.ts does).
 *
 * Why a mixture gets a leg of its own: researched ingredient by ingredient, every researcher found a figure on its
 * own basis — the water without the water of the surfactant solutions, the surfactants as active matter — and the
 * pieces did not add up to one recipe. Shares of a mixture hang on one denominator and one basis, which only a
 * researcher that sees the whole recipe can keep.
 */
import { clipNote } from './researchNote'
import { inciEntries, listNames } from './inciList'
import type { VersionSeen } from './bomAnswer'

export const RECIPE_SYSTEM = `You research the RECIPE (formulation) of a mixture for life-cycle assessment — a soap, a
detergent, a paint, a food, a rubber compound, a concrete. Answer with ONE JSON object ONLY — no prose, no code fence:
{"formulation": {"name": string, "kind": "product" | "frame", "source_url": string, "table": string,
                 "version": string, "batch": string, "total": {"amount": number, "unit": "g" | "kg"}},
 "lines": [{"name": string, "inci": string, "amount": number | null, "unit": "%" | "g" | "kg" | "parts",
            "range": [number, number], "rest_to_total": true,
            "trade_form": {"name": string, "source_url": string,
                           "constituents": [{"name": string, "inci": string, "pct": number}]},
            "other_recipe": string, "source_url": string, "source_class": string, "confidence": string,
            "note": string}],
 "declared_ingredients": {"names": [string], "source_url": string},
 "contents_mass": [{"mass_kg": number, "volume_l": number, "density_kg_per_l": number, "version": string,
                    "source_url": string, "note": string}],
 "versions_seen": [{"version": string, "differs_by": string, "sold_by": string, "source_url": string}]}
Needed are "formulation" with its "name" and "source_url", and every line's "name", "amount" and "unit"; leave out
what does not apply.

One recipe:
- A recipe gives AMOUNTS. An ingredient list without amounts — the INCI list on a label, a composition without
  percentages — is not a recipe: it goes into "declared_ingredients". When THIS product's own amounts are not
  published, find a formulation of this kind of product WITH amounts (a supplier's frame formulation, a standard, a
  patent example, a study) and give that one, as "kind": "frame".
- Every line comes from the ONE formulation you name: its name (with its edition, when the source gives one) and the
  table or page it is printed on ("table"). A document that prints several recipes is not one source — pick one
  recipe and take every line from it. "version" only for THIS product's own recipe: the version of the product it
  belongs to (an EAN, a reformulation year).
- "kind": "product" when the source gives THIS product's own recipe (its maker, its safety data sheet, its
  registration); "frame" for a frame, model or typical formulation of this kind of product. A frame formulation is a
  valid answer when the product's own is not published — say so by its kind, never pass it off as the product's.
- A line you could only take from ANOTHER recipe or source names that other recipe in "other_recipe" and gives its
  own "source_url". Leave both out for the lines of the formulation itself — a remark about a line goes in "note".

Amounts as the source prints them:
- "amount" and "unit" exactly as printed: "%" for mass percent of the mixture, "g" or "kg" for a mass per batch,
  "parts" for parts by weight (phr). A recipe in volumes (ml, vol %) is not a mass: "amount" null, the printed
  figure in "note". Never convert, round to 100 or rescale.
- "batch" says what the amounts refer to ("100 %", "1 m3", "one 900 g loaf"). "total" is the batch's mass as the
  SOURCE states it — a fresh-concrete density per m3, a recipe's yield; leave it out when the source states none.
  Never add the lines up yourself.
- "rest_to_total": true ONLY on the one line the recipe itself writes as the rest ("water ad 100", "aqua q.s.",
  "to 1000 g"); its "amount" may then be null. Never mark a line as the rest because the lines fall short.
- "range": [min, max] when the source gives a range ("5–10 %", as safety data sheets do); "amount" is then null
  unless the source also prints one value. Never choose a value inside a range.
- An ingredient the source names without an amount still gets a line, with "amount" null.

Trade forms: many ingredients are dosed as a trade form — a surfactant as a 27 % solution, a pigment as a paste.
Name the line as the recipe doses it and add "trade_form" with its "constituents" in mass percent ("sodium laureth
sulfate 27, water 73"; "cocamidopropyl betaine 30, sodium chloride 5, water 65") ONLY as a datasheet of that trade
form states them, with that datasheet's "source_url". When the datasheet gives only the active content, list only
what it states and say so in "note" — never assume the rest is water.

The product:
- "inci" on a line or on a trade form's constituent: the ingredient's name as THIS product's ingredient list prints
  it, when it has one.
- "declared_ingredients": the ingredient list printed on THIS product (the INCI list on the label, the composition
  section of its safety data sheet) — every name, in the printed order (a "+/-" or "may contain" part too, with its
  marker), with its page. Leave it out when none is found.
- "contents_mass": the mass of the mixture in THIS product as sources state it — a net fill mass, or a fill volume
  with a stated density; one entry per figure found, never computed by you, and never the fill of the product
  whose frame formulation you give.
- "versions_seen": other versions of this product the sources showed (another EAN, size, market, reformulation).

"source_class" is official (authority, standard, peer review), industry (manufacturer, supplier, trade association,
patent), media or community — when unsure, pick the LOWER one. "confidence" is high, medium or low for the figure,
and "note" says what it rests on.

Return the JSON as soon as your recipe stands — an answer still unwritten when time runs out is lost.`

/** The shorter question after a timeout: one table, not a survey. */
export const RECIPE_BRIEF =
  'BE BRIEF: one formulation table — its lines with amount and unit, and its one source URL. Do not survey ' +
  'several recipes; one sourced table is enough, and its "kind" still says whether it is this product\'s own.'

/** What the caller asked for: which mixture, the mass it is scaled to, the ingredients already known. */
export interface RecipeRequest {
  /** What the recipe is of ("liquid soap (contents of the pouch)"); the product itself when not given. */
  of?: string
  /** The mass of the mixture in the product, in kg — scales the shares, never checks them. */
  mass_kg?: number
  /** Ingredients known from the product (what the user said, a printed list that is not an INCI list). */
  ingredients?: string[]
  /** THIS product's INCI list as printed, a "may contain" part with its marker: covered like `ingredients`. It
   *  takes the place of any list the leg finds. */
  inci_list?: string[]
}

/** The unit a recipe line is printed in: mass percent, a mass per batch, or parts by weight. */
export type RecipeUnit = '%' | 'g' | 'kg' | 'parts'

export interface TradeForm {
  name?: string
  source_url?: string
  /** Mass percent of each constituent, as the trade form's datasheet states them; `inci` is its name as the
   *  product's ingredient list prints it. */
  constituents: Array<{ name: string; pct: number; inci?: string }>
}

export interface RecipeLine {
  name: string
  inci?: string
  /** As printed, in `unit`; absent when the source gives none, a range only, or not a mass. */
  amount?: number
  unit?: RecipeUnit
  /** The printed unit, when it was not a mass unit (ml, vol %) — the line then has no amount. */
  unit_printed?: string
  range?: [number, number]
  /** The recipe itself writes this line as the rest ("water ad 100"). */
  rest_to_total?: boolean
  trade_form?: TradeForm
  /** The other recipe the line was taken from, when it is not the formulation's own (`other_recipe`). */
  recipe?: string
  source_url?: string
  source_class?: string
  confidence?: string
  note?: string
}

export interface Formulation {
  name: string
  /** `product`: this product's own recipe; `frame`: a frame or typical formulation; `unknown`: not said. */
  kind: 'product' | 'frame' | 'unknown'
  source_url?: string
  table?: string
  version?: string
  /** What the amounts refer to ("100 %", "1 m3"). */
  batch?: string
  /** The batch's mass as the source states it, in kg. */
  total_kg?: number
}

/** A mass of the mixture in this product, as a source states it (or a stated volume × stated density). */
export interface ContentsMass {
  mass_kg: number
  volume_l?: number
  density_kg_per_l?: number
  version?: string
  source_url?: string
  note?: string
}

export interface RecipeLeg {
  formulation?: Formulation
  lines: RecipeLine[]
  /** The ingredient list the leg found printed on the product, in its printed order. */
  declared?: { names: string[]; source_url?: string }
  contents_masses: ContentsMass[]
  versions_seen: VersionSeen[]
  /** What the reading found unreadable, in words — a contents mass whose figures contradict each other. */
  problems: string[]
}

/** The question the recipe leg gets: what to research, what is known, and whose business the rest is. */
export function recipeQuestion(brief: string, of: string, request: RecipeRequest, others: string[]): string {
  const known = (request.ingredients ?? []).map((i) => i.trim()).filter(Boolean)
  // The names as the coverage reads them, a "may contain" part behind one marker: the leg copies a name into
  // "inci", and "+/- MAY CONTAIN: CI 77891" would cover nothing.
  const inci = listNames(inciEntries(request.inci_list))
  const may = inci.filter((n) => n.may).map((n) => n.name)
  const printed =
    inci
      .filter((n) => !n.may)
      .map((n) => n.name)
      .join(', ') + (may.length ? ` [+/- ${may.join(', ')}]` : '')
  return (
    `${brief}\n\nResearch ONLY the recipe of ${of}: one formulation with every ingredient and its amount, as the ` +
    'JSON object.' +
    (known.length
      ? `\nIngredients known from the product (its printed list): ${known.join(', ')}. Give one its line only where ` +
        'your one formulation names it; one it lacks is reported from this list — never fill it in from elsewhere.'
      : '') +
    // The name as printed is what covers an entry of the list: "glycerol" finds no "Glycerin".
    (inci.length
      ? `\nTHIS product's INCI list, as printed: ${printed}. Give one its line only where your one ` +
        'formulation names it, and write its name as printed here in "inci" (a trade form\'s constituents too); one ' +
        'it lacks is reported from this list — never fill it in from elsewhere.'
      : '') +
    (request.mass_kg
      ? `\nThe mass of the mixture in the product is known (${request.mass_kg} kg); no need to research it.`
      : '') +
    (others.length
      ? `\nThe product's other parts are researched separately, by other researchers: ${others.map((o) => `"${o}"`).join(', ')}. Only the mixture is yours.`
      : '')
  )
}

const CLASSES = ['official', 'industry', 'media', 'community']
const CONFIDENCES = ['high', 'medium', 'low']
/** How far a stated mass may sit from stated volume × stated density before the two count as contradicting. */
const SAME_MASS = 0.02

const text = (v: unknown): string => (v == null ? '' : String(v).trim())
const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v))
const pos = (v: unknown): number | undefined => {
  const n = num(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const word = (v: unknown, allowed: string[]): string | undefined => {
  const w = text(v).toLowerCase()
  return allowed.includes(w) ? w : undefined
}
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [])
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const sourceOf = (r: Record<string, unknown>): string | undefined =>
  text(r.source_url) || text(r.source) || undefined

/**
 * The unit a line is printed in, read; undefined when it is not a mass basis. Volume first — "% v/v" is a percent
 * sign on a volume. A mass per volume batch ("kg/m3") is a mass per batch, its batch is the cubic metre.
 */
export function unitOf(raw: unknown): RecipeUnit | undefined {
  const u = text(raw).toLowerCase()
  if (!u || /v\s*\/\s*v|vol|\bml\b|\bl\b|litre|liter/.test(u.replace(/kg\s*(\/|per)\s*m\s*(3|³)/, '')))
    return undefined
  if (/%|percent|pct|w\s*\/\s*w|wt/.test(u)) return '%'
  if (/phr|part|pbw/.test(u)) return 'parts'
  if (/^kg\b|^kilogram/.test(u)) return 'kg'
  if (/^g\b|^gram/.test(u)) return 'g'
  return undefined
}

/** A usable range: 0 ≤ min < max, and around the printed amount when there is one. */
function rangeOf(raw: unknown, amount?: number): [number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined
  const lo = Number(raw[0])
  const hi = Number(raw[1])
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || lo >= hi) return undefined
  if (amount !== undefined && (amount < lo || amount > hi)) return undefined
  return [lo, hi]
}

function tradeFormOf(raw: unknown): TradeForm | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = record(raw)
  const constituents: TradeForm['constituents'] = []
  for (const c of listOf(r.constituents)) {
    const cr = record(c)
    const name = text(cr.name ?? cr.substance)
    const pct = pos(cr.pct ?? cr.percent ?? cr.share)
    const inci = text(cr.inci)
    if (name && pct !== undefined && pct <= 100) constituents.push({ name, pct, ...(inci ? { inci } : {}) })
  }
  const name = text(r.name)
  const source = sourceOf(r)
  return { ...(name ? { name } : {}), ...(source ? { source_url: source } : {}), constituents }
}

function lineOf(raw: unknown): RecipeLine | undefined {
  const r = record(raw)
  // The names a researcher used to the parts agent's format also write a line: `component`, `material`.
  const name = text(r.name ?? r.ingredient ?? r.component ?? r.material ?? r.substance)
  if (!name) return undefined
  const printed = text(r.unit)
  const unit = unitOf(printed)
  const amount = unit ? pos(r.amount ?? r.value) : undefined
  const range = unit ? rangeOf(r.range, amount) : undefined
  const trade = tradeFormOf(r.trade_form)
  const inci = text(r.inci)
  const recipe = text(r.other_recipe)
  const klass = word(r.source_class, CLASSES)
  const conf = word(r.confidence, CONFIDENCES)
  const notes = [
    !unit && printed ? `Printed as "${printed}", not a mass unit — no amount taken.` : '',
    text(r.note)
  ].filter(Boolean)
  return {
    name,
    ...(inci ? { inci } : {}),
    ...(amount !== undefined ? { amount } : {}),
    ...(unit ? { unit } : {}),
    ...(!unit && printed ? { unit_printed: printed } : {}),
    ...(range ? { range } : {}),
    ...(r.rest_to_total === true ? { rest_to_total: true } : {}),
    ...(trade ? { trade_form: trade } : {}),
    ...(recipe ? { recipe } : {}),
    ...(sourceOf(r) ? { source_url: sourceOf(r) } : {}),
    ...(klass ? { source_class: klass } : {}),
    ...(conf ? { confidence: conf } : {}),
    ...(notes.length ? { note: clipNote(notes.join(' '), 400).note } : {})
  }
}

function formulationOf(raw: unknown): Formulation | undefined {
  const r = record(raw)
  const name = text(r.name ?? r.title)
  const source = sourceOf(r)
  if (!name && !source) return undefined
  const total = record(r.total)
  const totalUnit = unitOf(total.unit)
  const totalAmount = pos(total.amount)
  const total_kg =
    totalAmount !== undefined && (totalUnit === 'kg' || totalUnit === 'g')
      ? totalUnit === 'g'
        ? totalAmount / 1000
        : totalAmount
      : undefined
  const kind = word(r.kind, ['product', 'frame']) as Formulation['kind'] | undefined
  const table = text(r.table)
  const version = text(r.version)
  const batch = text(r.batch)
  return {
    name: name || 'unnamed formulation',
    kind: kind ?? 'unknown',
    ...(source ? { source_url: source } : {}),
    ...(table ? { table } : {}),
    ...(version ? { version } : {}),
    ...(batch ? { batch } : {}),
    ...(total_kg !== undefined ? { total_kg } : {})
  }
}

/** The mixture's mass in this product, each figure as stated; a stated volume times a stated density counts. */
function contentsOf(raw: unknown, problems: string[]): ContentsMass[] {
  const out: ContentsMass[] = []
  for (const c of listOf(raw)) {
    const r = record(c)
    const stated = pos(r.mass_kg)
    const volume = pos(r.volume_l)
    const density = pos(r.density_kg_per_l)
    const product = volume !== undefined && density !== undefined ? volume * density : undefined
    if (stated !== undefined && product !== undefined && Math.abs(stated - product) > SAME_MASS * stated) {
      problems.push(
        `a contents mass of ${stated} kg contradicts its own ${volume} l × ${density} kg/l = ${Number(product.toFixed(6))} kg`
      )
      continue
    }
    const mass = stated ?? product
    if (mass === undefined) continue
    const version = text(r.version)
    const note = text(r.note)
    out.push({
      mass_kg: Number(mass.toFixed(6)),
      ...(volume !== undefined ? { volume_l: volume } : {}),
      ...(density !== undefined ? { density_kg_per_l: density } : {}),
      ...(version ? { version } : {}),
      ...(sourceOf(r) ? { source_url: sourceOf(r) } : {}),
      ...(note ? { note } : {})
    })
  }
  return out
}

function versionsOfAnswer(raw: unknown): VersionSeen[] {
  const out: VersionSeen[] = []
  for (const v of listOf(raw)) {
    const r = record(v)
    const version = text(r.version ?? r.name)
    if (!version) continue
    const differs = text(r.differs_by)
    const sold = text(r.sold_by)
    out.push({
      version,
      ...(differs ? { differs_by: differs } : {}),
      ...(sold ? { sold_by: sold } : {}),
      ...(sourceOf(r) ? { source_url: sourceOf(r) } : {})
    })
  }
  return out
}

/** Read the recipe leg's answer. A bare array is read as the lines of an unnamed formulation. */
export function parseRecipeAnswer(parsed: unknown): RecipeLeg {
  const obj = record(parsed)
  const rawLines = Array.isArray(parsed)
    ? parsed
    : listOf(obj.lines ?? obj.ingredients ?? obj.items ?? obj.components)
  const lines = rawLines.map(lineOf).filter((l): l is RecipeLine => !!l)
  const declaredRaw = record(obj.declared_ingredients)
  const declaredNames = (
    Array.isArray(obj.declared_ingredients) ? obj.declared_ingredients : listOf(declaredRaw.names)
  )
    .map(text)
    .filter(Boolean)
  const problems: string[] = []
  // An answer that names a formulation but yields no line says which keys it carried, so the trace shows its shape.
  if (!lines.length && Object.keys(obj).length)
    problems.push(`no recipe line could be read; the answer carried ${Object.keys(obj).join(', ')}`)
  const formulation = formulationOf(obj.formulation)
  return {
    ...(formulation ? { formulation } : {}),
    lines,
    ...(declaredNames.length
      ? {
          declared: {
            names: declaredNames,
            ...(sourceOf(declaredRaw) ? { source_url: sourceOf(declaredRaw) } : {})
          }
        }
      : {}),
    contents_masses: contentsOf(obj.contents_mass ?? obj.contents_masses, problems),
    versions_seen: versionsOfAnswer(obj.versions_seen ?? obj.versions),
    problems
  }
}
