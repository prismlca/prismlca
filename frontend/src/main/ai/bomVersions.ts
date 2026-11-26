/**
 * Which version of a product a bill-of-materials figure belongs to: EAN/GTIN numbers and the properties the other
 * numbers of a reference state (a board thickness, a volume, a model number), whether two references name one
 * version or contradict each other, and which references the figures of one research call rest on. Grouping what
 * the sources said, never verifying it.
 */
import type { BomItem, ProductMass, VersionSeen } from './bomAnswer'

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

export interface Versions {
  /** Figures that claim to be this product's own name different versions (by EAN or by words). */
  conflict: boolean
  /** The product references the entries and whole-product masses rest on, when there is more than one. */
  used?: Array<{ version: string; entries: string[] }>
  /** Of the conflicting references, those whose EAN only part entries name — no whole-product figure, reported
   *  version or recipe: perhaps the part's own article number rather than another version of the product. */
  unattested?: Array<{ version: string; entries: string[] }>
  /** Every conflict is one of those EANs against the product's: settled by opening the part's source. */
  only_part_eans?: true
  /** Other versions of this product the sources showed — information, not a verdict. */
  seen?: VersionSeen[]
}

/** EAN/GTIN numbers in a reference (12–14 digits) — the only part of a version string that identifies. */
export function gtinsIn(version: string): string[] {
  return [...new Set(version.match(/(?<!\d)\d{12,14}(?!\d)/g) ?? [])]
}

/** The words of a reference, for comparing references written differently. */
const words = (v: string): string[] =>
  norm(v)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)

/**
 * Whether two references name the same version: with EAN/GTIN numbers on both sides, when they share one; with
 * none on either, when every word of one is in the other ("Atlas 175 HDF4" and "Steckregal Atlas 175 HDF4"). A
 * number on one side only is no match, and an empty reference matches only an empty one. For grouping what was
 * said, never for verifying it: a leg that ties the wrong EAN to a listing is grouped with that EAN.
 */
export function sameReference(a?: string, b?: string): boolean {
  const x = a?.trim() ?? ''
  const y = b?.trim() ?? ''
  if (!x || !y) return !x && !y
  const gx = gtinsIn(x)
  const gy = gtinsIn(y)
  if (gx.length || gy.length) return gx.some((g) => gy.includes(g))
  const wx = words(x)
  const wy = words(y)
  const within = (p: string[], q: string[]): boolean => p.length > 0 && p.every((w) => q.includes(w))
  return within(wx, wy) || within(wy, wx)
}

/** Whether two references carry EAN/GTIN numbers on both sides and share none: two trade items. */
export function gtinsDiffer(a?: string, b?: string): boolean {
  const ga = gtinsIn(a ?? '')
  const gb = gtinsIn(b ?? '')
  return ga.length > 0 && gb.length > 0 && !ga.some((g) => gb.includes(g))
}

/**
 * The units a number in a reference can carry, each as the quantity it measures and its factor to one base unit:
 * "4 mm" and "0.4 cm" are one thickness, "150 Liter" and "150 l" one volume.
 */
const UNITS = new Map<string, [quantity: string, factor: number, base: string]>([
  ['mm', ['length', 1, 'mm']],
  ['cm', ['length', 10, 'mm']],
  ['dm', ['length', 100, 'mm']],
  ['m', ['length', 1000, 'mm']],
  ['zoll', ['length', 25.4, 'mm']],
  ['inch', ['length', 25.4, 'mm']],
  ['ml', ['volume', 1, 'ml']],
  ['cl', ['volume', 10, 'ml']],
  ['l', ['volume', 1000, 'ml']],
  ['ltr', ['volume', 1000, 'ml']],
  ['liter', ['volume', 1000, 'ml']],
  ['litre', ['volume', 1000, 'ml']],
  ['w', ['power', 1, 'w']],
  ['kw', ['power', 1000, 'w']],
  ['wh', ['energy', 1, 'wh']],
  ['kwh', ['energy', 1000, 'wh']],
  ['mah', ['charge', 1, 'mah']],
  ['v', ['voltage', 1, 'v']],
  ['hz', ['frequency', 1, 'hz']],
  ['bar', ['pressure', 1, 'bar']]
])
/**
 * What a reference says that is no version of the product, cut before its numbers are read: the EAN/GTIN numbers
 * (compared on their own), a full date — of a document, a listing, a reading ("EPD v2, 2025-06-23", "23.06.2025";
 * never a slashed one, which is as likely a size: "10/20/30 mm") — a place in a list ("variant 1 of 2"), and masses. A month and year stays, read as its year: "reformulated May 2024" against
 * "May 2025" are two recipes, and a year counts only when both references carry one.
 */
