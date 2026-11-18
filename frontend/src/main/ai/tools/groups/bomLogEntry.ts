/**
 * The entry a research_bom call leaves in the model's research log: the parts it found with a source — each
 * with how its figure was derived —, the ingredients of a researched recipe once per substance, and the check
 * itself: what was summed, which requested components came back without a mass, the whole-product masses found,
 * the versions the figures rest on and whether the recipe closed.
 *
 * Written for every call, also one that found no mass at all. The reviewer compares the model's figures against
 * this log, and what the research could not settle is as much a fact about the study as what it found: a check
 * that left the frame open, or listed 13 and 24 kg for the whole rack, is what a booked 13 kg has to answer to.
 * The backend validates and bounds every field (`research_log.clean_entry`); this only picks them out.
 */
import type { BomResult } from '../../researchBom'
import { contradictionWords } from '../../inciOrder'

/** Whole-product masses and other versions per entry — the backend keeps no more either. */
const TOTALS = 6
const VERSIONS_SEEN = 3

type Item = Record<string, unknown>

/** The part masses the log keeps: entries with a source, in the words the health check reads. */
function partFindings(result: Partial<BomResult>): Item[] {
  // The engine's excerpt behind a cited page, when it supplied one — the table row a mass came from, kept with
  // the figure so a reader can check it without re-opening the page.
  const excerptOf = (url: unknown): string | undefined =>
    (result.evidence ?? []).find((e) => e.url === url && e.excerpt)?.excerpt
  return (result.items ?? [])
    .filter((i) => i.source_url && i.group !== 'recipe')
    .map((i) => {
      const label =
        `${i.component}${i.material ? ` (${i.material})` : ''}` +
        (typeof i.count === 'number' && i.count > 1 ? ` (${i.count} pieces)` : '')
      const shared = {
        sources: [String(i.source_url)],
        ...(excerptOf(i.source_url) ? { excerpt: excerptOf(i.source_url) } : {}),
        ...(i.source_class ? { source_class: String(i.source_class) } : {}),
        ...(i.confidence ? { confidence: String(i.confidence) } : {}),
        // How the leg got the figure ("0.9 × 0.4 × 0.005 m × 850 kg/m³"): "[industry/medium]" does not say
        // that a mass was computed rather than read off a page.
        ...(i.note ? { note: String(i.note) } : {}),
        // Which version of the product the figure belongs to — kept on every part, not only when the call
        // itself found its figures on different versions: the next call may find the other one.
        ...(i.version ? { version: String(i.version) } : {}),
        ...(typeof i.cited_by_search === 'boolean' ? { cited_by_search: i.cited_by_search } : {})
      }
      // An entry whose figure contains other listed entries is kept as what was found, but not as a mass the
      // model has to book: booking it whole beside them counts them twice. The contained entries stay booking
      // duties, so the health check still names them when nothing books them. Without the structured fields,
      // and with a text that does not end on the mass, the check does not read the container as a component.
      if (Array.isArray(i.contains_listed) && i.contains_listed.length)
        return {
          text:
            `${label}: ${i.mass_kg} kg — contains ${i.contains_listed.join(', ')}, listed separately, ` +
            'so not a mass to book whole',
          ...shared
        }
      return {
        text: `${label}: ${i.mass_kg} kg`,
        ...shared,
        // Structured on purpose: the health check reconciles these masses against what the model actually
        // books (bom_item_unbooked), and the report can weigh a figure by its source class — neither works on
        // prose alone. The mass is the whole set's.
        component: String(i.component ?? ''),
        ...(typeof i.mass_kg === 'number' ? { mass_kg: i.mass_kg } : {}),
        ...(Array.isArray(i.mass_range_kg) ? { mass_range_kg: i.mass_range_kg } : {})
      }
    })
}

const MIX_SOURCES = 5

/**
 * A recipe's ingredients, once per substance: water added and water of a surfactant solution are two contributions
 * in the result, but one mass the model books — logged apart, the health check would name the smaller one as never
 * booked. Without a mass, the shares go in as text the health check does not read.
 */
