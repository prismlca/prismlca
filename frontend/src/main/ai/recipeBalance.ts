/**
 * A mixture's own balance in a bill of materials: whether one recipe's lines close against a total its source
 * states, whether it covers the ingredients known from the product, whether it is this product's recipe at all —
 * three statements, none implied by another — and, given the mixture's mass, what each ingredient weighs. Pure,
 * like bomBalance.ts, so every verdict can be pinned on a recorded answer.
 *
 * No chosen and no generated number. Amounts stay as the source prints them; "closes" means the lines meet a
 * denominator the source states (100 for percent, a stated batch mass) — never one made by normalising, under which
 * every recipe closes. A rest goes on a line only when the recipe itself writes it so ("water ad 100"), once, and not
 * in a recipe pieced together from other sources. A trade form is split only into the constituents its datasheet
 * states, and then booked as those constituents, never besides them.
 */
import type { BomItem, VersionSeen } from './bomAnswer'
import type { RecipeLeg, RecipeLine, RecipeRequest, RecipeUnit, ContentsMass, Formulation } from './bomRecipe'
import { urlKey } from './citationBook'
import { versionsContradict } from './bomVersions'
import { inciEntries, listNames } from './inciList'

/** Closed within this share of the denominator: two percentage points on a percent recipe — the sources' rounding. */
const CLOSE_TOL = 0.02
/** Contents masses this close are one figure (rounding, 0.51 against 0.510). */
const SAME_CONTENTS = 0.01
/** A researched contents mass this far from the one passed is named beside it. */
const CONTENTS_APART = 0.15
/** Lines handed on per recipe — an INCI list runs to twenty or thirty. */
export const RECIPE_LINE_CAP = 30

/** One line of the recipe as dosed, with its share of the mixture where one can be worked out. */
export interface RecipeLineOut {
  name: string
  inci?: string
  amount?: number
  unit?: RecipeUnit
  range?: [number, number]
  /** Percent of the mixture, as dosed (a trade form as a whole). */
  share_pct?: number
  rest_to_total?: true
  /** On the rest line: the lines dosed without an amount whose mass sits inside the rest. */
  carries?: string[]
  trade_form?: {
    name: string
    /** True when the line is booked as its constituents rather than as the trade form. */
    split: boolean
    constituents?: Array<{ name: string; pct: number; share_pct?: number }>
    note?: string
  }
  /** The other recipe or source the line was taken from, when it is not the formulation's own. */
  other_source?: string
  source_url?: string
  note?: string
}

/** The `recipe` block of a research_bom result. */
export interface RecipeBlock {
  of: string
  formulation?: Omit<Formulation, 'total_kg'> & { total_kg?: number }
  /** How the source gives its amounts. */
  basis?: 'percent' | 'mass' | 'parts' | 'mixed'
  /** What the lines are closed against, in words ("100 %", "2400 kg, the stated total of 1 m3"). */
  denominator?: string
  /** `denominator`: shares of the stated total; `sum_of_lines`: of the lines' own sum, since the source states none. */
  shares_from?: 'denominator' | 'sum_of_lines'
  lines: RecipeLineOut[]
  /** true: the lines meet the denominator within two points; false: they miss or exceed it; null: not checkable. */
  closes: boolean | null
  closes_note: string
  /** Denominator minus the lines, in percent of the denominator; positive = unaccounted, negative = over. */
  gap_pct?: number
  gap_kg?: number
  /** Whether the researched ranges can reach the denominator — beside the closure, never instead of it. */
  reachable_by_ranges?: boolean
  /** Ingredients known from the product (its declared list, the caller) that the recipe does not name. */
  missing_ingredients?: string[]
  declared_source?: string
  /** The mixture's mass the shares were scaled to. */
  mass_kg?: number
  mass_source?: 'given' | 'researched'
  contents_found?: ContentsMass[]
  /** Trade forms booked as their constituents. */
  split?: string[]
}

