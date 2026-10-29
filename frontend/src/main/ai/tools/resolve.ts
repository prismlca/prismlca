import type { ToolCtx } from './context'
import { S, cap } from './format'

/**
 * Resolve a foreground process from either a `code` or a `name`.
 *
 * Codes are 32 hex characters that mean nothing to a reader, and a model that has to carry dozens of
 * them through a long conversation eventually invents one — which then fails with "activity not found"
 * and no way forward. A name is checkable. Names are NOT unique though (nothing stops two processes
 * sharing one, and the same name per region is legitimate), so an ambiguous name is an error that
 * lists the candidates rather than a silent pick of the first match.
 */
export async function resolveCode(
  ctx: ToolCtx,
  database: string,
  a: { code?: string; name?: string; location?: string },
  /** What the *calling* tool names these two arguments. `edit_exchange` calls them `activity_code`
   *  and `activity_name`, and telling its caller to "pass either code or name" named two parameters
   *  that tool does not have — a model then retried with the words it was given and failed again. */
  fields: { code: string; name: string } = { code: 'code', name: 'name' }
): Promise<{ code: string } | { error: string }> {
  const code = typeof a.code === 'string' ? a.code.trim() : ''
  if (code) return { code }
  const wanted = typeof a.name === 'string' ? a.name.trim() : ''
  if (!wanted) return { error: `Pass either "${fields.code}" or "${fields.name}" to identify the process.` }

  let acts: Array<{ code: string; name: string; location?: string; product?: string }> = []
  try {
    acts = await ctx.api('GET', `/api/v1/model/activities/${encodeURIComponent(database)}`)
  } catch (e) {
    return { error: `Could not list "${database}": ${e instanceof Error ? e.message : String(e)}` }
  }
  const loc = typeof a.location === 'string' ? a.location.trim().toLowerCase() : ''
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim()
  let hits = (acts ?? []).filter((x) => norm(x.name ?? '') === norm(wanted))
  if (!hits.length) hits = (acts ?? []).filter((x) => norm(x.name ?? '').includes(norm(wanted)))
  if (loc) {
    const byLoc = hits.filter((x) => (x.location ?? '').toLowerCase() === loc)
    if (!byLoc.length && hits.length) {
      // A region the caller stated and nothing carries is a wrong target, not a filter to drop: the
      // French process was edited on a request that said "DE".
      return {
        error: S({
          error: `"${wanted}" exists in "${database}", but not with location "${a.location}".`,
          found_with_locations: cap(
            hits.map((x) => ({ code: x.code, name: x.name, location: x.location })),
            8
          ).items,
          hint: 'Pass the code of the one you mean, or drop "location".'
        })
      }
    }
    if (byLoc.length) hits = byLoc
  }
  if (hits.length === 1) return { code: hits[0].code }
  if (!hits.length) {
    const near = cap(
      (acts ?? [])
        .map((x) => ({ ...x, n: norm(x.name ?? '') }))
        .filter((x) =>
          norm(wanted)
            .split(' ')
            .some((w) => w.length > 3 && x.n.includes(w))
        )
        .map((x) => ({ code: x.code, name: x.name, location: x.location })),
      8
    )
    return {
      error: S({
        error: `No process named "${wanted}" in "${database}".`,
        did_you_mean: near.items,
        hint: 'Use list_activities to see the exact names.'
      })
    }
  }
  return {
    error: S({
      error: `"${wanted}" matches ${hits.length} processes in "${database}" — names are not unique.`,
      candidates: hits
        .slice(0, 10)
        .map((x) => ({ code: x.code, name: x.name, location: x.location, product: x.product })),
      hint: 'Pass "location" to disambiguate, or the exact "code".'
    })
  }
}
