/**
 * The whole-product masses a bill-of-materials research found: one list of them, the one the balance may check the
 * parts against — or why there is none: two versions, two figures for one version, two scopes — and the parts that
 * outweigh a whole-product figure of their own version. Pure, like the weighing it feeds (bomBalance.ts): nothing
 * here chooses between two figures that disagree.
 */
import type { BomItem, ProductMass } from './bomAnswer'
import { gtinsIn, sameReference, versionsContradict } from './bomVersions'

/** The whole-product mass the balance was checked against, and where it came from. */
export interface TotalUsed {
  mass_kg: number
  basis: 'net' | 'gross' | 'unknown'
  /** `given`: the caller passed it (declared as the product without packaging); `researched`: a leg found it. */
  source: 'given' | 'researched'
  source_url?: string
  version?: string
}

/** Whole-product masses this close count as one figure (rounding, 13 vs 13.0), never as confirmation. */
const SAME_TOTAL = 0.01

const close = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_TOTAL * Math.max(a, b)
const host = (url?: string): string | undefined => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : undefined
  } catch {
    return undefined
  }
}

/** A total's scope in words a reader does not have to decode. */
const SCOPE: Record<TotalUsed['basis'], string> = {
  net: 'without packaging',
  gross: 'with sales packaging',
  unknown: 'packaging not stated'
}

/** "13 kg (packaging not stated, praxis.nl, EAN …)" — a whole-product mass with its reference. */
export const massWords = (t: {
  mass_kg: number
  basis: TotalUsed['basis']
  source_url?: string
  version?: string
}): string =>
  `${t.mass_kg} kg (${[SCOPE[t.basis], host(t.source_url), t.version].filter(Boolean).join(', ')})`

/** Whole-product masses as one list: the same figure for the same reference, reported by several legs, is kept
 *  once. */
export function totalsOf(found: ProductMass[]): ProductMass[] {
  const out: ProductMass[] = []
  for (const p of found)
    if (
      !out.some(
        (o) =>
          o.basis === p.basis &&
          close(o.mass_kg, p.mass_kg) &&
          // A reference on one side only, from the same page's host, is the same figure reported again; two
          // different references never merge, whatever the host.
          (sameReference(o.version, p.version) ||
            ((!o.version?.trim() || !p.version?.trim()) &&
              !!host(o.source_url) &&
              host(o.source_url) === host(p.source_url)))
      )
    )
      out.push(p)
  return out
}

/**
 * The researched total the balance may use: only when every whole-product mass found shares one reference and
 * one scope and the figures agree. Grouping comes first and agreement second — two equally heavy versions, or a
 * net and a gross weight, are not one figure because their numbers happen to match. Otherwise the reason, as a lock:
 * figures of two versions ask which product the user means, two figures for one product ask which source is right,
 * a net and a gross figure only which to pass — named apart, since the second is the usual case (a wheelbarrow at 19,
 * 20.7 and 22.5 kg on three shop pages) and calling it "different references" sent the chat after a version question
 * that was not there.
 */
export function researchedTotal(totals: ProductMass[]): TotalUsed | string | undefined {
  if (!totals.length) return undefined
  // A source that does not say (unknown) contradicts neither net nor gross — three legs read 20.7 kg for the same
  // EAN off two shop pages, once "net" and twice unstated, and that is one figure.
  const bases = new Set(totals.map((p) => p.basis).filter((b) => b !== 'unknown'))
  const pairs = totals.flatMap((p, i) => totals.slice(i + 1).map((q) => [p, q] as const))
  const versionsApart = pairs.some(
    ([p, q]) => !!p.version && !!q.version && versionsContradict(p.version, q.version)
  )
  // Two figures of one scope (or one unstated) that differ are two answers to one question; a net and a gross figure
  // differ by the packaging and contradict nothing.
  // A gross figure below a net one is no matter of scope: packaging cannot weigh less than nothing.
  const inverted = (p: ProductMass, q: ProductMass): boolean =>
    p.basis === 'net' && q.basis === 'gross' && q.mass_kg < p.mass_kg * (1 - SAME_TOTAL)
  const massesApart = pairs.some(
    ([p, q]) =>
      ((p.basis === q.basis || p.basis === 'unknown' || q.basis === 'unknown') &&
        !close(p.mass_kg, q.mass_kg)) ||
      inverted(p, q) ||
      inverted(q, p)
  )
  if (bases.size <= 1 && !versionsApart && !massesApart) {
    // The reference the total is named by: an EAN where one is given. Only figures that name that same reference
    // may lend it their scope — a net weight from a page that names no product says nothing about this EAN's.
    const ref =
      totals.find((p) => p.version && gtinsIn(p.version).length) ?? totals.find((p) => p.version?.trim())
    const attributed = ref
      ? totals.filter((p) => p.version?.trim() && sameReference(p.version, ref.version))
      : totals
    const known = attributed.find((p) => p.basis !== 'unknown')
    const best = known ?? ref ?? totals[0]
    return {
      mass_kg: best.mass_kg,
      basis: known ? known.basis : 'unknown',
      source: 'researched',
      ...(best.source_url ? { source_url: best.source_url } : {}),
      ...(ref?.version ? { version: ref.version } : {})
    }
  }
  const listed = totals.map(massWords).join(', ')
  if (versionsApart)
    return (
      `the whole-product masses the research found belong to different versions of the product: ${listed} — settle ` +
      "which one is the user's product (ask, or open the sources) and pass its mass as total_mass_kg"
    )
  if (massesApart)
    return (
      `the sources give different whole-product masses, and no version tells them apart: ${listed} — settle which ` +
      "figure holds for the user's product (ask, or open the sources) and pass it as total_mass_kg"
    )
  return (
    `the sources give the whole-product mass without packaging and with it: ${listed} — if they name the user's ` +
    'product, pass the mass without packaging as total_mass_kg'
  )
}

/**
 * Parts that weigh more than a whole-product figure the research found for their own version: impossible as the
 * figures stand — the part's is wrong, the whole product's is, or they belong to different versions. A live run
 * booked 17 kg for a rack's frame whose EAN weighs 14.1 kg whole (the frame was 24 kg of another listing less the
 * shelves, a residual written as a part). Named, never a lock: the figure is in the sum and the balance judges it.
 * A whole-product figure naming another version is not held against the part, nor the total the balance checks
 * against — its own checks name a part as heavy as that.
 */
export function heavierThanWhole(
  parts: BomItem[],
  totals: ProductMass[],
  used?: TotalUsed
): string | undefined {
  const found = parts.flatMap((p) => {
    const lighter = totals
      .filter(
        (t) =>
          p.mass_kg > t.mass_kg * (1 + SAME_TOTAL) &&
          !(used && close(t.mass_kg, used.mass_kg)) &&
          !(p.version && t.version && versionsContradict(p.version, t.version))
      )
      // The figure of the part's own reference first, then the lightest: the claim the part contradicts most directly.
      .sort(
        (a, b) =>
          Number(!sameReference(p.version, a.version)) - Number(!sameReference(p.version, b.version)) ||
          a.mass_kg - b.mass_kg
      )[0]
    return lighter ? [`"${p.component}" (${p.mass_kg} kg) against ${massWords(lighter)}`] : []
  })
  if (!found.length) return undefined
  return (
    `A part weighs more than a whole-product figure the research found that names no other version: ${found.join('; ')} — a part ` +
    'cannot outweigh the whole: its figure is wrong, the whole-product figure is, or they belong to different ' +
    'versions. Settle that before modelling either.'
  )
}