const NOT_A_FEATURE = [
  /(?<!\d)\d{12,14}(?!\d)/g,
  /\b(?:19|20)\d\d-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])\b/g,
  /\b(?:0?[1-9]|[12]\d|3[01])\.\s?(?:0?[1-9]|1[0-2])\.\s?(?:(?:19|20)\d\d|\d\d)\b/g,
  /\b\d+\s+(?:of|von|aus)\s+\d+\b/g,
  /\d+(?:[.,]\d+)?\s*(?:kg|g|gr|gramm|mg|t|lb|lbs|oz)\b/g
]
/** A month before a year: "Mai 2024", "Jan. 2023", "2025-06" — the year is what the reference keeps. */
const MONTH_YEAR = [
  /\b(?:januar|january|jan|februar|february|feb|märz|maerz|march|mar|april|apr|mai|may|juni|june|jun|juli|july|jul|august|aug|september|sept|sep|oktober|october|okt|oct|november|nov|dezember|december|dez|dec)\.?\s+((?:19|20)\d\d)\b/gu,
  /\b((?:19|20)\d\d)-(?:0?[1-9]|1[0-2])\b/g
]
/**
 * A size written with a unit on every axis ("176 cm x 90 cm x 40 cm", "1.76 m x 90 cm") is one chain like
 * "176 x 90 x 40 cm": each axis is rewritten in the last axis's unit, so both spellings meet as one length×3. Only
 * "x", "×" and "*" join such axes — "4 mm / 5 mm" may name two thicknesses. Axes of another quantity stay as written.
 */
const UNIT_WORDS = [...UNITS.keys()].sort((a, b) => b.length - a.length).join('|')
const MEASURE = `(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_WORDS})?(?!(?!x)\\p{L})`
const AXES = new RegExp(`${MEASURE}(?:\\s*[x×*]\\s*${MEASURE})+`, 'gu')
function oneUnitPerChain(text: string): string {
  return text.replace(AXES, (chain) => {
    const axes = [...chain.matchAll(new RegExp(MEASURE, 'gu'))].map((m) => ({ v: m[1], unit: m[2] }))
    const last = axes[axes.length - 1].unit
    if (!last || axes.every((a, k) => k === axes.length - 1 || !a.unit)) return chain
    const [quantity, factor] = UNITS.get(last)!
    if (axes.some((a) => a.unit && UNITS.get(a.unit)![0] !== quantity)) return chain
    // Twelve digits only clear floating-point noise: the rounding that compares ("3 m x 1 inch" with
    // "3000 x 25.4 mm") happens once, when the chain is read in its base unit.
    const inLast = axes.map((a) =>
      a.unit
        ? String(+((Number(a.v.replace(',', '.')) * UNITS.get(a.unit)![1]) / factor).toPrecision(12))
        : a.v
    )
    return `${inLast.join(' x ')} ${last}`
  })
}

/** Words a number follows that name no property of it: "für 150 l" and "für 400 mm" state no common property. */
const NOT_A_CODE = new Set(
  'für mit ohne von aus und oder bei pro je ca bis zu for with without of and or per approx at to by from'.split(
    ' '
  )
)

/**
 * The version features of a reference: its numbers, each under the property it states — the quantity a unit measures
 * ("4 mm" and "0.4 cm" one length, "176x90x40 cm" a size of three), the code it is written to ("HDF4", "Atlas 175",
 * "Atlas-180"), or both ("HDF 5 mm") — and the years apart. A number neither carries goes under "#". Long bare
 * numbers (five digits and more) are article, order and register numbers of a shop, a spare part or a document, not
 * of a version: two retailers' numbers for one wheelbarrow are no contradiction.
 *
 * A value is the number as written, and for a measure "written~base": "0.4~4 mm". Measures compare in the base unit;
 * a number without a unit matches a measure by either ("HDF4" and "HDF 4 mm", "PRAKTICA 150" and "PRAKTICA 150 l").
 */