export interface RecipeWeighing {
  block: RecipeBlock
  /** The ingredients in kg, `group: "recipe"`, on the booking basis — empty without a mass. */
  items: BomItem[]
  /** Why the mixture keeps the whole product's verdict from being given; absent when it closes. */
  lock?: string
  /** The summary's sentence about the mixture. */
  sentence: string
  /** The product version the recipe belongs to, when it is the product's own. */
  version?: string
  /** The product version of the researched contents mass the shares were scaled to. */
  contents_version?: string
  versions_seen: VersionSeen[]
  notes: string[]
  /** Shares could be worked out — kg need only a mass. */
  has_shares: boolean
}

const r6 = (n: number): number => Number(n.toFixed(6))
const r2 = (n: number): number => Number(n.toFixed(2))
/** A share in percent: four significant digits, so a dye at 0.002 % does not read as 0 %. */
const pct = (n: number): number => Number(n.toPrecision(4))
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const host = (url?: string): string | undefined => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : undefined
  } catch {
    return undefined
  }
}
/** One name for one thing: spelling, case and punctuation aside. "MP-01 variant B" is not "MP-01". */
const sameName = (a: string, b: string): boolean => !!norm(a) && norm(a) === norm(b)
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/**
 * The ingredients INCI names in two nomenclatures — "Aqua", "Parfum" and "Aroma" in the EU for what is elsewhere
 * "Water", "Fragrance" and "Flavor", "Eau" on a French label: one ingredient under any of its names.
 */
const BOTH_NOMENCLATURES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['aqua', 'water', 'eau']),
  new Set(['parfum', 'fragrance']),
  new Set(['aroma', 'flavor', 'flavour'])
]
/**
 * A bracket that ends a name, before the punctuation the list may close with ("Titanium Dioxide (CI 77891).", an
 * asterisk for organic): closed, or left open where the list was split at the commas inside it ("Chocolate (sugar,
 * cocoa mass)" is read as "Chocolate (sugar" and "cocoa mass)").
 */
const LAST_BRACKET = /^(.*[\p{L}\p{N}])\s*[([]([^()[\]]*)([)\]])?[^\p{L}\p{N}()[\]]*$/u

/** One printed name as the coverage reads it: what it is called as a whole, and every name it stands for. */
interface PrintedName {
  whole: string[]
  all: string[]
}

/**
 * The names one printed name stands for, spelling aside. A name is read whole: a slash or a bracket inside it is part
 * of it — "Dimethicone/Vinyl Dimethicone Crosspolymer" is not "Dimethicone", "Butyrospermum Parkii (Shea) Butter" is
 * not "Shea". Two exceptions name one ingredient twice: the names of both nomenclatures together ("Aqua/Water/Eau",
 * "Parfum (Fragrance)"), and a closed bracket that ends the name, which may hold a second name for it ("Titanium
 * Dioxide (CI 77891)"). A bracket left open began a list of what the entry is made of: the name before it stands for
 * the entry, the sugar of a chocolate does not.
 */
function namesOf(printed: string): PrintedName {
  const name = norm(printed)
  if (!name) return { whole: [], all: [] }
  const parts = printed
    .split(/[/()[\]]/)
    .map(norm)
    .filter(Boolean)
  const both = BOTH_NOMENCLATURES.findIndex((names) => parts.every((p) => names.has(p)))
  // norm() leaves no "#", so this key is no printed name.
  if (both >= 0) return { whole: [name, `#${both}`], all: [name, `#${both}`] }
  const last = LAST_BRACKET.exec(printed)
  const further = last ? [last[1], ...(last[3] ? [last[2]] : [])].flatMap((p) => namesOf(p).all) : []
  return { whole: [name], all: [name, ...further] }
}

/** Known ingredients the recipe does not name — by its lines, their INCI names and their trade forms' constituents. */
function missingIngredients(known: string[], lines: RecipeLine[]): string[] {
  const read = lines
    .flatMap((l) => [
      l.name,
      l.inci ?? '',
      l.trade_form?.name ?? '',
      ...(l.trade_form?.constituents ?? []).flatMap((c) => [c.name, c.inci ?? ''])
    ])
    .map(namesOf)
  const wholes = new Set(read.flatMap((n) => n.whole))
  const all = new Set(read.flatMap((n) => n.all))
  // Whole names only: "Betaine" is not "Cocamidopropyl Betaine", nor "Alcohol" "Benzyl Alcohol". A name the recipe
  // spells otherwise is reported missing — the leg is asked to write the printed name in "inci". Two names are one
  // when one of them, read whole, is a name of the other: "Titanium Dioxide (CI 77891)" is "CI 77891", but "CI 77491
  // (Iron Oxides)" is not "CI 77492 (Iron Oxides)", nor "Shea Butter (organic)" "Cocoa Butter (organic)".
  const covered = (k: string): boolean => {
    const n = namesOf(k)
    return n.all.some((x) => wholes.has(x)) || n.whole.some((x) => all.has(x))
  }
  return known.filter((k) => !covered(k))
}

