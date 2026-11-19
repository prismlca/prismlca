/**
 * The INDICATORS section of the review dossier: every indicator scored for the model — in this chat
 * (advice/scored.ts) or picked on its Results page — and which one the hotspot analysis covers.
 *
 * Without it the dossier named one method, the one handed to the hotspot analysis. A reviewer told only
 * about climate change, in a run that had scored eight indicators, judged the study's goal ("potential
 * environmental impacts") too broad for a single indicator, and the assistant narrowed the goal to match.
 */
import { scoredKey } from '../advice/scored'

/** Above this the list is cut; one whole method family stays below it. */
const MAX_LISTED = 40

const isTuple = (m: unknown): m is string[] =>
  Array.isArray(m) && m.length > 0 && m.every((x) => typeof x === 'string' && x.trim() !== '')

/** The indicators picked on the model's Results page, from its stored view (GET /views/{database}). */
export function pickedMethods(view: unknown): string[][] {
  const picked = (view as { view?: { results?: { picked?: unknown } } } | null)?.view?.results?.picked
  if (!Array.isArray(picked)) return []
  return picked
    .map((p) => (p && typeof p === 'object' ? (p as { method?: unknown }).method : null))
    .filter(isTuple)
}

/**
 * The dossier section, or '' when nothing at all is known to have been scored. `scored` is the run's
 * record for this model (key → label, see noteScored); `hotspotMethod` the method the hotspot analysis
 * ran for, if any.
 */
export function indicatorsSection(
  scored: Map<string, string>,
  picked: string[][],
  hotspotMethod: string[] | null
): string {
  const all = new Map(scored)
  for (const m of picked) all.set(scoredKey(m), m.join(' | '))
  const hotKey = hotspotMethod && isTuple(hotspotMethod) ? scoredKey(hotspotMethod) : null
  if (hotKey && hotspotMethod && !all.has(hotKey)) all.set(hotKey, hotspotMethod.join(' | '))
  if (!all.size) return ''
  if (all.size === 1 && hotKey && all.has(hotKey))
    return (
      `INDICATORS: ${all.get(hotKey)} is the only indicator scored for this model in this chat or ` +
      'picked on its Results page.'
    )
  const entries = [...all]
  const listed = entries
    .slice(0, MAX_LISTED)
    .map(([k, label]) => `- ${label}${k === hotKey ? '  ← the hotspot analysis above' : ''}`)
  if (entries.length > MAX_LISTED) listed.push(`- … and ${entries.length - MAX_LISTED} more`)
  return (
    'INDICATORS SCORED FOR THIS MODEL (in this chat, or picked on its Results page). ' +
    // Said as this dossier's limit: told only that the others "are not broken down", a reviewer turned
    // the missing breakdown into a finding about the study.
    (hotKey
      ? 'This review breaks down one indicator, the one marked; that the others have no hotspot list ' +
        'here says nothing about the study'
      : 'This review has no hotspot analysis, so none of them is broken down here') +
    ' — judge the choice of indicators against the whole list:\n' +
    listed.join('\n')
  )
}
