/**
 * The refusal of deleting a parameter that something still uses, worded for the Parameters page.
 *
 * The backend's message is written for both readers, but its hint is the assistant's: it names the tool that
 * changes an exchange formula and shows a batch call that rewrites a parameter and deletes beside it. A person
 * changes those in the app — the formula on the Model page, the other parameter on this page, the override on
 * the Scenarios page. The backend sends what uses the parameter as data (`details.uses`), and this words the
 * way out from it.
 */
import { ApiError } from '../lib/api'

interface ParamUse {
  kind: string
  /** How a reader finds it: "parameter 'a'", "the amount of 'steel' in 'Bottle production'", "scenario 'High'". */
  label: string
  owner?: string | null
}

/** The uses a `param_in_use` refusal lists, or none when it lists nothing readable. */
export function paramUses(details: Record<string, unknown> | undefined): ParamUse[] {
  const list = details?.uses
  if (!Array.isArray(list)) return []
  return list.filter((u): u is ParamUse => !!u && typeof u.kind === 'string' && typeof u.label === 'string')
}

/** "a", "a and b", "a, b and c", then "a, b, … and 3 more" — the backend's own cut at six. */
function listed(items: string[], most = 6): string {
  const shown = items.length > most ? [...items.slice(0, most), `${items.length - most} more`] : items
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0]
}

/** The sentence for deleting `name` while `uses` still name it, or null when there are none to name. */
export function paramInUseMessage(name: string, uses: ParamUse[]): string | null {
  if (!uses.length) return null
  const of = (kind: string): ParamUse[] => uses.filter((u) => u.kind === kind)
  const ways: string[] = []
  const amounts = of('exchange').length
  if (amounts)
    ways.push(`change the formula of ${amounts === 1 ? 'that amount' : 'those amounts'} on the Model page`)
  const owners = of('parameter').map((u) => `'${u.owner ?? u.label}'`)
  if (owners.length) ways.push(`give ${listed(owners)} a value or formula without it on this page`)
  const scenarios = of('scenario').length
  if (scenarios)
    ways.push(
      `take the override out of ${scenarios === 1 ? 'that scenario' : 'those scenarios'} on the Scenarios page`
    )
  const first = listed(ways)
  return (
    `Not deleted: '${name}' is still used by ${listed(uses.map((u) => u.label))}. ` +
    `${first.charAt(0).toUpperCase()}${first.slice(1)} first, then delete it.`
  )
}

/** What a failed delete of `name` throws: the refusal worded for a person when something still uses the
 *  parameter, the error itself otherwise. */
export function deleteRefusal(name: string, e: unknown): unknown {
  const told =
    e instanceof ApiError && e.code === 'param_in_use' ? paramInUseMessage(name, paramUses(e.details)) : null
  return told ? new Error(told) : e
}
