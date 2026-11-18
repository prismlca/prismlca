/**
 * The entry a research_bom call leaves in the model's research log: the parts it found with a source — each
 * with how its figure was derived — and the check itself: what was summed, which requested components came back
 * without a mass, the whole-product masses found and the versions the figures rest on.
 *
 * Written for every call, also one that found no mass at all. The reviewer compares the model's figures against
 * this log, and what the research could not settle is as much a fact about the study as what it found: a check
 * that left the frame open, or listed 13 and 24 kg for the whole rack, is what a booked 13 kg has to answer to.
 * The backend validates and bounds every field (`research_log.clean_entry`); this only picks them out.
 */
import type { BomResult } from '../../researchBom'

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
    .filter((i) => i.source_url)
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
    findings: partFindings(result),
    bom_check: bomCheck(result)
  }
}
