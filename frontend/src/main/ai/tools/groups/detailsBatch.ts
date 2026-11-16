/**
 * How `get_process_details` answers a batch of codes (`codes`).
 *
 * Each code is settled on its own — one bad code must not take the other answers with it. But a batch in
 * which EVERY code failed is a failed call, not an `ok` one carrying a list of errors (V470): one run sent
 * its `database` key mangled four times, read "ok" each time and gave up, while the same slip in the
 * single-code path came back as an error naming the key the tool does not have. A whole failure therefore
 * throws, and the executor reports it like any failed call — with that same note on unknown keys. A partial
 * failure keeps its answers and carries the note itself.
 *
 * And a partial failure is counted, in front of the answers: `total`, `read`, `failed` and the codes that
 * were not read. The failed code used to be one entry among the datasets, each of them thousands of
 * characters long — a run read four of five, never noticed the fifth, and built without the dataset it had
 * meant to check. The counters use the names of the writing tools' batch answer, so the run's trace counts
 * the call as partly failed the same way.
 */
import { S } from '../format'

export type DetailsItem = { code: string; error?: string } & Record<string, unknown>

/** The batch answer, or a throw when no code could be read. `known` = the tool's parameter names. */
export function detailsBatch(results: DetailsItem[], args: Record<string, unknown>, known: string[]): string {
  const failed = results.filter((r) => typeof r.error === 'string')
  if (results.length && failed.length === results.length)
    throw new Error(
      `None of the ${results.length} codes could be read. ` +
        failed.map((r) => `${r.code}: ${r.error}`).join(' | ')
    )
  const stray = Object.keys(args).filter((k) => !known.includes(k))
  const read = results.length - failed.length
  return S({
    total: results.length,
    read,
    failed: failed.length,
    ...(failed.length
      ? {
          not_read: failed.map((r) => r.code),
          hint:
            `${read} of ${results.length} read — ${failed.length} could not be: ` +
            `${failed.map((r) => r.code).join(', ')}. Each has its reason in its entry under "results"; ` +
            'read it again with the corrected code before you rely on that dataset.' +
            (stray.length
              ? ` This tool has no ${stray.map((k) => `"${k}"`).join(', ')} — it takes ` +
                `${known.map((k) => `"${k}"`).join(', ')}.`
              : '')
        }
      : {}),
    results
  })
}
