/**
 * What the stacked bars are split by: `isic`, `cpc` or `tag:<family>`.
 *
 * Stored per model (view section `results`, field `stackBy`), because the tag families it can name belong
 * to the model. An empty value means nobody has chosen yet, and then the split follows the model: a tag
 * family its processes carry — the structure the study itself drew (phases, components) — before ISIC,
 * which every dataset has but nobody modelled. The Results page, the report prefill and the assistant's
 * `setup_results` all resolve it here, so the three agree on what "not chosen" shows.
 */
import type { TagFamily } from '../../lib/server/routes'

/** The split in effect for `model`: the stored choice, else its first tag family in use, else ISIC. */
export function resolveSplit(
  stored: string | undefined,
  families: TagFamily[],
  model: string | null
): string {
  if (stored) return stored
  const own = model ? families.filter((f) => f.databases.includes(model)) : []
  return own.length ? `tag:${own[0].name}` : 'isic'
}

/**
 * The families a picker offers: those in use in one of `dbs`, and what is already chosen (a name, or
 * `tag:<name>`, one or several) — a select whose value is not among its options shows blank, and a ticked
 * family without a checkbox cannot be unticked. Either looks like the setting was lost.
 */
export function familiesOffered(
  families: TagFamily[],
  dbs: Set<string>,
  chosen: string | string[]
): string[] {
  const names = families.filter((f) => f.databases.some((d) => dbs.has(d))).map((f) => f.name)
  const kept = [chosen].flat().map((c) => c.replace(/^tag:/, ''))
  return [...names, ...kept.filter((c, i) => c && !names.includes(c) && kept.indexOf(c) === i)]
}
