/**
 * What the stacked bars are split by: `isic`, `cpc` or `tag:<family>`.
 *
 * Stored per model (view section `results`, field `stackBy`), because the tag families it can name belong
 * to the model. An empty value means nobody has chosen yet, and then the split follows the model: a tag
 * family its processes carry — the structure the study itself drew (phases, components) — before ISIC,
 * which every dataset has but nobody modelled. The Results page, the report prefill and the assistant's
 * `setup_results` all resolve it here, so the three agree on what "not chosen" shows.
 */
import type { TagGroup } from '../../lib/server/routes'

/** Tag families some process of these databases carries, in the project's order. */
export function familiesInUse(groups: TagGroup[], dbs: Set<string>): TagGroup[] {
  return groups.filter((g) => (g.databases ?? []).some((d) => dbs.has(d)))
}

/** The split in effect for `model`: the stored choice, else its first tag family in use, else ISIC. */
export function resolveSplit(stored: string | undefined, groups: TagGroup[], model: string | null): string {
  if (stored) return stored
  const own = model ? familiesInUse(groups, new Set([model])) : []
  return own.length ? `tag:${own[0].name}` : 'isic'
}