/** The mixture's mass from the contents masses found: only when every figure agrees and no two versions contradict. */
function agreedContents(found: ContentsMass[]): number | undefined {
  if (!found.length) return undefined
  const one = found.every((p, i) =>
    found
      .slice(i + 1)
      .every(
        (q) =>
          Math.abs(p.mass_kg - q.mass_kg) <= SAME_CONTENTS * Math.max(p.mass_kg, q.mass_kg) &&
          !(p.version && q.version && versionsContradict(p.version, q.version))
      )
  )
  return one ? found[0].mass_kg : undefined
}

/** A trade form's constituents are a split only when the datasheet's percentages add up to 100. */
const splitOf = (l: RecipeLine): boolean => {
  const c = l.trade_form?.constituents ?? []
  return c.length > 0 && Math.abs(c.reduce((s, x) => s + x.pct, 0) - 100) <= CLOSE_TOL * 100
}

/**
 * Weigh one recipe leg's answer. `canonical` turns a provider's link into the page it stands for, so two lines that
 * cite one page through two links count as one source.
 */
export function weighRecipe(
  leg: RecipeLeg | undefined,
  opts: { of: string; request: RecipeRequest; canonical?: (url: string) => string; error?: string }
): RecipeWeighing {
  const of = opts.of
  const passed = opts.request.mass_kg
  const given = typeof passed === 'number' && Number.isFinite(passed) && passed > 0 ? passed : undefined
  if (!leg || !leg.lines.length) {
    const why = opts.error ?? leg?.problems[0] ?? 'the research came back without recipe lines'
    return {
      block: {
        of,
        lines: [],
        closes: null,
        closes_note: why,
        ...(given ? { mass_kg: given, mass_source: 'given' as const } : {})
      },
      items: [],
      lock: `no recipe came back for ${of} (${why})`,
      sentence: `No recipe of ${of} came back (${why}).`,
      versions_seen: leg?.versions_seen ?? [],
      notes: [],
      has_shares: false
    }
  }
  const notes = leg.problems.map((p) => `Recipe: ${p}.`)
  const f = leg.formulation
  const lines = leg.lines
  const canonical = opts.canonical ?? ((u: string) => u)
  const key = (u?: string): string => (u ? urlKey(canonical(u)) : '')
  // The formulation's page, or — when the leg named none — the page most of its lines cite.
  const counts = new Map<string, number>()
  for (const l of lines)
    if (l.source_url) counts.set(key(l.source_url), (counts.get(key(l.source_url)) ?? 0) + 1)
  const home = key(f?.source_url) || [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  // An "other recipe" counts as a second source unless it IS the formulation. A remark written into that field
  // ("Aqua ad 100 (solvent, phase A)", seen on a live run) therefore reads as one too — the safe side: it costs the
  // rest, it never makes one.
  const foreignOf = (l: RecipeLine): string | undefined =>
    l.recipe && !(f && sameName(l.recipe, f.name))
      ? l.recipe
      : l.source_url && home && key(l.source_url) !== home
        ? (host(canonical(l.source_url)) ?? l.source_url)
        : undefined
  const foreign = lines.map(foreignOf)
  const foreignNames = lines
    .filter((_, i) => foreign[i])
    .map((l, i) => `${l.name} (${foreign.filter(Boolean)[i]})`)

  // The basis the amounts are printed on. Lines in g and kg are one basis; percent beside a mass is not.
  const units = new Set(lines.map((l) => l.unit).filter((u): u is RecipeUnit => !!u))
  const kinds = new Set(
    [...units].map((u) => (u === 'g' || u === 'kg' ? 'mass' : u === '%' ? 'percent' : 'parts'))
  )
  const basis: RecipeBlock['basis'] =
    kinds.size > 1 ? 'mixed' : (([...kinds][0] as RecipeBlock['basis']) ?? undefined)
  const inBasis = (l: RecipeLine, x: number): number => (l.unit === 'g' ? x / 1000 : x)
  const den = basis === 'percent' ? 100 : basis === 'mass' ? f?.total_kg : undefined
  const unitWord = basis === 'mass' ? 'kg' : basis === 'percent' ? '%' : 'parts'
  const denWords =
    basis === 'percent'
      ? '100 %'
      : den !== undefined
        ? `${den} kg, the stated total of ${f?.batch || 'its batch'}`
        : ''

  // The rest line: taken only where the recipe writes it, once, in a recipe of one source, with every other line known.
  const rests = lines.filter((l) => l.rest_to_total)
  // A line the recipe doses with no amount at all ("citric acid q.s. ad pH 5") is taken from the rest, as the
  // formulator takes it: the rest carries it, named. A line with only a range is no such line — its share is real
  // and unknown, and a rest worked out beside it would be one chosen number.
  let carried: RecipeLine[] = []
  let rest: { line: RecipeLine; amount: number } | undefined
  let restProblem = ''
  let restOvershoot = false
  if (rests.length > 1)
    restProblem = `${rests.length} lines are each written as the rest (${rests.map((l) => l.name).join(', ')}) — none is taken`
  else if (rests.length === 1) {
    const r = rests[0]
    const others = lines.filter((l) => l !== r)
    if (den === undefined)
      restProblem = `"${r.name}" is written as the rest, but the recipe states no total for it to fill`
    else if (foreignNames.length)
      restProblem = `"${r.name}" is written as the rest, but lines from other sources are mixed in — the rest of a pieced-together recipe is no figure`
    else if (others.some((l) => (l.amount === undefined || !l.unit) && (l.range || l.unit_printed)))
      restProblem = `"${r.name}" is written as the rest, but other lines give only a range or no mass, so it cannot be worked out`
    else {
      const dosed = others.filter((l) => l.amount !== undefined && l.unit)
      const used = dosed.reduce((s, l) => s + inBasis(l, l.amount as number), 0)
      if (den - used <= 0) {
        restOvershoot = true
        restProblem = `the lines besides the rest "${r.name}" already reach ${r6(used)} of ${denWords}`
      } else {
        rest = { line: r, amount: r6(den - used) }
        carried = others.filter((l) => !dosed.includes(l))
      }
    }
  }

  // Points on the basis: the rest where it was taken, else the printed amount.
  const pts = lines.map((l) =>
    rest?.line === l ? rest.amount : l.amount !== undefined && l.unit ? inBasis(l, l.amount) : undefined
  )
  const sum = r6(pts.reduce((s: number, p) => s + (p ?? 0), 0))
  const open = lines.filter((l, i) => pts[i] === undefined && !carried.includes(l))
  const gap = den !== undefined ? den - sum : undefined
  let closes: boolean | null
  let why: string
  if (basis === 'mixed') {
    closes = null
    why = `its lines mix bases (${[...units].join(', ')}), so they cannot be added up`
  } else if (!basis) {
    closes = null
    why = 'no line has an amount in a mass unit'
  } else if (den === undefined) {
    closes = null
    why =
      basis === 'parts'
        ? 'parts by weight have no total of their own'
        : 'the source states no total mass for its batch (a fresh density, a yield)'
  } else if (restOvershoot || sum > den * (1 + CLOSE_TOL)) {
    closes = false
    why = restOvershoot
      ? restProblem
      : `its lines sum to ${r6(sum)} ${unitWord}, over ${denWords} by ${r2(((sum - den) / den) * 100)} %`
  } else if (open.length && !(open.every((l) => l.unit_printed) && Math.abs(den - sum) <= CLOSE_TOL * den)) {
    // Lines printed in a volume (the air voids of a concrete) carry no mass here. Where the mass lines alone meet the
    // total they are named and left out; where they fall short, a volume line may be the missing mass.
    closes = null
    why = `${plural(open.length, 'line has', 'lines have')} no amount (${open.map((l) => l.name).join(', ')})`
  } else {
    closes = Math.abs(den - sum) <= CLOSE_TOL * den
    why = closes
      ? `its lines sum to ${r6(sum)} ${unitWord} of ${denWords}${rest ? `, with "${rest.line.name}" as the rest the recipe writes` : ''}` +
        (carried.length
          ? ` — the rest includes ${carried.map((l) => l.name).join(', ')}, dosed without an amount`
          : '') +
        (open.length ? `; not counted, printed in a volume: ${open.map((l) => l.name).join(', ')}` : '')
      : `its lines sum to ${r6(sum)} ${unitWord} of ${denWords}`
  }
  if (restProblem && !restOvershoot) why += `; ${restProblem}`

  // Ranges reaching the denominator are a statement of their own, beside the closure.
  let reachable: boolean | undefined
  if (den !== undefined && lines.some((l) => l.range)) {
    const lo = lines.reduce((s, l, i) => s + (l.range ? inBasis(l, l.range[0]) : (pts[i] ?? 0)), 0)
    const hi = lines.reduce((s, l, i) => s + (l.range ? inBasis(l, l.range[1]) : (pts[i] ?? Infinity)), 0)
    reachable = lo <= den * (1 + CLOSE_TOL) && hi >= den * (1 - CLOSE_TOL)
  }

  // Shares of the mixture: of the stated total; of the lines' own sum only where the source states none and every
  // line has an amount (parts by weight are defined that way) — never over lines that are missing their amount.
  const sharesFrom: RecipeBlock['shares_from'] =
    den !== undefined && basis !== 'mixed'
      ? 'denominator'
      : (basis === 'mass' || basis === 'parts') && !open.length && sum > 0
        ? 'sum_of_lines'
        : undefined
  const divisor = sharesFrom === 'denominator' ? (den as number) : sum
  const share = (i: number): number | undefined =>
    sharesFrom && pts[i] !== undefined ? (pts[i] as number) / divisor : undefined

  // The mixture's mass: the one passed, or the contents masses found when they agree.
  // A contents mass printed on the page of a frame formulation is that product's fill, not this one's: measured on a
  // live run, a 1-litre comparable scaled a 500 ml pouch's soap to 1 kg.
  const formulationPage = key(f?.source_url)
  const foreignFill = (c: ContentsMass): boolean =>
    f?.kind !== 'product' && !!formulationPage && !!c.source_url && key(c.source_url) === formulationPage
  const skipped = leg.contents_masses.filter(foreignFill)
  if (skipped.length)
    notes.push(
      `A contents mass of ${skipped.map((c) => `${c.mass_kg} kg`).join(', ')} came from the page of the frame ` +
        "formulation — that product's fill, not this one's; not used."
    )
  const found = leg.contents_masses.filter((c) => !foreignFill(c))
  const agreed = agreedContents(found)
  const massKg = given ?? agreed
  if (given && found.some((c) => Math.abs(c.mass_kg - given) / given > CONTENTS_APART))
    notes.push(
      `The research found ${found.map((c) => `${c.mass_kg} kg`).join(', ')} for the mixture in the product, against ` +
        `the ${given} kg you passed for recipe.mass_kg — check which is right.`
    )
  if (!given && found.length && agreed === undefined)
    notes.push(
      `The contents masses found disagree (${found.map((c) => `${c.mass_kg} kg${c.version ? `, ${c.version}` : ''}`).join('; ')}) — ` +
        'none was used; settle which one is the product and pass it as recipe.mass_kg.'
    )

  const lineSource = (l: RecipeLine): string | undefined => l.source_url ?? f?.source_url
  const items: BomItem[] = []
  const split: string[] = []
  const out: RecipeLineOut[] = lines.slice(0, RECIPE_LINE_CAP).map((l, i) => {
    const s = share(i)
    const tf = l.trade_form
    const isSplit = splitOf(l)
    const tfName = tf?.name || l.name
    if (isSplit) split.push(tfName)
    const tfNote = !tf
      ? undefined
      : !tf.constituents.length
        ? 'composition of the trade form not stated — booked as dosed'
        : !isSplit
          ? `its datasheet's constituents add up to ${r2(tf.constituents.reduce((t, c) => t + c.pct, 0))} %, not 100 — booked as dosed`
          : undefined
    const printedRest =
      rest?.line === l && l.amount !== undefined && l.unit ? inBasis(l, l.amount) : undefined
    const restNote =
      printedRest !== undefined && den !== undefined && Math.abs(printedRest - rest!.amount) > CLOSE_TOL * den
        ? `printed as ${l.amount} ${l.unit}; the rest of the other lines is ${rest!.amount} ${unitWord}`
        : undefined
    const note = [restNote, l.note].filter(Boolean).join(' ') || undefined
    if (massKg && s !== undefined) {
      const base = {
        group: 'recipe' as const,
        ...(l.source_class ? { source_class: l.source_class } : {}),
        ...(l.confidence ? { confidence: l.confidence } : {})
      }
      if (isSplit && tf)
        for (const c of tf.constituents)
          items.push({
            component: c.name,
            material: '',
            mass_kg: r6(s * (c.pct / 100) * massKg),
            share_pct: pct(s * c.pct),
            from_trade_form: tfName,
            source_url: tf.source_url ?? lineSource(l),
            ...base
          })
      else {
        const range =
          l.range && l.amount !== undefined && sharesFrom
            ? ([
                r6((inBasis(l, l.range[0]) / divisor) * massKg),
                r6((inBasis(l, l.range[1]) / divisor) * massKg)
              ] as [number, number])
            : undefined
        // The rest carries the lines dosed without an amount: its mass is theirs too, and it is booked as what it is.
        const carries = rest?.line === l && carried.length ? carried.map((c) => c.name) : []
        items.push({
          component: carries.length ? [l.name, ...carries].join(' + ') : l.name,
          material: l.inci ?? '',
          mass_kg: r6(s * massKg),
          share_pct: pct(s * 100),
          ...(range ? { mass_range_kg: range } : {}),
          source_url: lineSource(l),
          ...base,
          ...(note || tfNote ? { note: [tfNote, note].filter(Boolean).join('; ') } : {})
        })
      }
    }
    return {
      name: l.name,
      ...(l.inci ? { inci: l.inci } : {}),
      ...(rest?.line === l
        ? { amount: rest.amount, unit: (basis === 'mass' ? 'kg' : '%') as RecipeUnit }
        : {}),
      ...(rest?.line !== l && l.amount !== undefined ? { amount: l.amount } : {}),
      ...(rest?.line !== l && l.unit ? { unit: l.unit } : {}),
      ...(l.range ? { range: l.range } : {}),
      ...(s !== undefined ? { share_pct: pct(s * 100) } : {}),
      ...(l.rest_to_total ? { rest_to_total: true as const } : {}),
      ...(rest?.line === l && carried.length ? { carries: carried.map((c) => c.name) } : {}),
      ...(tf
        ? {
            trade_form: {
              name: tfName,
              split: isSplit,
              ...(tf.constituents.length
                ? {
                    constituents: tf.constituents.map((c) => ({
                      ...c,
                      ...(s !== undefined && isSplit ? { share_pct: pct(s * c.pct) } : {})
                    }))
                  }
                : {}),
              ...(tfNote ? { note: tfNote } : {})
            }
          }
        : {}),
      ...(foreign[i] ? { other_source: foreign[i] } : {}),
      ...(l.source_url ? { source_url: l.source_url } : {}),
      ...(note ? { note } : {})
    }
  })
  const cut = Math.max(0, lines.length - RECIPE_LINE_CAP)

  // The INCI list the caller passed takes the place of any list the leg found: a list of another version of the
  // product would make its extra ingredients "known from the product".
  const passedInci = inciEntries(opts.request.inci_list)
  const declared = passedInci.length ? undefined : leg.declared
  // What a "may contain" part names, a shade of the range need not contain: no recipe lacks it.
  const contents = (list: readonly string[]): string[] =>
    listNames(list)
      .filter((n) => !n.may)
      .map((n) => n.name)
  const known = [
    ...new Set([
      ...inciEntries(opts.request.ingredients),
      ...contents(passedInci),
      ...contents(declared?.names ?? [])
    ])
  ]
  const missing = missingIngredients(known, lines)

  // No gap where the closure could not be checked: beside lines without an amount it is their share, not a gap.
  const gapPct = gap !== undefined && closes !== null ? r2((gap / (den as number)) * 100) : undefined
  const gapKg =
    gap !== undefined && gapPct !== undefined && massKg ? r6((gap / (den as number)) * massKg) : undefined

  const block: RecipeBlock = {
    of,
    ...(f ? { formulation: f } : {}),
    ...(basis ? { basis } : {}),
    ...(denWords ? { denominator: denWords } : {}),
    ...(sharesFrom ? { shares_from: sharesFrom } : {}),
    lines: out,
    closes,
    closes_note: why,
    ...(gapPct !== undefined ? { gap_pct: gapPct } : {}),
    ...(gapKg !== undefined ? { gap_kg: gapKg } : {}),
    ...(reachable !== undefined ? { reachable_by_ranges: reachable } : {}),
    ...(missing.length ? { missing_ingredients: missing } : {}),
    ...(declared?.source_url ? { declared_source: declared.source_url } : {}),
    ...(massKg ? { mass_kg: massKg, mass_source: given ? ('given' as const) : ('researched' as const) } : {}),
    ...(found.length ? { contents_found: found } : {}),
    ...(split.length ? { split } : {})
  }
  if (cut)
    notes.push(
      `The recipe listed ${cut} further lines beyond the ${RECIPE_LINE_CAP} handed on; they are counted in its closure.`
    )

  const kindWords =
    f?.kind === 'frame'
      ? "a frame formulation, not this product's own"
      : f?.kind === 'product'
        ? ''
        : "not said whether it is this product's own"
  const subject = `The recipe of ${of}, ${f ? `"${f.name}"` : 'an unnamed formulation'}${kindWords ? ` (${kindWords})` : ''},`
  const gapWords =
    gapPct !== undefined
      ? `${Math.abs(gapPct)} %${gapKg !== undefined ? ` (${Math.abs(gapKg)} kg)` : ''} ${gapPct >= 0 ? 'unaccounted' : 'over'}`
      : ''
  const head =
    closes === true
      ? `${subject} closes: ${why}${gapPct ? `; ${gapWords}, within the two-point rounding` : ''}.`
      : closes === false
        ? `${subject} does NOT close: ${restOvershoot ? why : gapWords}.`
        : `${subject} could not be checked for closure: ${why}.`
  const sentence = [
    head,
    reachable !== undefined
      ? reachable
        ? 'Its ranges can reach the total.'
        : 'Even its ranges cannot reach the total.'
      : '',
    foreignNames.length ? `Lines from other sources: ${foreignNames.join(', ')}.` : '',
    missing.length ? `Known from the product but not in it: ${missing.join(', ')}.` : '',
    massKg
      ? `Scaled to ${massKg} kg (${given ? 'the recipe.mass_kg you passed' : 'the contents mass the research found'}).`
      : sharesFrom
        ? 'Shares only, no kg: pass recipe.mass_kg, the mass of the mixture in the product.'
        : ''
  ]
    .filter(Boolean)
    .join(' ')
  const lockWords = [
    closes === true
      ? ''
      : closes === false
        ? `the recipe of ${of} does not close: ${restOvershoot ? why : gapWords}`
        : `the recipe of ${of} could not be checked for closure (${why})`,
    // Lines beyond the cap have no entry to book, so the kilograms handed on fall short of the mixture's mass.
    cut ? `the recipe of ${of} lists ${cut} further lines beyond the ${RECIPE_LINE_CAP} handed on` : ''
  ]
    .filter(Boolean)
    .join('; ')
  return {
    block,
    items,
    ...(lockWords ? { lock: lockWords } : {}),
    sentence,
    ...(f?.kind === 'product' && f.version ? { version: f.version } : {}),
    // The contents mass the shares were scaled to belongs to a version of the product too.
    ...(!given && agreed !== undefined && found.find((c) => c.version)?.version
      ? { contents_version: found.find((c) => c.version)!.version }
      : {}),
    versions_seen: leg.versions_seen,
    notes,
    has_shares: !!sharesFrom
  }
}
