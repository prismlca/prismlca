/**
 * One bill-of-materials research leg's answer, read: which entries carry a mass and for how many pieces, which
 * the leg named without one, what it found for the whole product, and which other versions of the product its
 * sources showed. Validation only — nothing here sums, compares or judges (bomBalance.ts does).
 *
 * The leg usually knows what its figure is ("complete rack", "per board", "weighed with its spout"): the
 * fields below exist so it can say so where the code reads it, instead of in a note nobody parses.
 */
import { clipNote, type NotedLinks } from './researchNote'

export interface BomItem {
  component: string
  material: string
  /** Mass of ALL pieces this entry stands for, in kg — a set of five shelves, not one shelf. */
  mass_kg: number
  /** How many pieces the entry stands for, when more than one. */
  count?: number
  /** Mass of one piece, when the source gave it per piece; `mass_kg` is then `count × mass_each_kg`,
   *  multiplied here rather than by the language model. */
  mass_each_kg?: number
  /** Researched span [min, max] in kg for the whole entry, present only when the sources gave a range rather
   *  than one figure. `mass_kg` is the leg's chosen value inside it; the span is what a scenario spread can
   *  build on mechanically. */
  mass_range_kg?: [number, number]
  /** Packaging rather than the product itself, kept out of the parts' sum. `sales`: what the product is sold in (its
   *  retail box, blister, film) — a gross article weight contains it; `transport`: shipping cartons, pallets,
   *  stretch film shared by several units — no weight of the product contains it. */
  packaging?: 'sales' | 'transport'
  /** Set on the ingredients of a researched recipe: they are weighed by the recipe's own closure (recipeBalance.ts),
   *  not by the rules for parts. */
  group?: 'recipe'
  /** A recipe ingredient's percent of the mixture, on the booking basis. */
  share_pct?: number
  /** The trade form a recipe ingredient was dosed in, when the entry is one of its stated constituents. */
  from_trade_form?: string
  /** Other requested components whose mass this figure already contains, as the leg named them (a pouch
   *  weighed with its spout). A hint the balance reads, never a reason to remove a mass. */
  includes?: string[]
  /** Other figures the sources gave for this same part — another variant of it, another source, a comparable
   *  product's part — beside the one the leg chose to model with. Documented, never summed: listed as entries
   *  of their own they counted one pouch three times. */
  alternatives?: BomAlternative[]
  /** The version of THIS product the figure belongs to — an EAN, an article number or the spec that tells
   *  versions apart. Empty for a comparable product's figure. */
  version?: string
  /** Set by the weighing: the other listed entries this figure was found to contain. Its mass is documented,
   *  but booking it whole beside them would count them twice. */
  contains_listed?: string[]
  source_url?: string
  /** Source kind as judged by the leg: official | industry | media | community. */
  source_class?: string
  /** The leg's confidence in the figure: high | medium | low (words, not a numeric scale — see WebFinding). */
  confidence?: string
  note?: string
  /** True when `source_url` is a page the search engine actually returned to the leg (a `url_citation`
   *  annotation); false when the leg wrote a URL the engine never cited — from memory, or a page it
   *  opened directly. Absent when the provider annotates nothing. */
  cited_by_search?: boolean
  /** Set once the sources are settled (bomSources.ts): no page is left behind the figure — the leg named none,
   *  or its link leads to no page. The figure stays in the sums; this says nothing backs it. */
  unsourced?: boolean
}

/** Another figure for the same part, on the entry's basis: the mass of all the pieces the entry stands for. */
export interface BomAlternative {
  mass_kg: number
  material?: string
  source_url?: string
  note?: string
}

/**
 * A requested or named component without a usable mass. Kept and reported rather than dropped:
 * PCFBench (arXiv 2608.27716) measures 47–86 % of generated bills of materials carrying "ghost"
 * zero-mass parts and a quarter to a third of the parts missing outright — and the
 * parser used to delete the first kind silently and let the second pass as a clean list.
 */
