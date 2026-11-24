/** Shared shape of an LCIA method entry as served by GET /calc/methods. */
export interface MethodEntry {
  method: string[]
  name: string
  unit: string
  recommended?: boolean
}

/** Group methods by family (`method[0]`), preserving the backend's method order both for the
 * family names (insertion order) and within each family. Views derive what they need from the
 * map: `[...map.keys()]` for the family picker, `map.get(family) ?? []` for its indicators. */
export function groupMethodsByFamily<M extends { method: string[] }>(methods: M[]): Map<string, M[]> {
  const map = new Map<string, M[]>()
  for (const m of methods) {
    const fam = m.method[0]
    const list = map.get(fam)
    if (list) list.push(m)
    else map.set(fam, [m])
  }
  return map
}

/**
 * Indicators a new report starts with — and, its first one, the method the Model page calculates with
 * until somebody chooses one there.
 *
 * The old rule — the first four `recommended` entries of the catalogue — is alphabetical by family, so
 * every report began on CML v4.8 2016 with acidification and two ecotoxicity variants. Nothing was
 * wrong with the mechanism and everything with the result: a study whose scope says EF v3.1 got seven
 * chapters written against a different method family, with no warning anywhere.
 *
 * So: prefer the newest EF family (the European reference method, and the one a footprint study is
 * normally asked for), and within it a core set of five, climate change first — enough categories for a
 * report to compare variants across (its radar needs more than three axes), small enough to stay
 * readable. Every new report covers at least these; the Results page's picks come on top (`prefill.ts`).
 * Falls back to the old behaviour when no EF family is installed.
 */
const PREFERRED_INDICATORS = [
  'climate change',
  'acidification',
  'eutrophication: freshwater',
  'energy resources: non-renewable',
  'water use'
]

export function defaultReportMethods<M extends { method: string[]; recommended?: boolean }>(
  methods: M[]
): string[][] {
  const families = [...new Set(methods.map((m) => m.method[0]))].filter(
    (f) => /^EF v?\d/i.test(f) && !/no LT/i.test(f)
  )
  // Numeric-aware: plain sort() puts "EF v3.10" below "EF v3.9" the day a two-digit minor exists.
  const family = families.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
  if (family) {
    const inFamily = methods.filter((m) => m.method[0] === family && m.recommended)
    const picked = PREFERRED_INDICATORS.map((want) =>
      inFamily.find((m) => (m.method[1] ?? '').toLowerCase() === want)
    ).filter((m): m is M => Boolean(m))
    if (picked.length) return picked.map((m) => m.method)
  }
  const recommended = methods.filter((m) => m.recommended).slice(0, 4)
  return (recommended.length ? recommended : methods.slice(0, 1)).map((m) => m.method)
}

/** A method's path form — the same string the backend carries as `method_label`. */
export const methodPath = (method: string[]): string => method.join(' / ')

/**
 * What each indicator is called: `method[1]` where the family gives that name to one indicator, and
 * everything below the family where it does not.
 *
 * `EF v3.1` has one climate change, so `('EF v3.1', 'climate change', 'global warming potential
 * (GWP100)')` is "climate change" and the third part is a technicality. `ReCiPe 2016 v1.03, endpoint
 * (H)` has twelve indicators under three damage categories, so there `method[1]` is not a name at all:
 * the picker offered twelve rows reading "★ ecosystem quality · species.yr", without a tooltip, and two
 * chips whose × buttons removed different things (V203).
 *
 * Decided per family and against **every** indicator that family has — pass the whole catalogue, not
 * the filtered rows and not the selection. A name that grew when a sibling was ticked would move under
 * the reader, and the document says the same thing about the same indicator
 * (`report_typst.indicator_labels`).
 */
export function indicatorLabels<M extends { method: string[] }>(methods: M[]): Map<string, string> {
  // (family, category) -> the distinct paths answering to it. Distinct, so the same method arriving
  // twice is not mistaken for two indicators sharing a name.
  const kin = new Map<string, Set<string>>()
  for (const m of methods) {
    if (m.method.length < 2) continue
    const key = JSON.stringify([m.method[0], m.method[1]])
    const paths = kin.get(key)
    if (paths) paths.add(methodPath(m.method))
    else kin.set(key, new Set([methodPath(m.method)]))
  }
  const out = new Map<string, string>()
  for (const m of methods) {
    if (m.method.length < 2) continue
    const alone = (kin.get(JSON.stringify([m.method[0], m.method[1]]))?.size ?? 1) < 2
    out.set(methodPath(m.method), alone ? m.method[1] : m.method.slice(1).join(' / '))
  }
  return out
}

/** One indicator's name, given the map `indicatorLabels` built — its own middle segment without one. */
export function indicatorLabel(method: string[], labels?: Map<string, string>): string {
  return labels?.get(methodPath(method)) ?? method[1] ?? method[0] ?? ''
}

/**
 * The name a copy of an indicator starts with in a family of one's own. A copy is `(family, name)`, so
 * its name has to carry everything that told the indicator apart: what `indicatorLabel` calls it, with
 * the parts joined by a dash. Not by " / " — that is the separator of a method's path, and a name holding
 * it reads back as category and indicator wherever a path is split again: the report would print two
 * copies of one climate category under the same short name. Not by a comma either: categories carry
 * their own ("climate change: biogenic, including SLCFs").
 */
export function copyName(method: string[], labels?: Map<string, string>): string {
  const label = indicatorLabel(method, labels)
  return method.length > 2 && label !== method[1] ? method.slice(1).join(' – ') : label
}

/**
 * The family an indicator picker opens on. The one it already shows, if that holds a picked indicator or
 * nothing is picked — a family someone was browsing stays put. Otherwise the family of the first picked
 * indicator: opening on a family with nothing ticked reads as "nothing selected" beside a row of chips.
 */
export function familyToOpen(current: string, pickedFamilies: string[], familyNames: string[]): string {
  const known = pickedFamilies.filter((f) => familyNames.includes(f))
  return !known.length || known.includes(current) ? current : known[0]
}
