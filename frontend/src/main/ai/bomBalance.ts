/**
 * The bill-of-materials verdict: whether the parts the research legs found add up, against which total, and
 * what keeps the check from being made. Pure — no provider, no clock — so every verdict the parent reads can be
 * pinned by a test on a recorded answer.
 *
 * The rule throughout: make uncertainty visible, never resolve it by picking a number. Nothing here removes a
 * mass, chooses between two totals or hands a residual to a part. What cannot be judged is named — by component,
 * by total, by version — and the verdict stays null until the caller has settled it.
 */
import type { BomItem, BomLeg, ProductMass, UnresolvedComponent, VersionSeen } from './bomAnswer'
import { alternativesNote, onePerName, sameNameEntries, severalEntries } from './bomEntries'
import { heavierThanWhole, massWords, researchedTotal, totalsOf, type TotalUsed } from './bomTotals'
import { versionsOf, type Versions } from './bomVersions'
import type { RecipeBlock, RecipeWeighing } from './recipeBalance'

/** How one requested component came back. */
export type RequestStatus = 'with_mass' | 'partial' | 'no_mass' | 'product_mass_only' | 'failed'

/** One research leg, settled: its answer after retries and the follow-up pass, or why it failed. */
export interface LegOutcome {
  /** The component asked for; null for the leg that enumerates the components itself. */
  request: string | null
  leg?: BomLeg
  error?: string
  /** A part the caller already had a mass for (bomKnownParts.ts): weighed like a researched one, but not a request —
   *  it was never researched, so it counts in no coverage and has no status of its own. */
  known?: true
}

export interface Overlap {
  entry: string
  includes: string[]
}

export interface BomWeighing {
  summary: string
  requests?: Array<{ component: string; status: RequestStatus }>
  coverage:
    | { requested: number; with_mass: number; known?: number }
    | { listed: number; with_mass: number; known?: number }
  items: BomItem[]
  unresolved: UnresolvedComponent[]
  totals_found?: ProductMass[]
  total_used?: TotalUsed
  sum_kg: number
  /** Sales packaging: what a gross article weight contains on top of the parts. */
  packaging_kg?: number
  /** Transport packaging (shipping cartons, pallets): in no weight of the product, so in no comparison. */
  transport_packaging_kg?: number
  sum_range_kg?: [number, number]
  balance_ok: boolean | null
  residual_kg?: number
  residual_if_total_includes_packaging_kg?: number
  overlaps?: Overlap[]
  versions?: Versions
  /** The mixture's own check, when a recipe was researched (recipeBalance.ts). */
  recipe?: RecipeBlock
  note?: string
}

/** Default tolerance of the balance verdict. Coarse on purpose — and the residual goes out with it. */
const TOLERANCE = 0.15
/** A part this close to a whole-product mass is suspected of being that mass. */
const WHOLE_SHARE = 0.98
/** Parts this much heavier than the total are named first even when the verdict is locked for other reasons. */
const OVERSHOOT = 0.05
/** A part this close to a whole-product weight a leg reported is that weight, returned in the wrong place. */
const SAME_FIGURE = 0.005

const r6 = (n: number): number => Number(n.toFixed(6))
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
/** "frame (no mass found)" — the words a reason is named by in notes. */
const REASON_WORDS: Record<UnresolvedComponent['reason'], string> = {
  no_mass: 'no mass found',
  zero_mass: 'written as 0',
  unclear_mass: 'mass unclear',
  whole_product_only: "only the whole product's mass found",
  failed: 'research failed'
}

export interface BalanceInput {
  /** Entries with a mass, packaging included (flagged). */
  items: BomItem[]
  total?: TotalUsed
  /** Components without a usable mass, named with the reason ("frame (no mass found)"). */
  open: string[]
  /** Everything else that keeps a verdict from being given, as sentences. */
  locks: string[]
  /** Overlapping entries are listed: the sum may count a part twice, so a residual is not missing mass. */
  overlapping?: boolean
  /** The mixture's mass, when a recipe was scaled to one: it enters the sum as one block in place of its
   *  ingredients (`group: "recipe"`), whose own gap the recipe's closure reports. */
  mixtureKg?: number
  tolerance?: number
}