export interface UnresolvedComponent extends NotedLinks {
  component: string
  material?: string
  /**
   * `no_mass`: the leg found the part but no figure; `zero_mass`: it wrote 0, which is a ghost;
   * `unclear_mass`: a per-piece mass without a count, a set mass that contradicts count × piece mass, or
   * figures given only as alternatives — no reading is preferred, the figures stay in the note;
   * `whole_product_only`: the research for it found the whole product's mass and nothing for the part;
   * `failed`: the research for it never came back.
   */
  reason: 'no_mass' | 'zero_mass' | 'unclear_mass' | 'whole_product_only' | 'failed'
  /** The page the leg named for it, when it named one. */
  source_url?: string
  /** The figures a leg gave only as alternatives, none as its own: kept with their pages, and carried onto the
   *  entry a follow-up finds, so a figure that lands later does not erase them. */
  alternatives?: BomAlternative[]
}

/** A mass the sources give for the WHOLE product — never summed as a part. */
export interface ProductMass {
  mass_kg: number
  /** `net`: without packaging (article weight); `gross`: with it (shipping weight); `unknown`: the source
   *  does not say. Unknown is a real answer, and the balance treats it as one. */
  basis: 'net' | 'gross' | 'unknown'
  version?: string
  source_url?: string
  source_class?: string
  confidence?: string
  note?: string
  /** The requested component whose researcher reported it, or "the component list". */
  from?: string
}

/** Another version of this product the leg's sources showed (another EAN, thickness, weight, market). */
export interface VersionSeen {
  version: string
  differs_by?: string
  mass_kg?: number
  sold_by?: string
  source_url?: string
}

export interface BomLeg {
  items: BomItem[]
  unresolved: UnresolvedComponent[]
  product_masses: ProductMass[]
  versions_seen: VersionSeen[]
}

const CLASSES = ['official', 'industry', 'media', 'community']
const CONFIDENCES = ['high', 'medium', 'low']
/** How far a stated set mass may sit from count × piece mass before the two count as contradicting. */
const COUNT_SLACK = 0.02

const text = (v: unknown): string => (v == null ? '' : String(v).trim())
/** A finite number or NaN; null, '' and missing are NaN — "no figure", never 0. */
const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v))
const word = (v: unknown, allowed: string[]): string | undefined => {
  const w = text(v).toLowerCase()
  return allowed.includes(w) ? w : undefined
}
/** Only the closed vocabularies pass — a free-text judgement would be indistinguishable from a checked one. */
const judgement = (r: Record<string, unknown>): { source_class?: string; confidence?: string } => {
  const klass = word(r.source_class, CLASSES)
  const conf = word(r.confidence, CONFIDENCES)
  return { ...(klass ? { source_class: klass } : {}), ...(conf ? { confidence: conf } : {}) }
}
const sourceOf = (r: Record<string, unknown>): string | undefined =>
  text(r.source_url) || text(r.source) || undefined

/** A usable range brackets the point value; anything else is dropped, never "repaired". */
function rangeAround(raw: unknown, point: number): [number, number] | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined
  const lo = Number(raw[0])
  const hi = Number(raw[1])
  return Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && lo < hi && point >= lo && point <= hi
    ? [lo, hi]
    : undefined
}

/** Other figures kept per part — a survey beyond that belongs in the note. */
const MAX_ALTERNATIVES = 4

/**
 * The other figures a leg gave for one part, on the entry's basis and by the entry's rules: a piece mass needs the
 * entry's count and is multiplied by it, and a set mass beside it must agree with that product. A figure that
 * cannot be read one way is not read at all — named in `unread`, never a reading picked. A variant named without a
 * figure stays in the note.
 */
