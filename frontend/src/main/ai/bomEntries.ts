/**
 * What one research leg's entries stand for, read before anything is summed: a name that comes back twice with the
 * same mass is one entry, with different masses a contradiction — unless each names a different material, which
 * makes them parts; other figures for the same part are documented beside it, never summed; and a requested
 * component that came back as several summed entries is shown with its entries side by side, since only the reader
 * can tell parts of it from figures of it — a hint, not a lock. Pure, like the weighing it feeds (bomBalance.ts).
 */
import { alternativeWords, type BomItem, type BomLeg, type UnresolvedComponent } from './bomAnswer'

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
/** Two figures for one part that agree within 2 % are one figure reported twice. */
const close2 = (a: number, b: number): boolean => Math.abs(a - b) <= 0.02 * Math.max(a, b)

const nameOf = (i: BomItem): string => norm(i.component)
const materialOf = (i: BomItem): string => norm(i.material ?? '')

/** The entries of one leg grouped by name, in the order they came. */
function byName(items: BomItem[]): BomItem[][] {
  const groups = new Map<string, BomItem[]>()
  for (const i of items) groups.set(nameOf(i), [...(groups.get(nameOf(i)) ?? []), i])
  return [...groups.values()]
}

/**
 * The parts one name stands for. Two entries of one name are the same part unless each names its material and both
 * material and mass differ — a door's packaging as cardboard 1.15 kg, film 0.03 kg and tape 0.01 kg is three parts,
 * as the leg is told to list a part of several materials. An entry without a material, one material twice, or one
 * mass twice under two wordings of its material ("PUR hot-melt" and "PUR adhesive", both 0.5 kg) joins the part, its
 * figures a repeat or a contradiction. Order is kept: a part stands where its first entry stood.
 */
function partsOf(named: BomItem[]): BomItem[][] {
  const same = (a: BomItem, b: BomItem): boolean =>
    !materialOf(a) || !materialOf(b) || materialOf(a) === materialOf(b) || close2(a.mass_kg, b.mass_kg)
  const parts: BomItem[][] = []
  for (const i of named) {
    const joined = parts.filter((p) => p.some((o) => same(i, o)))
    if (!joined.length) parts.push([i])
    else {
      joined[0].push(...joined.slice(1).flat(), i)
      for (const p of joined.slice(1)) parts.splice(parts.indexOf(p), 1)
    }
  }
  return parts
}

/**
 * One request, one name and material, one entry: the follow-up pass answered "Glycerin" again beside the first
 * answer, and a leg listed a part both with a mass and as a null entry. A repeat with the same mass (all figures
 * within 2 % of each other) is dropped and named; the same part with different masses is no repeat but a
 * contradiction — its figures go to unresolved as unclear, none is chosen. A null entry of that part is dropped only
 * when it carries no figures of its own (no_mass, zero_mass); an unclear one stays, so its contradiction stays
 * visible.
 */
export function onePerName(leg: BomLeg): { leg: BomLeg; repeats: string[] } {
  const items: BomItem[] = []
  const unclear: UnresolvedComponent[] = []
  const repeats: string[] = []
  const names = new Map(
    byName(leg.items).map((named) => [nameOf(named[0]), { named, parts: partsOf(named) }])
  )
  for (const group of [...names.values()].flatMap((n) => n.parts)) {
    const first = group[0]
    const masses = group.map((i) => i.mass_kg)
    if (close2(Math.min(...masses), Math.max(...masses))) {
      items.push(first)
      if (group.length > 1) repeats.push(`"${first.component}"`)
    } else
      unclear.push({
        component: first.component,
        ...(first.material ? { material: first.material } : {}),
        reason: 'unclear_mass',
        note: `Came back ${group.length} times with different masses: ${group.map((i) => `${i.mass_kg} kg`).join(', ')} — no figure is preferred.`
      })
  }
  // A null entry is a part the measured entries of its name already answer, by the rule that tells their parts
  // apart: one naming its material is answered by an entry of that material or of none; one naming no material only
  // when the name came back as a single part — beside several, there is no telling which.
  const answered = (u: UnresolvedComponent): boolean => {
    const n = names.get(norm(u.component))
    if (!n) return false
    const material = norm(u.material ?? '')
    return material ? n.named.some((i) => !materialOf(i) || materialOf(i) === material) : n.parts.length === 1
  }
  const unresolved = [
    ...leg.unresolved.filter((u) => !(answered(u) && (u.reason === 'no_mass' || u.reason === 'zero_mass'))),
    ...unclear
  ]
  return items.length !== leg.items.length || unresolved.length !== leg.unresolved.length
    ? { leg: { ...leg, items, unresolved }, repeats }
    : { leg, repeats }
}

/**
 * A requested component that came back as several entries with a mass, all of them summed. They may be parts of it
 * (a tyre, its tube and its valve) or figures of it (two variants of one pouch, a second source) — which, only the
 * reader can tell, so the entries are named side by side with what the sum does with them. Also when the leg wrote
 * alternatives elsewhere: using the field once says nothing about the entries beside it.
 */
export function severalEntries(request: string, leg: BomLeg): string | undefined {
  if (leg.items.length < 2) return undefined
  return `"${request}" came back as ${leg.items.length} entries, all counted: ${entriesWords(leg.items)}${COUNTED_TWICE}`
}

/**
 * The same question for the leg that enumerates the components itself, where no request groups the entries: a name
 * that came back as several entries of different materials, all counted.
 */
export function sameNameEntries(leg: BomLeg): string[] {
  return byName(leg.items)
    .filter((named) => named.length > 1)
    .map(
      (named) =>
        `"${named[0].component}" came back as ${named.length} entries of different materials, all counted: ` +
        `${entriesWords(named)}${COUNTED_TWICE}`
    )
}

const COUNTED_TWICE =
  ' — if one is another figure for the same part (a variant, another source) rather than a further part of it, ' +
  'that part is counted twice.'

/** Entries side by side; one that shares its name with another is told apart by its material. */
const entriesWords = (items: BomItem[]): string =>
  items
    .map((i) => {
      const twin = items.some((o) => o !== i && nameOf(o) === nameOf(i))
      return `"${i.component}"${twin && i.material ? ` (${i.material})` : ''} ${i.mass_kg} kg`
    })
    .join(', ')

/** The other figures the legs gave for their parts, named once: none of them is in the sum. */
export function alternativesNote(items: BomItem[]): string | undefined {
  const withAlternatives = items.filter((i) => i.alternatives?.length)
  if (!withAlternatives.length) return undefined
  return (
    'Other figures the research found for the same part, not counted: ' +
    withAlternatives
      .map(
        (i) =>
          `"${i.component}" ${(i.alternatives ?? []).map(alternativeWords).join(', ')} ` +
          `(counted: ${i.mass_kg} kg)`
      )
      .join('; ') +
    ' — each entry counts the figure the research would model with, and its note says why; if the product is ' +
    'another of these, book that figure instead.'
  )
}