const totalWords = (t: TotalUsed): string =>
  t.source === 'given'
    ? `the total you passed (${t.mass_kg} kg)`
    : `the researched whole-product mass ${massWords(t)}`

/**
 * Whether the parts add up to the total.
 *
 * `balance_ok: null` means "could not be checked", and that is the answer whenever anything is open — a
 * component without a mass, a leg that never came back, overlapping entries, figures on different versions, a
 * total whose scope is unknown — not just when no total exists. This is the fix for the most expensive
 * finding of an early live run: two of six research legs had died, the four survivors summed to 25.7 of
 * 30 kg, and because 14.3 % happened to fall inside the tolerance the result said `balance_ok: true` in the
 * same object that said "2 of 6 research legs failed". The model read the seal and made the missing 4.3 kg
 * the residual mass of the PVC profile — 3.95 kg where association EPDs say 6–9. A check that reports
 * "passed" on an incomplete list is worse than no check, because it invites exactly that.
 *
 * `residual_kg` is stated whenever a total exists: a signed number is what the caller needs to decide whether
 * to look for a missing part or to distrust the total, and deriving it from `sum_kg` and the total is the kind
 * of arithmetic the tool should not leave to a language model.
 */
export function massBalance(
  input: BalanceInput
): Pick<
  BomWeighing,
  | 'sum_kg'
  | 'packaging_kg'
  | 'transport_packaging_kg'
  | 'sum_range_kg'
  | 'balance_ok'
  | 'residual_kg'
  | 'residual_if_total_includes_packaging_kg'
  | 'note'