function alternativesOf(
  raw: unknown,
  count: number | undefined
): { kept: BomAlternative[]; unread: string[] } {
  const kept: BomAlternative[] = []
  const unread: string[] = []
  for (const a of listOf(raw)) {
    if (!a || typeof a !== 'object') continue
    const r = a as Record<string, unknown>
    const each = num(r.mass_each_kg)
    const stated = num(r.mass_kg ?? r.mass)
    let mass = stated
    if (Number.isFinite(each) && each > 0) {
      if (!count) {
        unread.push(`${each} kg per piece (no count of pieces)`)
        continue
      }
      mass = Number((each * count).toFixed(6))
      if (Number.isFinite(stated) && stated > 0 && Math.abs(stated - mass) / mass > COUNT_SLACK) {
        unread.push(`${stated} kg for the set against ${count} × ${each} kg = ${mass} kg`)
        continue
      }
    }
    if (!Number.isFinite(mass) || mass <= 0) continue
    if (kept.length >= MAX_ALTERNATIVES) continue
    const material = text(r.material ?? r.materials)
    const note = text(r.note)
    kept.push({
      mass_kg: mass,
      ...(material ? { material } : {}),
      ...(sourceOf(r) ? { source_url: sourceOf(r) } : {}),
      ...(note ? { note } : {})
    })
  }
  return { kept, unread }
}

/** "0.0103 kg (PET/ALU/PE)" — an alternative as a note names it. */
export const alternativeWords = (a: BomAlternative): string =>
  `${a.mass_kg} kg${a.material ? ` (${a.material})` : ''}`

/** `"transport"` is transport packaging; `"sales"` and the older `true` are what the product is sold in. */
const packagingOf = (v: unknown): BomItem['packaging'] =>
  v === true || text(v).toLowerCase() === 'sales'
    ? 'sales'
    : text(v).toLowerCase() === 'transport'
      ? 'transport'
      : undefined

const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [])

/** Read the whole-product masses a leg reported. */
function parseProductMasses(raw: unknown): ProductMass[] {
  const out: ProductMass[] = []
  for (const p of listOf(raw)) {
    if (!p || typeof p !== 'object') continue
    const r = p as Record<string, unknown>
    const mass = num(r.mass_kg ?? r.mass)
    if (!Number.isFinite(mass) || mass <= 0) continue
    const version = text(r.version)
    const note = text(r.note)
    out.push({
      mass_kg: mass,
      basis: (word(r.basis, ['net', 'gross']) as 'net' | 'gross' | undefined) ?? 'unknown',
      ...(version ? { version } : {}),
      ...(sourceOf(r) ? { source_url: sourceOf(r) } : {}),
      ...judgement(r),
      ...(note ? { note } : {})
    })
  }
  return out
}

function parseVersions(raw: unknown): VersionSeen[] {
  const out: VersionSeen[] = []
  for (const v of listOf(raw)) {
    if (!v || typeof v !== 'object') continue
    const r = v as Record<string, unknown>
    const version = text(r.version ?? r.id ?? r.name)
    if (!version) continue
    const mass = num(r.mass_kg)
    const differs = text(r.differs_by)
    const sold = text(r.sold_by)
    out.push({
      version,
      ...(differs ? { differs_by: differs } : {}),
      ...(Number.isFinite(mass) && mass > 0 ? { mass_kg: mass } : {}),
      ...(sold ? { sold_by: sold } : {}),
      ...(sourceOf(r) ? { source_url: sourceOf(r) } : {})
    })
  }
  return out
}

/**
 * Split a leg's answer into entries with a mass and components without one, and lift out what it found for the
 * whole product and the other versions it saw. A named part with no figure — `mass_kg` null, missing,
 * unparsable or 0 — is a gap to report, not a row to delete: the follow-up pass asks for exactly these, and the
 * balance verdict cannot be "ok" while they are open. Accepts the object the prompt asks for and the bare array
 * older answers (and some models) still produce.
 */
