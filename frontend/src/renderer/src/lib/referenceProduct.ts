/**
 * The name a process's reference row shows: the product it makes, not the process itself.
 *
 * A Brightway production exchange points at its own activity, so the flow name the API sends for it is
 * the PROCESS name — the reference row read "market for electricity, low voltage" where it meant
 * "electricity, low voltage", and a process whose product field said "PET flakes" listed "Processing" as
 * its output. The row takes the reference product when the process has one; a production exchange that
 * points elsewhere (a separate product node) keeps its own name.
 */
export function asReferenceRow<E extends { input: { database: string; code: string; name: string | null } }>(
  ex: E,
  activity: { database: string; code: string; product?: string | null }
): E {
  const own = ex.input.database === activity.database && ex.input.code === activity.code
  const product = activity.product?.trim()
  return own && product ? { ...ex, input: { ...ex.input, name: product } } : ex
}