> {
  const tolerance = input.tolerance ?? TOLERANCE
  const parts = input.items.filter((i) => !i.packaging && i.group !== 'recipe')
  const pack = input.items.filter((i) => i.packaging === 'sales')
  const mixture = input.mixtureKg ?? 0
  const sum = r6(parts.reduce((s, i) => s + i.mass_kg, 0) + mixture)
  const packaging = r6(pack.reduce((s, i) => s + i.mass_kg, 0))
  const transport = r6(
    input.items.filter((i) => i.packaging === 'transport').reduce((s, i) => s + i.mass_kg, 0)
  )
  // Items with a researched range contribute [min, max]; the rest their point value.
  const span: [number, number] | undefined = parts.some((i) => i.mass_range_kg)
    ? [
        r6(parts.reduce((s, i) => s + (i.mass_range_kg?.[0] ?? i.mass_kg), 0) + mixture),
        r6(parts.reduce((s, i) => s + (i.mass_range_kg?.[1] ?? i.mass_kg), 0) + mixture)
      ]
    : undefined
  const base = {
    sum_kg: sum,
    ...(packaging ? { packaging_kg: packaging } : {}),
    ...(transport ? { transport_packaging_kg: transport } : {}),
    ...(span ? { sum_range_kg: span } : {})
  }
  const openWords = input.open.length ? `no usable mass for ${input.open.join(', ')}` : ''
  const t = input.total
  if (!t) {
    const why = [openWords, ...input.locks].filter(Boolean)
    return {
      ...base,
      balance_ok: null,
      note:
        'No total mass is known — none was passed and the research found none it could use — so the balance ' +
        `could not be checked.${why.length ? ` Also open: ${why.join('; ')}.` : ''}`
    }
  }
  // A net total is compared with the parts, a gross one with parts and packaging. A total of unknown scope
  // cannot be compared with either: both readings go out, the verdict does not.
  const compared = t.basis === 'gross' ? sum + packaging : sum
  const residual_kg = r6(t.mass_kg - compared)
  const unknownScope = t.basis === 'unknown' && t.source === 'researched'
  const ifPacked =
    unknownScope && packaging ? { residual_if_total_includes_packaging_kg: r6(residual_kg - packaging) } : {}
  const locks = [
    ...(openWords ? [openWords] : []),
    ...input.locks,
    ...(unknownScope
      ? [
          'the source does not say whether the total includes packaging' +
            (packaging ? ` (if it does, the residual is ${r6(residual_kg - packaging)} kg)` : '')
        ]
      : [])
  ]
  if (locks.length) {
    const meaning = input.overlapping
      ? `The ${residual_kg} kg between ${totalWords(t)} and the parts is not missing mass as it stands: the sum ` +
        'may count a part twice (see overlaps).'
      : input.open.length
        ? `${residual_kg} kg of ${totalWords(t)} is not covered by the parts found — that is what the open ` +
          'components weigh together, plus anything not listed; it is unaccounted mass, not a tolerance. Find ' +
          'them or ask the user, and do NOT hand the remainder to one part as its mass.'
        : `Residual against ${totalWords(t)}: ${residual_kg} kg — not judged until the above is settled.`
    // Parts already heavier than the total is the one finding no lock can soften: something is counted twice
    // or a figure is too high — said first, before the list of what else is open.
    const over =
      residual_kg < -OVERSHOOT * t.mass_kg
        ? `The parts already EXCEED ${totalWords(t)} by ${r6(-residual_kg)} kg ` +
          `(${Math.round((-residual_kg / t.mass_kg) * 100)} %): an entry is counted twice or a figure is too high — ` +
          'look for two entries of one part before anything else. '
        : ''
    return {
      ...base,
      balance_ok: null,
      residual_kg,
      ...ifPacked,
      note: `${over}Balance NOT checked: ${locks.join('; ')}. ${meaning}`
    }
  }
  const off = Math.abs(compared - t.mass_kg) / t.mass_kg
  const packed =
    t.basis === 'gross' && packaging ? ' (sales packaging included, as the total is a gross weight)' : ''
  if (off > tolerance) {
    // With ranges on record the verdict can say which of the two repairs applies: masses placed
    // differently inside their researched spans, or a genuinely missing component / wrong total.
    const reach = span
      ? t.mass_kg - (compared - sum) >= span[0] && t.mass_kg - (compared - sum) <= span[1]
        ? ` The researched ranges DO reach the total (parts span ${span[0]}–${span[1]} kg) — place the masses inside their ranges before doubting the total.`
        : ` Even the researched ranges cannot reach it (parts span ${span[0]}–${span[1]} kg) — a component is missing or the total is wrong.`
      : ''
    return {
      ...base,
      balance_ok: false,
      residual_kg,
      note: `Components sum to ${r6(compared)} kg${packed} but ${totalWords(t)} is ${t.mass_kg} kg (${Math.round(off * 100)}% off) — check the figures before modelling them.${reach}`
    }
  }
  // Inside the tolerance, so the verdict stands — but the tolerance is 15 %, and on a 30 kg product that is up
  // to 4.5 kg of unnamed mass. The number goes out with the verdict, and the sentence names both readings.
  const share = Math.abs(residual_kg) / t.mass_kg
  const target = t.mass_kg - (compared - sum)
  const spanMiss =
    span && (target < span[0] || target > span[1])
      ? ` Even the researched ranges do not reach it exactly (parts span ${span[0]}–${span[1]} kg).`
      : ''
  return {
    ...base,
    balance_ok: true,
    residual_kg,
    note:
      share >= 0.05 || spanMiss
        ? `Within tolerance, but ${residual_kg} kg of ${totalWords(t)} is not covered by any listed component — ` +
          'small unlisted parts (fasteners, adhesive, coatings) or a component that was missed. Do not assign ' +
          `it to one part without saying so.${spanMiss}`
        : undefined
  }
}