export function versionFeatures(reference: string): Map<string, Set<string>> {
  let text = norm(reference)
  for (const re of NOT_A_FEATURE) text = text.replace(re, ' ; ')
  text = oneUnitPerChain(text)
  const years: string[] = []
  for (const re of MONTH_YEAR)
    text = text.replace(re, (_, year: string) => {
      years.push(year)
      return ' ; '
    })
  const tokens = [...text.matchAll(/\p{L}+|\d+(?:[.,]\d+)?/gu)].map((m) => ({
    t: m[0],
    at: m.index,
    end: m.index + m[0].length
  }))
  const isNum = (i: number): boolean => /^\d/.test(tokens[i]?.t ?? '')
  const gap = (i: number): string => (i > 0 ? text.slice(tokens[i - 1].end, tokens[i].at) : ' ')
  const num = (v: string): number => Number(v.replace(',', '.'))
  const out = new Map<string, Set<string>>()
  const add = (key: string, values: string[]): void => {
    const set = out.get(key) ?? new Set<string>()
    for (const v of values) set.add(v)
    out.set(key, set)
  }
  if (years.length) add('year', years)
  for (let i = 0; i < tokens.length; i++) {
    if (!isNum(i)) continue
    // A chain of dimensions states one property, whatever joins it: "176x90x40 cm", "176×90 x 40 cm", "400/100".
    const chain = [tokens[i].t]
    let j = i
    for (;;) {
      if (isNum(j + 2) && tokens[j + 1].t === 'x' && /^\s*$/.test(gap(j + 1) + gap(j + 2))) {
        chain.push(tokens[j + 2].t)
        j += 2
      } else if (isNum(j + 1) && /^\s*[/×*]\s*$/.test(gap(j + 1))) chain.push(tokens[++j].t)
      else break
    }
    const before = i > 0 && !isNum(i - 1) ? tokens[i - 1] : undefined
    const after = !isNum(j + 1) ? tokens[j + 1] : undefined
    // Written to a code: directly or by a hyphen ("HDF4", "Atlas-180"), or after its word ("Atlas 175", "HDF 5 mm").
    const joined = gap(i)
    const code =
      before && !UNITS.has(before.t) && !NOT_A_CODE.has(before.t) && /^(?:-?|\s+)$/.test(joined)
        ? before.t
        : undefined
    const unitWord = after && /^[\s-]*$/.test(gap(j + 1)) && UNITS.has(after.t) ? after.t : undefined
    const suffix = !unitWord && after && gap(j + 1) === '' ? after.t : undefined
    const single = chain.length === 1 ? chain[0] : undefined
    i = j
    if (unitWord) {
      const [quantity, factor, base] = UNITS.get(unitWord)!
      const inBase = chain.map((v) => +(num(v) * factor).toPrecision(6))
      add(chain.length > 1 ? `${quantity}×${chain.length}` : quantity, [
        `${[...inBase].sort((a, b) => a - b).join('x')} ${base}`
      ])
      if (code)
        add(
          `code ${code}`,
          chain.map((v, k) => `${num(v)}~${inBase[k]} ${base}`)
        )
    } else if (suffix)
      add(
        `unit ${suffix}`,
        chain.map((v) => String(num(v)))
      )
    else if (single && /^\d{5,}$/.test(single) && joined !== '') continue
    else if (single && /^(?:19|20)\d\d$/.test(single) && joined !== '') add('year', chain)
    else
      add(
        code ? `code ${code}` : '#',
        chain.map((v) => String(num(v)))
      )
  }
  return out
}

/** One value for another: the same, or a bare number matching a measure as written or in its base unit. */
function sameValue(a: string, b: string): boolean {
  if (a === b) return true
  const [ar, ab] = a.split('~')
  const [br, bb] = b.split('~')
  if (ab === undefined && bb === undefined) return false
  if (ab !== undefined && bb !== undefined) return ab === bb
  const bare = ab === undefined ? ar : br
  const measure = ab === undefined ? [br, bb] : [ar, ab]
  return bare === measure[0] || bare === measure[1].split(' ')[0]
}