export function parseBomAnswer(parsed: unknown): BomLeg {
  const obj =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(obj.items) ? (obj.items as unknown[]) : []
  const items: BomItem[] = []
  const unresolved: UnresolvedComponent[] = []
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const component = text(r.component ?? r.part ?? r.name)
    if (!component) continue
    const material = text(r.material ?? r.materials)
    const stated = num(r.mass_kg ?? r.mass ?? r.mass_in_kg)
    const each = num(r.mass_each_kg)
    const countRaw = num(r.count ?? r.quantity)
    const count = Number.isInteger(countRaw) && countRaw >= 1 ? countRaw : undefined
    const { kept: alternatives, unread } = alternativesOf(r.alternatives, count)
    const unreadWords = unread.length
      ? `Other figures not readable on this entry's basis, left out: ${unread.join('; ')}.`
      : ''
    const open = (reason: UnresolvedComponent['reason'], why?: string, alts?: BomAlternative[]): void => {
      const note = [why, text(r.note), unreadWords].filter(Boolean).join(' ')
      unresolved.push({
        component,
        ...(material ? { material } : {}),
        reason,
        ...(note ? clipNote(note) : {}),
        ...(sourceOf(r) ? { source_url: sourceOf(r) } : {}),
        ...(alts?.length ? { alternatives: alts } : {})
      })
    }
    // Two readable shapes and no third: a set mass, or a piece mass with an explicit count. Anything else is
    // reported with its figures rather than read one way — the count may be the wrong number, not the mass.
    let mass: number
    let perPiece = false
    if (Number.isFinite(each) && each > 0) {
      if (!count) {
        open('unclear_mass', `A per-piece mass of ${each} kg came back without a count of pieces.`)
        continue
      }
      mass = Number((each * count).toFixed(6))
      perPiece = true
      if (Number.isFinite(stated) && stated > 0 && Math.abs(stated - mass) / mass > COUNT_SLACK) {
        open(
          'unclear_mass',
          `The figures contradict each other: ${stated} kg for the set, but ${count} × ${each} kg = ${mass} kg.`
        )
        continue
      }
    } else if (Number.isFinite(stated) && stated > 0) {
      mass = stated
    } else if (alternatives.length) {
      // Figures only as alternatives, none as the entry's own: the leg chose none, and neither does the reading.
      open(
        'unclear_mass',
        `No figure of its own, only alternatives: ${alternatives.map(alternativeWords).join(', ')} — none chosen.`,
        alternatives
      )
      continue
    } else {
      open(Number.isFinite(stated) ? 'zero_mass' : 'no_mass')
      continue
    }
    // The range has the basis of the figure it brackets: per piece when the leg gave a piece mass.
    const rawRange = r.mass_range_kg ?? r.mass_range
    const range = perPiece ? rangeAround(rawRange, each) : rangeAround(rawRange, mass)
    const includes = (Array.isArray(r.includes) ? r.includes : []).map(text).filter(Boolean)
    const version = text(r.version)
    items.push({
      component,
      material,
      mass_kg: mass,
      ...(count && count > 1 ? { count } : {}),
      ...(perPiece ? { mass_each_kg: each } : {}),
      ...(range
        ? {
            mass_range_kg: perPiece
              ? [Number((range[0] * (count ?? 1)).toFixed(6)), Number((range[1] * (count ?? 1)).toFixed(6))]
              : range
          }
        : {}),
      ...(packagingOf(r.packaging) ? { packaging: packagingOf(r.packaging) } : {}),
      ...(includes.length ? { includes } : {}),
      ...(alternatives.length ? { alternatives } : {}),
      ...(version ? { version } : {}),
      source_url: sourceOf(r),
      ...judgement(r),
      note: [r.note ? String(r.note) : '', unreadWords].filter(Boolean).join(' ') || undefined
    })
  }
  return {
    items,
    unresolved,
    product_masses: parseProductMasses(obj.product_mass ?? obj.product_masses ?? obj.total_mass),
    versions_seen: parseVersions(obj.versions_seen ?? obj.versions)
  }
}

/** Coerce a parsed answer into BOM items, dropping anything without a component and a mass. */
export function parseBomItems(parsed: unknown): BomItem[] {
  return parseBomAnswer(parsed).items
}