function recipeFindings(result: Partial<BomResult>): Item[] {
  const mix = result.recipe
  if (!mix) return []
  const of = `recipe of ${mix.of}${mix.formulation ? ` (${mix.formulation.name})` : ''}`
  const kg = (result.items ?? []).filter((i) => i.group === 'recipe')
  if (kg.length) {
    const bySubstance = new Map<string, typeof kg>()
    for (const i of kg) {
      const key = i.component.trim().toLowerCase()
      bySubstance.set(key, [...(bySubstance.get(key) ?? []), i])
    }
    return [...bySubstance.values()].map((parts) => {
      const mass = Number(parts.reduce((s, i) => s + i.mass_kg, 0).toFixed(6))
      const share = Number(parts.reduce((s, i) => s + (i.share_pct ?? 0), 0).toFixed(2))
      const sources = [...new Set(parts.map((i) => i.source_url).filter((u): u is string => !!u))]
      const from = parts.map((i) =>
        i.from_trade_form ? `${i.mass_kg} kg from ${i.from_trade_form}` : `${i.mass_kg} kg as dosed`
      )
      const first = parts[0]
      return {
        text: `${first.component} (${share} %): ${mass} kg`,
        sources: sources.slice(0, MIX_SOURCES),
        ...(first.source_class ? { source_class: first.source_class } : {}),
        ...(first.confidence ? { confidence: first.confidence } : {}),
        note: `${of}${parts.length > 1 ? `; ${from.join(' + ')}` : ''}`,
        component: first.component,
        mass_kg: mass
      }
    })
  }
  return mix.lines
    .filter((l) => l.share_pct !== undefined)
    .map((l) => ({
      text: `${l.name}: ${l.share_pct} % of ${mix.of}`,
      sources: [l.source_url ?? mix.formulation?.source_url].filter((u): u is string => !!u),
      note: of
    }))
}

/** What the call itself reported about its result — none of it a finding the health check reads. */
function bomCheck(result: Partial<BomResult>): Item {
  const versions = result.versions
  return {
    summary: result.summary,
    requests: result.requests,
    unresolved: (result.unresolved ?? []).map((u) => ({
      component: u.component,
      reason: u.reason,
      ...(u.note ? { note: u.note } : {})
    })),
    totals: (result.totals_found ?? []).slice(0, TOTALS).map((t) => ({
      mass_kg: t.mass_kg,
      basis: t.basis,
      ...(t.version ? { version: t.version } : {}),
      ...(t.source_url ? { source: t.source_url } : {})
    })),
    ...(versions
      ? {
          versions: {
            conflict: versions.conflict,
            ...(versions.used ? { used: versions.used } : {}),
            ...(versions.seen
              ? {
                  seen: versions.seen.slice(0, VERSIONS_SEEN).map((s) => ({
                    version: s.version,
                    ...(s.differs_by ? { differs_by: s.differs_by } : {}),
                    ...(typeof s.mass_kg === 'number' ? { mass_kg: s.mass_kg } : {}),
                    ...(s.sold_by ? { sold_by: s.sold_by } : {}),
                    ...(s.source_url ? { source: s.source_url } : {})
                  }))
                }
              : {})
          }
        }
      : {}),
    ...(result.recipe ? { recipe: recipeCheck(result.recipe) } : {})
  }
}

/** The recipe's own check: closed or not, by how much, against what, what it lacks, where it contradicts the INCI list. */
function recipeCheck(mix: NonNullable<BomResult['recipe']>): Item {
  return {
    of: mix.of,
    ...(mix.formulation
      ? {
          formulation: mix.formulation.name,
          kind: mix.formulation.kind,
          ...(mix.formulation.source_url ? { source: mix.formulation.source_url } : {})
        }
      : {}),
    closes: mix.closes,
    note: mix.closes_note,
    ...(mix.gap_pct !== undefined ? { gap_pct: mix.gap_pct } : {}),
    ...(mix.gap_kg !== undefined ? { gap_kg: mix.gap_kg } : {}),
    ...(mix.reachable_by_ranges !== undefined ? { reachable_by_ranges: mix.reachable_by_ranges } : {}),
    ...(mix.mass_kg !== undefined ? { mass_kg: mix.mass_kg, mass_source: mix.mass_source } : {}),
    ...(mix.missing_ingredients ? { missing_ingredients: mix.missing_ingredients } : {}),
    ...(mix.split ? { split: mix.split } : {}),
    ...(mix.inci_order?.contradictions.length
      ? { inci_order: mix.inci_order.contradictions.map(contradictionWords) }
      : {})
  }
}

/**
 * The log entry for one research_bom call, or null when the call returned no check to log (an error answer).
 * `context` is what the research was given besides the product: a given total mass first, because it is the one
 * figure the check was made against.
 */
export function bomLogEntry(
  call: { product: string; context?: string; totalMassKg?: number },
  result: Partial<BomResult> | null | undefined
): Item | null {
  if (!result || (typeof result.summary !== 'string' && !Array.isArray(result.items))) return null
  const context = [
    typeof call.totalMassKg === 'number' ? `total mass given: ${call.totalMassKg} kg` : '',
    call.context?.trim() ?? ''
  ]
    .filter(Boolean)
    .join('; ')
  return {
    question: `Bill of materials: ${call.product}`,
    ...(context ? { context } : {}),
    findings: [...partFindings(result), ...recipeFindings(result)],
    bom_check: bomCheck(result)
  }
}