/**
 * Whether two references contradict each other about which version this is. EAN/GTIN numbers on both sides must
 * share one. Otherwise two references contradict only where they state the same property differently: each carries
 * a value of it the other lacks ("HDF4" against "HDF5", "4 mm" against "5 mm", "model year 2024" against "2025").
 * A property only one side states says nothing ("PRAKTICA 150 l" against "400 x 100 mm axle"), nor does different
 * wording ("500-ml refill pouch, DE 2025" against "500 ml refill pack, Germany 2025"): measured on live runs, a leg
 * that writes a version for every figure would otherwise lock every balance on words, shop numbers and dates.
 */
export function versionsContradict(a: string, b: string): boolean {
  if (gtinsIn(a).length && gtinsIn(b).length) return gtinsDiffer(a, b)
  const fa = versionFeatures(a)
  const fb = versionFeatures(b)
  for (const [key, va] of fa) {
    const vb = fb.get(key)
    if (!vb) continue
    const lacks = (p: Set<string>, q: Set<string>): boolean =>
      [...p].some((v) => ![...q].some((w) => sameValue(v, w)))
    if (lacks(va, vb) && lacks(vb, va)) return true
  }
  return false
}

/**
 * The references the used figures rest on, and whether two of them contradict each other (versionsContradict):
 * different EAN numbers, or the same property stated differently ("HDF4" against "HDF5"). `version` is asked for
 * only where a figure belongs to THIS product, so such a pair is two claims about which product this is — also when
 * only a part names one of the EANs. A leg may still have written a part's own article number there (a spare grip's
 * EAN beside the grips' mass): such an EAN, which no whole-product figure, reported version or recipe names, is listed
 * apart (`unattested`) so the lock can say so. It locks all the same — an unsettled identity gives no verdict.
 */
export function versionsOf(
  items: BomItem[],
  found: ProductMass[],
  seen: VersionSeen[],
  /** Further figures with a version that are not entries — a recipe's formulation. */
  others: Array<{ version?: string; entry: string }> = []
): Versions | undefined {
  const used: Array<{ version: string; entries: string[]; whole: boolean }> = []
  const add = (version: string | undefined, entry: string, whole: boolean): void => {
    if (!version?.trim()) return
    let row = used.find((r) => sameReference(r.version, version))
    if (!row) used.push((row = { version, entries: [], whole: false }))
    if (!row.entries.includes(entry)) row.entries.push(entry)
    row.whole ||= whole
  }
  for (const i of items) add(i.version, i.component, false)
  for (const t of found) add(t.version, `whole product (${t.mass_kg} kg)`, true)
  for (const o of others) add(o.version, o.entry, true)
  const ofProduct = (r: (typeof used)[number]): boolean =>
    r.whole || seen.some((s) => sameReference(s.version, r.version))
  const unattested: Array<{ version: string; entries: string[] }> = []
  let conflict = false
  let otherwise = false
  for (const [i, x] of used.entries())
    for (const y of used.slice(i + 1)) {
      if (!versionsContradict(x.version, y.version)) continue
      conflict = true
      const parts = gtinsDiffer(x.version, y.version) ? [x, y].filter((r) => !ofProduct(r)) : []
      if (!parts.length) otherwise = true
      for (const r of parts)
        if (!unattested.some((u) => u.version === r.version))
          unattested.push({ version: r.version, entries: r.entries })
    }
  const otherSeen: VersionSeen[] = []
  for (const s of seen) {
    const known = [...used.map((r) => r.version), ...otherSeen.map((o) => o.version)]
    if (!known.some((v) => sameReference(v, s.version))) otherSeen.push(s)
  }
  if (!conflict && !otherSeen.length) return undefined
  return {
    conflict,
    ...(conflict ? { used: used.map(({ version, entries }) => ({ version, entries })) } : {}),
    ...(unattested.length ? { unattested } : {}),
    ...(conflict && !otherwise ? { only_part_eans: true as const } : {}),
    ...(otherSeen.length ? { seen: otherSeen.slice(0, 6) } : {})
  }
}