/** The words of a name, for matching whole words: "Furnierklebstoff" is one word, "inner tube" two. */
const wordsOf = (s: string): string[] =>
  norm(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

/** Endings a plural or a case adds: "screw" and "screws", "Schraube" and "Schrauben", "Achse" and "Achsen". */
const ENDINGS = ['s', 'es', 'e', 'n', 'en', 'er', 'nen']
const formsOf = (w: string): string[] => [
  w,
  ...ENDINGS.map((e) => w + e),
  ...ENDINGS.filter((e) => w.endsWith(e) && w.length - e.length >= 3).map((e) => w.slice(0, -e.length))
]

/**
 * One word for another: the same word in another number or case, or the head that ends a compound — a
 * "Massivachse" is an "Achse", "Massivachsen" are "Achsen".
 */
const sameWord = (inName: string, wanted: string): boolean => {
  const forms = formsOf(wanted)
  if (formsOf(inName).some((f) => forms.includes(f))) return true
  return (
    /^\p{L}{3,}$/u.test(wanted) &&
    forms.some((f) => f.length >= 3 && inName.length > f.length && inName.endsWith(f))
  )
}

/**
 * Which listed name a leg's word for another part points at — an `includes` entry, a figure for another leg's part:
 * exact, or one name holding the other as a run of words ("inner tube" and "tube"), the last of them in any number
 * ("screw" and "screws") or as the head of a compound ("Achse" and "Massivachse").
 * Never the start or middle of a word: "Furnierklebstoff" (veneer adhesive) is no veneer, and reading it as one
 * locked a door's balance on an overlap that was not there.
 */
export function resolveName(wanted: string, names: string[]): string | undefined {
  const w = wordsOf(wanted)
  if (!w.length) return undefined
  const holds = (long: string[], short: string[]): boolean =>
    short.length <= long.length &&
    long.some((_, i) =>
      short.every((x, k) =>
        k === short.length - 1 ? long[i + k] !== undefined && sameWord(long[i + k], x) : long[i + k] === x
      )
    )
  return (
    names.find((n) => norm(n) === norm(wanted)) ??
    names.find((n) => holds(wordsOf(n), w) || holds(w, wordsOf(n)))
  )
}

/** A request and the entries that answered it; the leg says which answer they came in (the recipe is one of its own). */
interface Group {
  name: string
  items: BomItem[]
  leg: number
}

/**
 * Overlaps the legs reported, kept only where they point at another listed entry that has a mass — another entry
 * of the same request (a tyre that includes the tube listed beside it) or another request's entries. An unknown
 * name, or an entry naming itself or its own request, says nothing checkable and is ignored — so are the entries of
 * its own name in its own leg: parts told apart only by material (packaging as cardboard and film) share the words an
 * entry lists its own pieces by, and whether one is a figure of another is the question the side-by-side note on
 * them already asks. But nothing is ever removed from the sum on the strength of a hint: a valid overlap locks the
 * verdict instead.
 */
function overlapsOf(groups: Group[]): Overlap[] {
  const out: Overlap[] = []
  const all = groups.flatMap((g) => g.items.map((item) => ({ item, group: g })))
  for (const { item, group } of all) {
    const inside: string[] = []
    const sibling = (g: Group, name: string): boolean =>
      g.leg === group.leg && norm(name) === norm(item.component)
    for (const wanted of item.includes ?? []) {
      const others = all.filter((x) => x.item !== item && !sibling(x.group, x.item.component))
      const asItem = resolveName(
        wanted,
        others.map((x) => x.item.component)
      )
      const asRequest = asItem
        ? undefined
        : resolveName(
            wanted,
            groups.filter((g) => g !== group && g.items.length && !sibling(g, g.name)).map((g) => g.name)
          )
      const name = asItem ?? asRequest
      if (name && !inside.includes(name)) inside.push(name)
    }
    if (!inside.length) continue
    out.push({ entry: item.component, includes: inside })
    // The container is marked, so the provenance log keeps it as a documented figure; the contained entries stay
    // masses to book — once.
    item.contains_listed = inside
  }
  return out
}

const statusOf = (leg: BomLeg | undefined): RequestStatus =>
  !leg
    ? 'failed'
    : leg.items.length
      ? leg.unresolved.length
        ? 'partial'
        : 'with_mass'
      : leg.unresolved.length
        ? 'no_mass'
        : leg.product_masses.length
          ? 'product_mass_only'
          : 'failed'

/**
 * Put the settled legs together and judge them. Component mode (one leg per requested component) reports a
 * status per request; the enumerating leg reports what it listed, which says nothing about whether the product
 * is complete.
 */
export function weighBom(
  outcomes: LegOutcome[],
  opts: {
    totalMassKg?: number
    notResearched?: string[]
    itemCap?: number
    tolerance?: number
    /** The mixture, weighed on its own: its ingredients pass by the rules for parts, and its closure is its check. */
    recipe?: RecipeWeighing
  } = {}
): BomWeighing {
  const componentMode = outcomes.some((o) => o.request !== null)
  const recipe = opts.recipe
  const recipeOnly = !!recipe && !outcomes.length
  // An entry with exactly the mass of a whole-product weight some leg reported, beside other parts with a mass,
  // cannot be a part: the leg returned the whole product in the wrong place (asked for "the total weight" as a
  // component, it answered with an entry). It is read as what it is — a whole-product figure — and said so. Exact
  // means 0.5 %: a real dominant part (9.85 of 10 kg) stays a part, and only the suspicion below names it.
  const reported = outcomes.flatMap((o) => o.leg?.product_masses ?? [])
  const allParts = outcomes.flatMap((o) => o.leg?.items ?? []).filter((i) => !i.packaging)
  const partCount = allParts.length
  const partSum = allParts.reduce((t, i) => t + i.mass_kg, 0)
  const relabelled: string[] = []
  outcomes = outcomes.map((o) => {
    if (!o.leg || partCount < 2 || !reported.length) return o
    // The other parts must weigh more than the rounding margin: glass of 9.96 kg beside a 0.04 kg seal against a
    // 10 kg product is a complete list, not a misplaced total.
    const same = (i: BomItem): boolean =>
      !i.packaging &&
      reported.some(
        (p) =>
          Math.abs(p.mass_kg - i.mass_kg) <= SAME_FIGURE * p.mass_kg &&
          partSum - i.mass_kg > SAME_FIGURE * p.mass_kg
      )
    const moved = o.leg.items.filter(same)
    if (!moved.length) return o
    relabelled.push(...moved.map((i) => `"${i.component}" (${i.mass_kg} kg)`))
    return {
      ...o,
      leg: {
        ...o.leg,
        items: o.leg.items.filter((i) => !same(i)),
        product_masses: [
          ...o.leg.product_masses,
          ...moved.map(
            (i): ProductMass => ({
              mass_kg: i.mass_kg,
              basis: 'unknown',
              ...(i.version ? { version: i.version } : {}),
              ...(i.source_url ? { source_url: i.source_url } : {}),
              note:
                `Returned as the part "${i.component}"${i.material ? ` (${i.material})` : ''}, with exactly the mass ` +
                `of a whole-product weight the research found.${i.note ? ` Its note: ${i.note}` : ''}`
            })
          )
        ]
      }
    }
  })
  const requests: Array<{ component: string; status: RequestStatus }> = []
  const groups: Group[] = []
  let items: BomItem[] = []
  const unresolved: UnresolvedComponent[] = []
  const found: ProductMass[] = []
  const seen: VersionSeen[] = []
  const productOnly: string[] = []
  const repeats: string[] = []
  const several: string[] = []
  let legNo = -1
  for (let o of outcomes) {
    legNo++
    if (o.leg) {
      const read = onePerName(o.leg)
      repeats.push(...read.repeats)
      o = { ...o, leg: read.leg }
      if (o.request === null) several.push(...sameNameEntries(read.leg))
      else {
        const many = severalEntries(o.request, read.leg)
        if (many) several.push(many)
      }
    }
    const status = statusOf(o.leg)
    const name = o.request ?? 'the component list'
    if (o.request !== null && !o.known) requests.push({ component: o.request, status })
    if (status === 'failed') {
      if (o.request !== null)
        unresolved.push({
          component: o.request,
          reason: 'failed',
          note: o.error ?? 'The research came back with nothing usable after its retries.'
        })
      continue
    }
    const leg = o.leg as BomLeg
    if (status === 'product_mass_only' && o.request !== null) productOnly.push(o.request)
    if (o.request !== null) groups.push({ name: o.request, items: leg.items, leg: legNo })
    else for (const i of leg.items) groups.push({ name: i.component, items: [i], leg: legNo })
    items = items.concat(leg.items)
    unresolved.push(...leg.unresolved)
    found.push(...leg.product_masses.map((p) => ({ ...p, from: name })))
    seen.push(...leg.versions_seen)
  }
  const locks: string[] = []
  const notes: string[] = []
  if (repeats.length)
    notes.push(
      `${repeats.join(', ')} came back twice for the same request; the first figure is kept, the repeat left out.`
    )
  if (relabelled.length)
    notes.push(
      `${relabelled.join(', ')} came back as ${relabelled.length === 1 ? 'a part' : 'parts'} but with exactly the mass ` +
        'of a whole-product weight the research found — counted as that weight (totals_found), not as a part.'
    )
  notes.push(...several)
  const cap = opts.itemCap ?? Infinity
  if (items.length > cap) {
    locks.push(`${items.length - cap} further entries were cut from the list`)
    items = items.slice(0, cap)
  }
  const others = alternativesNote(items)
  if (others) notes.push(others)
  if (opts.notResearched?.length)
    locks.push(
      `${opts.notResearched.length} requested component${opts.notResearched.length === 1 ? ' was' : 's were'} ` +
        `not researched (over the limit per call): ${opts.notResearched.join(', ')}`
    )
  if (productOnly.length)
    locks.push(
      `the research for ${productOnly.map((p) => `"${p}"`).join(', ')} returned only the whole product's mass ` +
        '(see totals_found) — if that names a part, its own mass is missing'
    )
  // The mixture's ingredients join after the cap and outside the rules above: water and water from a trade form are
  // two contributions, not a repeat, and the recipe's lines have a ceiling of their own. Its name is a group, so a
  // part that "includes" the mixture (a tread with its compound) is an overlap like any other.
  const mixtureKg = recipe?.block.mass_kg
  if (recipe) {
    items = items.concat(recipe.items)
    groups.push({ name: recipe.block.of, items: recipe.items, leg: -1 })
    seen.push(...recipe.versions_seen)
    notes.push(...recipe.notes)
    if (recipe.lock) locks.push(recipe.lock)
    if (mixtureKg === undefined && (componentMode || opts.totalMassKg))
      locks.push(
        `the mixture ${recipe.block.of} has no mass in kg — pass recipe.mass_kg (its mass in the product), or nothing ` +
          'can be weighed against a total'
      )
  }
  const overlaps = overlapsOf(groups)
  if (overlaps.length)
    locks.push(
      'entries overlap: ' +
        overlaps
          .map((o) => `"${o.entry}" contains ${o.includes.map((n) => `"${n}"`).join(', ')}`)
          .join('; ') +
        ' — book the contained part once, and the rest of the figure that contains it, not both whole'
    )
  const totals = totalsOf(found)
  let total: TotalUsed | undefined
  if (opts.totalMassKg && Number.isFinite(opts.totalMassKg) && opts.totalMassKg > 0) {
    total = { mass_kg: opts.totalMassKg, basis: 'net', source: 'given' }
    const tol = opts.tolerance ?? TOLERANCE
    const apart = totals.filter((p) => Math.abs(p.mass_kg - opts.totalMassKg!) / opts.totalMassKg! > tol)
    if (apart.length)
      notes.push(
        `The research found ${apart.map(massWords).join(', ')} ` +
          `for the whole product, against the ${opts.totalMassKg} kg you passed — check which is right.`
      )
  } else {
    const r = researchedTotal(totals)
    if (typeof r === 'string') locks.push(r)
    else total = r
  }
  // A part as heavy as the whole product, beside other parts with a mass, is suspected of being the whole
  // product's figure. Named, never removed — a dominant part can be real (9.85 of 10 kg). It locks the verdict
  // only when the parts then overshoot the total, which a real dominant part leaves no room for.
  const parts = items.filter((i) => !i.packaging && i.group !== 'recipe')
  const partsSum = parts.reduce((s, i) => s + i.mass_kg, 0)
  if (total)
    for (const p of parts) {
      if (p.mass_kg < WHOLE_SHARE * total.mass_kg || !parts.some((q) => q !== p)) continue
      const words =
        `"${p.component}" (${p.mass_kg} kg) weighs as much as the whole product (${total.mass_kg} kg) — check ` +
        'whether its source gives the part or the whole product'
      if (partsSum > total.mass_kg) locks.push(`${words}; the parts overshoot the total`)
      else notes.push(`${words}.`)
    }
  const heavier = heavierThanWhole(parts, totals, total)
  if (heavier) notes.push(heavier)
  const versions = versionsOf(items, found, seen, [
    ...(recipe?.version ? [{ version: recipe.version, entry: `recipe of ${recipe.block.of}` }] : []),
    ...(recipe?.contents_version
      ? [
          {
            version: recipe.contents_version,
            entry: `contents of ${recipe.block.of} (${recipe.block.mass_kg} kg)`
          }
        ]
      : [])
  ])
  if (versions?.conflict && versions.used) {
    // An EAN only part entries name may be the part's own article number. The lock stays — the tool cannot tell, and
    // the leg was asked for the whole product's version there — but when nothing else conflicts, it is the question
    // the lock asks, with the step that answers it.
    const parts = (versions.unattested ?? [])
      .map((u) => `"${u.version}" (on ${u.entries.join(', ')})`)
      .join('; ')
    locks.push(
      versions.only_part_eans
        ? `an EAN is named only on a part entry, never on a whole-product figure, and differs from the product's: ${parts} ` +
            "— open that entry's source: if it is the part's own article number (a spare part sold on its own), it " +
            'names no other version and the figures rest on one; if it is another version of the product, that figure ' +
            'may not fit'
        : "figures that claim to be this product's own name different versions: " +
            versions.used.map((u) => `${u.version} (${u.entries.join(', ')})`).join('; ') +
            (parts
              ? ` (only part entries name ${parts}: if that is the part's own article number, it names no other version)`
              : '') +
            ' — the list may mix versions; settle which one the user means, or that these are one version'
    )
  }
  if (versions?.seen)
    notes.push(
      `The sources also show other versions of this product: ${versions.seen
        .map((s) =>
          [s.version, s.differs_by, s.mass_kg ? `${s.mass_kg} kg` : '', s.sold_by].filter(Boolean).join(', ')
        )
        .join('; ')} — if the description does not settle which one the user means, ask.`
    )
  const open = unresolved.map((u) => `${u.component} (${REASON_WORDS[u.reason]})`)
  const weighed = massBalance({
    items,
    total,
    open,
    locks,
    overlapping: overlaps.length > 0,
    tolerance: opts.tolerance,
    ...(mixtureKg !== undefined ? { mixtureKg } : {})
  })
  // A recipe alone, with no total: its closure is the whole check — "no total mass" would be a false gap.
  const balance =
    recipeOnly && !total
      ? {
          ...weighed,
          balance_ok: locks.length || open.length ? null : true,
          ...(recipe.block.gap_kg !== undefined ? { residual_kg: recipe.block.gap_kg } : {}),
          note:
            locks.length || open.length
              ? `Balance NOT checked: ${[...open, ...locks].join('; ')}.`
              : undefined
        }
      : weighed
  const withMass = requests.filter((r) => r.status === 'with_mass').length
  const known = outcomes.filter((o) => o.known).length
  const coverage = componentMode
    ? {
        requested: requests.length + (opts.notResearched?.length ?? 0),
        with_mass: withMass,
        ...(known ? { known } : {})
      }
    : { listed: items.length + unresolved.length, with_mass: items.length }
  const summary = summarise({
    componentMode,
    coverage,
    balance,
    total,
    open,
    versions,
    totalsDisagree: !total && totals.length > 0,
    tolerance: opts.tolerance ?? TOLERANCE,
    recipe,
    recipeOnly
  })
  return {
    summary,
    ...(componentMode ? { requests } : {}),
    coverage,
    items,
    unresolved,
    ...(totals.length ? { totals_found: totals } : {}),
    ...(total ? { total_used: total } : {}),
    ...balance,
    ...(overlaps.length ? { overlaps } : {}),
    ...(versions ? { versions } : {}),
    ...(recipe ? { recipe: recipe.block } : {}),
    note: [balance.note, ...notes].filter(Boolean).join(' ') || undefined
  }
}

/** The one paragraph the parent should read first: what was summed, against what, and what is open. */
function summarise(s: {
  componentMode: boolean
  coverage: BomWeighing['coverage']
  balance: ReturnType<typeof massBalance>
  total?: TotalUsed
  open: string[]
  versions?: Versions
  totalsDisagree: boolean
  tolerance: number
  recipe?: RecipeWeighing
  recipeOnly: boolean
}): string {
  const c = s.coverage as { requested?: number; listed?: number; with_mass: number; known?: number }
  const mixture = s.recipe?.block.mass_kg
  // Known parts are named apart from the requested ones: they were given, not researched.
  const given = c.known ? `${c.known} known part${c.known === 1 ? '' : 's'} given` : ''
  const parts = s.recipeOnly
    ? 'Only the recipe was researched, no other part of the product (a container or packaging would go in components)'
    : s.componentMode
      ? c.requested || !given
        ? `${c.with_mass} of ${c.requested} requested components came back with a mass of their own` +
          (given ? `, beside ${given}` : '')
        : `${given[0].toUpperCase()}${given.slice(1)}${s.recipe ? '' : ', nothing researched'}`
      : `${c.with_mass} of ${c.listed} listed components have a mass`
  const packs = [
    s.balance.packaging_kg ? `sales packaging ${s.balance.packaging_kg} kg` : '',
    s.balance.transport_packaging_kg ? `transport packaging ${s.balance.transport_packaging_kg} kg` : ''
  ].filter(Boolean)
  const sum =
    s.recipeOnly && mixture === undefined
      ? ''
      : `${s.recipeOnly ? 'the mixture weighs' : mixture !== undefined ? 'parts and mixture sum to' : 'parts sum to'} ` +
        `${s.balance.sum_kg} kg${packs.length ? ` (${packs.join(', ')} on top)` : ''}`
  // Scaling is not checking: a mixture scaled to a given mass leaves the total to check the other parts alone.
  const scaled =
    mixture !== undefined
      ? ', the mixture counted at the mass it was scaled to, so this checks the other parts'
      : ''
  const against = s.total
    ? `Checked against ${totalWords(s.total)}${scaled}`
    : s.totalsDisagree
      ? 'The whole-product masses the research found disagree, so none was used'
      : s.recipeOnly
        ? "The recipe's closure is the check"
        : 'No total mass is known, so nothing was checked'
  // The share beside the kilograms: "0.418 kg" alone read as a gap to close before building, on a list that
  // landed 2 % from its total.
  const share =
    s.total && s.balance.residual_kg !== undefined
      ? `${Math.round((Math.abs(s.balance.residual_kg) / s.total.mass_kg) * 100)} % of the total`
      : ''
  const verdict =
    s.recipeOnly && !s.total
      ? s.balance.balance_ok === true
        ? 'it closes.'
        : 'not judged.'
      : s.balance.balance_ok === true
        ? `the parts add up (residual ${s.balance.residual_kg} kg, ${share}, within the ${Math.round(s.tolerance * 100)} % tolerance).`
        : s.balance.balance_ok === false
          ? `the parts do NOT add up (residual ${s.balance.residual_kg} kg, ${share}).`
          : s.balance.residual_kg !== undefined
            ? `not judged; residual ${s.balance.residual_kg} kg.`
            : 'not judged.'
  const next = [
    s.open.length ? `Still open: ${s.open.join(', ')}` : '',
    s.versions?.conflict ? 'the figures rest on different versions of the product' : ''
  ]
    .filter(Boolean)
    .join('; ')
  return (
    `${s.recipe ? `${s.recipe.sentence} ` : ''}${parts}${sum ? `; ${sum}` : ''}. ${against} — ${verdict}` +
    (next ? ` ${next[0].toUpperCase()}${next.slice(1)} — see note.` : '')
  )
}
