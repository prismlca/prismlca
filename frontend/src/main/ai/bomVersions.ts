/**
 * Which version of a product a bill-of-materials figure belongs to: EAN/GTIN numbers and the other numbers in a
 * reference (a board thickness, a model number), whether two references name one version or contradict each
 * other, and which references the figures of one research call rest on. Grouping what the sources said, never
 * verifying it.
 */
import type { BomItem, ProductMass, VersionSeen } from './bomAnswer'

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()

export interface Versions {
  /** Figures that claim to be this product's own name different versions (by EAN or by words). */
  conflict: boolean
  /** The product references the entries and whole-product masses rest on, when there is more than one. */
  used?: Array<{ version: string; entries: string[] }>
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

/**
 * Whether two references contradict each other about which version this is. EAN/GTIN numbers on both sides must
 * share one. Otherwise only the numbers count — a board thickness, a model number, a size ("HDF4", "4 mm", "175"):
 * they contradict when each side carries one the other lacks. Different wording of the same product does not
 * ("500-ml refill pouch, DE 2025" against "500 ml refill pack, Germany 2025"): measured on a live run, a leg that
 * writes a version for every figure would otherwise lock every balance on words alone.
 */
export function versionsContradict(a: string, b: string): boolean {
  const ga = gtinsIn(a)
  const gb = gtinsIn(b)
  if (ga.length && gb.length) return !ga.some((g) => gb.includes(g))
  // The numbers in the words, split off their letters ("HDF4" and "HDF 4 mm" both give 4); single digits count.
  const tokens = (v: string): string[] =>
    norm(v)
      .split(/[^\p{L}\p{N}]+|(?<=\p{L})(?=\d)|(?<=\d)(?=\p{L})/u)
      .filter((w) => /^\d+$/.test(w) && !gtinsIn(w).length)
  const year = (w: string): boolean => /^(19|20)\d\d$/.test(w)
  const ta = tokens(a)
  const tb = tokens(b)
  // A year counts only when both sides carry one: "model year 2024" against "2025" are two versions, but
  // "reference year 2025" against an article number was a false conflict in a live run.
  const bothYears = ta.some(year) && tb.some(year)
  const na = ta.filter((w) => bothYears || !year(w))
  const nb = tb.filter((w) => bothYears || !year(w))
  return na.some((w) => !nb.includes(w)) && nb.some((w) => !na.includes(w))
}

/**
 * The references the used figures rest on, and whether two of them contradict each other (versionsContradict):
 * different EAN numbers, or numbers in the words that cannot both hold ("HDF4" against "HDF5"). `version` is asked
 * for only where a figure belongs to THIS product, so such a pair is two claims about which product this is.
 */
export function versionsOf(
  items: BomItem[],
  found: ProductMass[],
  seen: VersionSeen[],
  /** Further figures with a version that are not entries — a recipe's formulation. */
  others: Array<{ version?: string; entry: string }> = []
): Versions | undefined {
  const used: Array<{ version: string; entries: string[] }> = []
  const add = (version: string | undefined, entry: string): void => {
    if (!version?.trim()) return
    let row = used.find((r) => sameReference(r.version, version))
    if (!row) used.push((row = { version, entries: [] }))
    if (!row.entries.includes(entry)) row.entries.push(entry)
  }
  for (const i of items) add(i.version, i.component)
  for (const t of found) add(t.version, `whole product (${t.mass_kg} kg)`)
  for (const o of others) add(o.version, o.entry)
  const conflict = used.some((x, i) =>
    used.slice(i + 1).some((y) => versionsContradict(x.version, y.version))
  )
  const otherSeen: VersionSeen[] = []
  for (const s of seen) {
    const known = [...used.map((r) => r.version), ...otherSeen.map((o) => o.version)]
    if (!known.some((v) => sameReference(v, s.version))) otherSeen.push(s)
  }
  if (!conflict && !otherSeen.length) return undefined
  return {
    conflict,
    ...(conflict ? { used } : {}),
    ...(otherSeen.length ? { seen: otherSeen.slice(0, 6) } : {})
  }
}
