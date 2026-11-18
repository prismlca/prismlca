/**
 * What one research leg's entries stand for, read before anything is summed: a name that comes back twice with the
 * same mass is one entry, with different masses a contradiction; other figures for the same part are documented
 * beside it, never summed; and a requested component that came back as several summed entries is shown with its
 * entries side by side, since only the reader can tell parts of it from figures of it — a hint, not a lock. Pure,
 * like the weighing it feeds (bomBalance.ts).
 */
import { alternativeWords, type BomItem, type BomLeg, type UnresolvedComponent } from './bomAnswer'

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
/** Two figures for one part that agree within 2 % are one figure reported twice. */
const close2 = (a: number, b: number): boolean => Math.abs(a - b) <= 0.02 * Math.max(a, b)

/**
 * One request, one name, one entry: the follow-up pass answered "Glycerin" again beside the first answer, and a leg
 * listed a part both with a mass and as a null entry. A repeat with the same mass (2 %) is dropped and named; the
 * same name with different masses is no repeat but a contradiction — both figures go to unresolved as unclear, none
 * is chosen. A null entry of that name is dropped only when it carries no figures of its own (no_mass, zero_mass);
 * an unclear one stays, so its contradiction stays visible.
 */
export function onePerName(leg: BomLeg): { leg: BomLeg; repeats: string[] } {
  const byName = new Map<string, BomItem[]>()
  for (const i of leg.items) byName.set(norm(i.component), [...(byName.get(norm(i.component)) ?? []), i])
  const items: BomItem[] = []
  const unclear: UnresolvedComponent[] = []
  const repeats: string[] = []
  for (const group of byName.values()) {
    const first = group[0]
    if (group.every((i) => close2(i.mass_kg, first.mass_kg))) {
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
  const named = new Set(items.map((i) => norm(i.component)))
  const unresolved = [
    ...leg.unresolved.filter(
      (u) => !(named.has(norm(u.component)) && (u.reason === 'no_mass' || u.reason === 'zero_mass'))
    ),
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
  return (
    `"${request}" came back as ${leg.items.length} entries, all counted: ` +
    leg.items.map((i) => `"${i.component}" ${i.mass_kg} kg`).join(', ') +
    ' — if one is another figure for the same part (a variant, another source) rather than a further part of it, ' +
    'that part is counted twice.'
  )
}

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
